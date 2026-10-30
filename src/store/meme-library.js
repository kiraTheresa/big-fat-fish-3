// Shared catalogue. Sessions record where a meme was collected, not who may use it.
// Original assets remain immutable; labels and usage live here.
import { createHash, randomUUID } from 'node:crypto';
import { link, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, atomicWriteJson, withStorageLock } from '../platform/persistence.js';
import { mediaPaths, readMeme, saveMeme } from './media-store.js';

const MAX_SHARED_MEMES = 5000;
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
function labels(name, tags, maxTags = 30) {
  if (typeof name !== 'string' || name.length > 1000 || !Array.isArray(tags) || tags.length > maxTags
    || tags.some((tag) => typeof tag !== 'string' || tag.length > 80)) throw fail('表情名称或标签格式不正确', 'MEME_LABEL_INVALID');
  return { name: name.trim(), tags: [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))] };
}
const invalidIndex = () => fail('表情目录损坏，未覆盖原文件', 'MEME_INDEX_INVALID');
function validateEntries(entries, { legacy = false } = {}) {
  if (!Array.isArray(entries) || (legacy && entries.length > 500)) throw invalidIndex();
  const ids = new Set();
  for (const entry of entries) {
    if (!object(entry) || typeof entry.id !== 'string' || !uuid.test(entry.id) || ids.has(entry.id) || !types.has(entry.type)
      || typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(entry.fingerprint)
      || typeof entry.enabled !== 'boolean' || !Number.isFinite(entry.createdAt)
      || !Number.isSafeInteger(entry.usedCount) || entry.usedCount < 0
      || !Number.isSafeInteger(entry.failureCount) || entry.failureCount < 0
      || (entry.lastUsedAt !== null && !Number.isFinite(entry.lastUsedAt))
      || (entry.lastFailureAt != null && !Number.isFinite(entry.lastFailureAt))
      || (entry.lastErrorCode != null && (typeof entry.lastErrorCode !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(entry.lastErrorCode)))) throw invalidIndex();
    // A migration may merge more than 30 existing tags; never discard old vocabulary.
    try { labels(entry.name, entry.tags, legacy ? 30 : Infinity); } catch { throw invalidIndex(); }
    if (!legacy && (!Array.isArray(entry.sourceSessions) || !entry.sourceSessions.length
      || entry.sourceSessions.some((scope) => !validScope(scope))
      || new Set(entry.sourceSessions).size !== entry.sourceSessions.length)) throw invalidIndex();
    ids.add(entry.id);
  }
}
function validateIndex(index) {
  if (!object(index)) throw invalidIndex();
  if (index.version === 2) validateEntries(index.entries);
  else if (index.version === 1 && object(index.sessions)) {
    for (const [scope, entries] of Object.entries(index.sessions)) {
      if (!validScope(scope)) throw invalidIndex();
      validateEntries(entries, { legacy: true });
    }
  } else throw invalidIndex();
  return index;
}
function sharedIndex(legacy) {
  const byId = new Map();
  for (const scope of Object.keys(legacy.sessions).sort()) {
    for (const entry of legacy.sessions[scope]) {
      const existing = byId.get(entry.id);
      if (!existing) { byId.set(entry.id, { ...entry, tags: [...entry.tags], sourceSessions: [scope] }); continue; }
      if (existing.type !== entry.type || existing.fingerprint !== entry.fingerprint) throw invalidIndex();
      existing.sourceSessions.push(scope);
      existing.tags = [...new Set([...existing.tags, ...entry.tags])];
      if (!existing.name.trim() && entry.name.trim()) existing.name = entry.name;
      existing.enabled = existing.enabled && entry.enabled;
      existing.createdAt = Math.min(existing.createdAt, entry.createdAt);
      existing.usedCount += entry.usedCount;
      existing.failureCount += entry.failureCount;
      existing.lastUsedAt = Math.max(existing.lastUsedAt ?? 0, entry.lastUsedAt ?? 0) || null;
      if ((entry.lastFailureAt ?? -1) > (existing.lastFailureAt ?? -1)) {
        existing.lastFailureAt = entry.lastFailureAt;
        existing.lastErrorCode = entry.lastErrorCode ?? null;
      }
    }
  }
  return validateIndex({ version: 2, entries: [...byId.values()] });
}
async function backupLegacy(path, raw) {
  const backup = join(mediaPaths().root, 'meme-library.v1.backup.json');
  const staged = `${backup}.${randomUUID()}.tmp`;
  try {
    await atomicWriteFile(staged, raw);
    try { await link(staged, backup); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A prior interrupted attempt can reuse its exact backup, never overwrite it.
      if (await readFile(backup, 'utf8') !== raw) throw fail('旧表情目录与已有备份不一致，未覆盖原文件', 'MEME_BACKUP_CONFLICT');
    }
  } finally { await unlink(staged).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}
async function loadIndex(path) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { version: 2, entries: [] }; throw error; }
  let index;
  try { index = validateIndex(JSON.parse(raw)); }
  catch (error) { if (error instanceof SyntaxError) throw invalidIndex(); throw error; }
  if (index.version === 2) return index;
  const migrated = sharedIndex(index);
  await backupLegacy(path, raw);
  await atomicWriteJson(path, migrated);
  return migrated;
}
export function initializeMemeLibrary() {
  const path = file();
  return withStorageLock(`${path}.transaction`, async () => {
    const index = await loadIndex(path);
    // Do not rewrite an already initialized catalogue (including repeated startup).
    try { await readFile(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await atomicWriteJson(path, index); }
    return { version: index.version, total: index.entries.length };
  });
}
async function transaction(sessionKey, action) {
  checkScope(sessionKey);
  const path = file();
  return withStorageLock(`${path}.transaction`, async () => {
    const index = await loadIndex(path);
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
    const entries = index.entries;
    const existing = entries.find((entry) => entry.fingerprint === hash);
    if (existing) {
      let asset;
      try { asset = await readMeme(existing.id); } catch { asset = null; }
      // A fresh received native reference may complete an earlier partial one or
      // rotate its key. Publish a new immutable asset, then update the shared index.
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
      existing.tags = [...new Set([...existing.tags, ...input.tags])];
      existing.sourceSessions = [...new Set([...existing.sourceSessions, sessionKey])];
      if (!existing.name && input.name) existing.name = input.name;
      await atomicWriteJson(path, index);
      return { asset: applyLabels(asset, existing), duplicate: true, refreshed };
    }
    if (entries.length >= MAX_SHARED_MEMES) throw fail('共享表情收藏已达 5000 个上限', 'MEME_LIBRARY_FULL');
    const asset = await saveMeme(input);
    const entry = { id: asset.id, fingerprint: hash, type, name: input.name || `${type} 表情`, tags: input.tags,
      enabled: true, createdAt: Date.now(), usedCount: 0, failureCount: 0, lastUsedAt: null, lastFailureAt: null, lastErrorCode: null,
      sourceSessions: [sessionKey] };
    entries.push(entry);
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
    const ranked = index.entries.filter((entry) => includeUnavailable || entry.enabled)
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

export async function getSharedMeme(sessionKey, id) {
  return transaction(sessionKey, async (index) => {
    const entry = index.entries.find((item) => item.id === id);
    if (!entry) throw fail('共享收藏中没有这个表情', 'MEME_NOT_FOUND');
    return usableAsset(entry);
  });
}
// Compatibility for callers migrating from the former session-scoped catalogue.
export const getScopedMeme = getSharedMeme;

export async function recordMemeUse(sessionKey, id, { ok = true, errorCode } = {}) {
  if (typeof ok !== 'boolean') throw fail('表情使用结果无效', 'MEME_USAGE_INVALID');
  return transaction(sessionKey, async (index, path) => {
    const entry = index.entries.find((item) => item.id === id);
    if (!entry) throw fail('共享收藏中没有这个表情', 'MEME_NOT_FOUND');
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
    const entry = index.entries.find((item) => item.id === id);
    if (!entry) throw fail('共享收藏中没有这个表情', 'MEME_NOT_FOUND');
    const text = labels(snapshot.name ?? entry.name, snapshot.tags ?? entry.tags, 'tags' in snapshot ? 30 : Infinity);
    Object.assign(entry, text, 'enabled' in snapshot ? { enabled: snapshot.enabled } : {});
    await atomicWriteJson(path, index);
    return publicEntry(entry);
  });
}
