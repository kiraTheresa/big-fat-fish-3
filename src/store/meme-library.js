// Session-scoped catalogue. Original assets remain immutable; labels and usage live here.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteJson, readJson, withStorageLock } from '../platform/persistence.js';
import { mediaPaths, readMeme, saveMeme } from './media-store.js';

const MAX_PER_SESSION = 500;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validScope = (value) => typeof value === 'string' && /^[gp]-[A-Za-z0-9_-]{1,64}$/.test(value);
const types = new Set(['image', 'mface', 'face']);
const idPresent = (value) => (typeof value === 'string' && value.trim() !== '') || (Number.isSafeInteger(value) && value >= 0);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const file = () => join(mediaPaths().root, 'meme-library.json');
const fail = (message, code) => Object.assign(new Error(message), { code });

function checkScope(sessionKey) {
  if (!validScope(sessionKey)) throw fail('无效的表情会话范围', 'MEME_SCOPE_INVALID');
}
function labels(name, tags) {
  if (typeof name !== 'string' || name.length > 1000 || !Array.isArray(tags) || tags.length > 30
    || tags.some((tag) => typeof tag !== 'string' || tag.length > 80)) throw fail('表情名称或标签格式不正确', 'MEME_LABEL_INVALID');
  return { name: name.trim(), tags: [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))] };
}
function validateIndex(index) {
  if (!object(index) || index.version !== 1 || !object(index.sessions)) throw fail('表情目录损坏，未覆盖原文件', 'MEME_INDEX_INVALID');
  for (const [scope, entries] of Object.entries(index.sessions)) {
    if (!validScope(scope) || !Array.isArray(entries) || entries.length > MAX_PER_SESSION) throw fail('表情目录损坏，未覆盖原文件', 'MEME_INDEX_INVALID');
    const ids = new Set();
    for (const entry of entries) {
      if (!object(entry) || !uuid.test(entry.id) || ids.has(entry.id) || !types.has(entry.type)
        || typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(entry.fingerprint)
        || typeof entry.enabled !== 'boolean' || !Number.isFinite(entry.createdAt)
        || !Number.isSafeInteger(entry.usedCount) || entry.usedCount < 0
        || !Number.isSafeInteger(entry.failureCount) || entry.failureCount < 0
        || (entry.lastUsedAt !== null && !Number.isFinite(entry.lastUsedAt))) throw fail('表情目录损坏，未覆盖原文件', 'MEME_INDEX_INVALID');
      try { labels(entry.name, entry.tags); } catch { throw fail('表情目录损坏，未覆盖原文件', 'MEME_INDEX_INVALID'); }
      ids.add(entry.id);
    }
  }
  return index;
}
async function transaction(sessionKey, action) {
  checkScope(sessionKey);
  const path = file();
  return withStorageLock(`${path}.transaction`, async () => {
    const index = validateIndex(await readJson(path, { version: 1, sessions: {} }));
    return action(index, path);
  });
}

function fingerprint(input) {
  let identity;
  if (input.type === 'image' && Buffer.isBuffer(input.image)) {
    identity = ['image', createHash('sha256').update(input.image).digest('hex')];
  } else if (input.type === 'mface') {
    // Rotateable keys and display labels are not the identity of a native sticker.
    identity = ['mface', String(input.data?.emoji_package_id ?? ''), String(input.data?.emoji_id ?? '')];
  } else if (input.type === 'face') {
    identity = ['face', String(input.data?.id ?? ''), String(input.data?.resultId ?? ''), String(input.data?.chainCount ?? '')];
  } else identity = ['image-reference', input.data?.file ?? '', input.data?.url ?? ''];
  // Incomplete entries still need distinct identities rather than all collapsing into one.
  if (identity.slice(1).every((part) => !part)) identity.push(input.name, JSON.stringify(input.data ?? {}));
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
const publicEntry = (entry) => ({ id: entry.id, name: entry.name, tags: [...entry.tags], type: entry.type,
  enabled: entry.enabled, usedCount: entry.usedCount, lastUsedAt: entry.lastUsedAt });
const applyLabels = (asset, entry) => ({ ...asset, name: entry.name, tags: [...entry.tags] });

export function collectMeme(sessionKey, { type, data = {}, image = null, preview = null, name = '', tags = [], source = null } = {}) {
  const text = labels(name, tags);
  if (!types.has(type)) throw fail('表情类型仅支持 image、mface、face', 'MEME_TYPE_INVALID');
  if ((image !== null && !Buffer.isBuffer(image)) || (preview !== null && !Buffer.isBuffer(preview))) throw fail('表情原图和预览必须是 Buffer', 'MEME_IMAGE_INVALID');
  // Snapshot input before waiting for another catalogue mutation.
  const input = { type, data: structuredClone(data), image: image === null ? null : Buffer.from(image),
    preview: preview === null ? null : Buffer.from(preview), ...text, source: structuredClone(source) };
  const hash = fingerprint(input);
  return transaction(sessionKey, async (index, path) => {
    const entries = index.sessions[sessionKey] ?? [];
    const existing = entries.find((entry) => entry.fingerprint === hash);
    if (existing) {
      let asset;
      try { asset = await readMeme(existing.id); } catch { asset = null; }
      // A fresh received native reference may complete an earlier partial one or
      // rotate its key. Publish a new immutable asset, then switch this scope's index.
      const completeNative = type === 'mface' && idPresent(input.data?.emoji_id) && idPresent(input.data?.emoji_package_id)
        && typeof input.data?.key === 'string' && input.data.key.trim() !== '';
      const completeInput = completeNative || (type === 'face' && idPresent(input.data?.id))
        || (type === 'image' && Buffer.isBuffer(input.image) && input.image.length > 0);
      // Broken originals are repairable by an explicit complete recollection. A
      // thumbnail or incomplete reference must not replace the recoverable index.
      if (!asset && !completeInput) throw fail('已收藏表情的文件损坏或缺失，请重新提供完整表情', 'MEME_ASSET_MISSING');
      const refreshed = !asset || (completeNative && (asset.missingParameters.length > 0 || input.data.key !== asset.send.data.key));
      if (refreshed) {
        asset = await saveMeme(input);
        existing.id = asset.id;
      }
      // Recollecting adds vocabulary but does not silently re-enable a disabled meme.
      existing.tags = [...new Set([...existing.tags, ...input.tags])].slice(0, 30);
      if (!existing.name && input.name) existing.name = input.name;
      await atomicWriteJson(path, index);
      return { asset: applyLabels(asset, existing), duplicate: true, refreshed };
    }
    if (entries.length >= MAX_PER_SESSION) throw fail('本会话表情收藏已达 500 个上限', 'MEME_LIBRARY_FULL');
    const asset = await saveMeme(input);
    const entry = { id: asset.id, fingerprint: hash, type, name: input.name || `${type} 表情`, tags: input.tags,
      enabled: true, createdAt: Date.now(), usedCount: 0, failureCount: 0, lastUsedAt: null, lastFailureAt: null, lastErrorCode: null };
    index.sessions[sessionKey] = [...entries, entry];
    await atomicWriteJson(path, index);
    return { asset: applyLabels(asset, entry), duplicate: false };
  });
}

async function usableAsset(entry) {
  if (!entry.enabled) throw fail('这个表情已停用', 'MEME_DISABLED');
  const asset = await readMeme(entry.id);
  if (!asset) throw fail('表情文件不存在', 'MEME_ASSET_MISSING');
  if (asset.missingParameters.length) throw fail('表情发送参数不完整', 'MEME_INCOMPLETE');
  // A remote-only image reference is not a durable downloaded original for sending.
  if (asset.memeType === 'image' && !asset.path) throw fail('表情原图尚未保存', 'MEME_IMAGE_MISSING');
  return applyLabels(asset, entry);
}

const normalize = (text) => text.normalize('NFKC').toLocaleLowerCase().trim();
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
function words(text) {
  return [...new Set([...segmenter.segment(text)].filter((part) => part.isWordLike).map((part) => part.segment))];
}
function relevance(entry, query) {
  if (!query) return 1;
  const name = normalize(entry.name);
  const tags = entry.tags.map(normalize);
  if (query === entry.id) return 1000;
  if (name === query) return 1000;
  let score = tags.includes(query) ? 800 : name.includes(query) ? 600 : 0;
  const document = `${name} ${tags.join(' ')}`;
  for (const term of words(query)) {
    if (term.length === 1 && query.length > 1) continue;
    if (document.includes(term)) score += 30 + term.length;
  }
  // Chinese compounds are not always segmented the same way in a name and a query.
  for (const han of query.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let i = 0; i < han.length - 1; i++) if (document.includes(han.slice(i, i + 2))) score += 4;
  }
  return score;
}

export async function searchMemes(sessionKey, query = '', { limit = 5, includeUnavailable = false } = {}) {
  if (typeof query !== 'string' || query.length > 1000 || !Number.isInteger(limit) || limit < 1
    || typeof includeUnavailable !== 'boolean') throw fail('表情查询格式不正确', 'MEME_QUERY_INVALID');
  const normalized = normalize(query);
  const text = normalized === '全部' ? '' : normalized;
  return transaction(sessionKey, async (index) => {
    const now = Date.now();
    const ranked = (index.sessions[sessionKey] ?? []).filter((entry) => includeUnavailable || entry.enabled)
      .map((entry) => ({ entry, score: relevance(entry, text) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => {
        const adjusted = ({ entry, score }) => score - (text && entry.lastUsedAt && now - entry.lastUsedAt < 600000 ? 15 : 0);
        return adjusted(b) - adjusted(a) || b.entry.createdAt - a.entry.createdAt || a.entry.id.localeCompare(b.entry.id);
      });
    const result = [];
    for (const { entry } of ranked) {
      let available = false;
      let missingParameters = [];
      try {
        const asset = await readMeme(entry.id);
        if (!asset) missingParameters = ['asset'];
        else {
          missingParameters = [...asset.missingParameters];
          if (asset.memeType === 'image' && !asset.path && !missingParameters.includes('file')) missingParameters.push('file');
          available = entry.enabled && missingParameters.length === 0;
        }
      } catch { missingParameters = ['asset']; } // One broken asset must not hide the rest of the catalogue.
      if (!includeUnavailable && !available) continue;
      result.push({ ...publicEntry(entry), available, missingParameters });
      if (result.length >= Math.min(limit, 20)) break;
    }
    return result;
  });
}

export async function getScopedMeme(sessionKey, id) {
  return transaction(sessionKey, async (index) => {
    const entry = (index.sessions[sessionKey] ?? []).find((item) => item.id === id);
    if (!entry) throw fail('当前会话没有这个表情', 'MEME_NOT_FOUND');
    return usableAsset(entry);
  });
}

export async function recordMemeUse(sessionKey, id, { ok = true, errorCode } = {}) {
  if (typeof ok !== 'boolean') throw fail('表情使用结果无效', 'MEME_USAGE_INVALID');
  return transaction(sessionKey, async (index, path) => {
    const entry = (index.sessions[sessionKey] ?? []).find((item) => item.id === id);
    if (!entry) throw fail('当前会话没有这个表情', 'MEME_NOT_FOUND');
    if (ok) { entry.usedCount++; entry.lastUsedAt = Date.now(); entry.lastErrorCode = null; }
    else {
      entry.failureCount++;
      entry.lastFailureAt = Date.now();
      entry.lastErrorCode = typeof errorCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(errorCode) ? errorCode : 'SEND_FAILED';
    }
    await atomicWriteJson(path, index);
    return publicEntry(entry);
  });
}

export async function updateMeme(sessionKey, id, patch) {
  if (!object(patch) || Object.keys(patch).some((key) => !['name', 'tags', 'enabled'].includes(key))
    || ('enabled' in patch && typeof patch.enabled !== 'boolean')) throw fail('表情修改格式不正确', 'MEME_UPDATE_INVALID');
  const snapshot = structuredClone(patch);
  return transaction(sessionKey, async (index, path) => {
    const entry = (index.sessions[sessionKey] ?? []).find((item) => item.id === id);
    if (!entry) throw fail('当前会话没有这个表情', 'MEME_NOT_FOUND');
    const text = labels(snapshot.name ?? entry.name, snapshot.tags ?? entry.tags);
    Object.assign(entry, text, 'enabled' in snapshot ? { enabled: snapshot.enabled } : {});
    await atomicWriteJson(path, index);
    return publicEntry(entry);
  });
}
