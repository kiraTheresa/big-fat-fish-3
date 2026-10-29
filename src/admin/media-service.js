// Read-only catalogue and authenticated-image backing service. Never replay native keys.
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { mediaPaths } from '../store/media-store.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuid = new RegExp(`^${UUID}$`);
const keyPattern = new RegExp(`^(generated/\\d{4}-\\d{2}-\\d{2}/${UUID}|memes/${UUID})$`);
const scopePattern = /^[gp]-[A-Za-z0-9_-]{1,64}$/;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (value, max = 1000) => typeof value === 'string' ? value.slice(0, max) : '';
const identifier = (value) => (typeof value === 'string' && value.trim() !== '') || (Number.isSafeInteger(value) && value >= 0);
const tagsOf = (value) => Array.isArray(value) ? value.filter((tag) => typeof tag === 'string').map((tag) => tag.slice(0, 80)) : [];

function mimeOf(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function checkedPath(root, parts, finalType = 'file') {
  let path = root;
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw error('媒体资源不可用', 404);
  const rootReal = await realpath(root);
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]);
    const info = await lstat(path);
    const isDirectory = index < parts.length - 1 || finalType === 'directory';
    if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile())) throw error('媒体资源不可用', 404);
  }
  const result = await realpath(path);
  const rel = relative(rootReal, result);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw error('媒体资源不可用', 404);
  return path;
}

async function readJson(root, parts, limit = 1024 * 1024) {
  const path = await checkedPath(root, parts);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw error('媒体元数据过大或不可用', 500);
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

async function readRecord(root, key) {
  const record = await readJson(root, [...key.split('/'), 'metadata.json']);
  const [kind] = key.split('/');
  if (!object(record) || record.id !== key.split('/').at(-1) || record.kind !== kind
    || (kind === 'generated' ? record.version !== 1 : ![1, 2].includes(record.version))
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
    throw error('媒体元数据格式不正确', 500);
  }
  return record;
}

async function imageFile(root, key, record, variant, includeBytes = false) {
  const filename = variant === 'preview' ? record.preview?.filename : record.filename;
  const prefix = variant === 'preview' ? 'preview' : 'image';
  if (typeof filename !== 'string' || !new RegExp(`^${prefix}\\.(png|jpg|gif|webp)$`).test(filename)) throw error('没有可预览的本地图片', 404);
  const path = await checkedPath(root, [...key.split('/'), filename]);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) throw error('图片为空或超过 64 MB', 413);
    const header = Buffer.alloc(12);
    const result = await handle.read(header, 0, header.length, 0);
    const mimeType = mimeOf(header.subarray(0, result.bytesRead));
    if (!mimeType) throw error('图片格式不支持预览', 415);
    const bytes = includeBytes ? await handle.readFile() : undefined;
    if (bytes && bytes.length > MAX_IMAGE_BYTES) throw error('图片超过 64 MB', 413);
    return { filename, mimeType, size: info.size, ...(includeBytes ? { bytes } : {}) };
  } finally { await handle.close(); }
}

async function library(root) {
  let saved;
  try { saved = await readJson(root, ['meme-library.json'], 20 * 1024 * 1024); }
  catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw error('表情收藏索引损坏或不可读取，请检查本机存储', 500);
  }
  if (!object(saved) || ![1, 2].includes(saved.version)) throw error('表情收藏索引格式不正确', 500);
  const byId = new Map();
  const checkEntry = (entry, seen) => {
    if (!object(entry) || !uuid.test(entry.id) || seen.has(entry.id) || !['image', 'mface', 'face'].includes(entry.type)
      || typeof entry.name !== 'string' || typeof entry.enabled !== 'boolean' || !Array.isArray(entry.tags)
      || entry.tags.some((tag) => typeof tag !== 'string') || !Number.isSafeInteger(entry.usedCount) || entry.usedCount < 0
      || (entry.lastUsedAt !== null && !Number.isFinite(entry.lastUsedAt))) throw error('表情收藏索引格式不正确', 500);
    seen.add(entry.id);
  };
  if (saved.version === 2) {
    if (!Array.isArray(saved.entries)) throw error('表情收藏索引格式不正确', 500);
    const seen = new Set();
    for (const entry of saved.entries) {
      checkEntry(entry, seen);
      if (!Array.isArray(entry.sourceSessions) || entry.sourceSessions.some((session) => typeof session !== 'string' || !scopePattern.test(session))) {
        throw error('表情收藏来源格式不正确', 500);
      }
      byId.set(entry.id, entry);
    }
  } else {
    if (!object(saved.sessions)) throw error('表情收藏索引格式不正确', 500);
    // Old indexes remain readable before startup migration. Source filtering never
    // chooses a different label or state for the same asset.
    for (const [sessionKey, entries] of Object.entries(saved.sessions).sort(([a], [b]) => a.localeCompare(b))) {
      if (!scopePattern.test(sessionKey) || !Array.isArray(entries) || entries.length > 500) throw error('表情收藏索引格式不正确', 500);
      const seen = new Set();
      for (const entry of entries) {
        checkEntry(entry, seen);
        const previous = byId.get(entry.id);
        if (!previous) byId.set(entry.id, { ...entry, sourceSessions: [sessionKey] });
        else {
          if (previous.type !== entry.type || previous.fingerprint !== entry.fingerprint) throw error('表情收藏索引格式不正确', 500);
          previous.sourceSessions.push(sessionKey);
          if (!previous.name.trim()) previous.name = entry.name;
          previous.tags = [...new Set([...previous.tags, ...entry.tags])];
          previous.enabled = previous.enabled && entry.enabled;
          previous.usedCount += entry.usedCount;
          if (!Number.isSafeInteger(previous.usedCount)) throw error('表情收藏索引格式不正确', 500);
          previous.lastUsedAt = previous.lastUsedAt === null ? entry.lastUsedAt : entry.lastUsedAt === null ? previous.lastUsedAt : Math.max(previous.lastUsedAt, entry.lastUsedAt);
        }
      }
    }
  }
  return byId;
}

async function directoryEntries(root, parts) {
  try { return await readdir(await checkedPath(root, parts, 'directory'), { withFileTypes: true }); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}

function queryOptions(query) {
  if (!object(query)) throw error('媒体查询格式不正确');
  const kind = query.kind ?? 'generated';
  const q = query.q ?? '';
  const sessionKey = query.sessionKey ?? '';
  const status = query.status ?? '';
  if (!['generated', 'memes'].includes(kind) || typeof q !== 'string' || q.length > 300
    || typeof sessionKey !== 'string' || (sessionKey && !scopePattern.test(sessionKey))
    || !['', 'available', 'disabled', 'incomplete', 'uncollected'].includes(status)) throw error('媒体筛选条件不正确');
  const integer = (value, fallback, max) => {
    if (value === undefined) return fallback;
    if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) throw error('分页参数不正确');
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > max) throw error('分页参数超出范围');
    return number;
  };
  const limit = integer(query.limit, 24, 48);
  if (limit < 1) throw error('每页数量需为 1–48');
  return { kind, q: q.trim().toLocaleLowerCase(), sessionKey, status, offset: integer(query.offset, 0, Number.MAX_SAFE_INTEGER), limit };
}

async function list(query = {}) {
  const filter = queryOptions(query);
  const root = mediaPaths().root;
  const index = await library(root);
  const keys = [];
  let warnings = 0;
  for (const day of await directoryEntries(root, ['generated'])) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
    if (!day.isDirectory()) { warnings++; continue; }
    for (const entry of await directoryEntries(root, ['generated', day.name])) {
      if (!uuid.test(entry.name)) continue;
      if (entry.isDirectory()) keys.push(`generated/${day.name}/${entry.name}`); else warnings++;
    }
  }
  for (const entry of await directoryEntries(root, ['memes'])) {
    if (!uuid.test(entry.name)) continue;
    if (entry.isDirectory()) keys.push(`memes/${entry.name}`); else warnings++;
  }
  const items = [];
  for (const key of keys) {
    try {
      const record = await readRecord(root, key);
      const kind = record.kind;
      const entry = index.get(record.id);
      const original = await imageFile(root, key, record, 'original').catch(() => null);
      const preview = record.preview ? await imageFile(root, key, record, 'preview').catch(() => null) : null;
      const sessions = kind === 'generated' ? [record.sessionKey].filter((value) => typeof value === 'string' && scopePattern.test(value))
        : entry ? entry.sourceSessions : [record.source?.sessionKey].filter((value) => typeof value === 'string' && scopePattern.test(value));
      const memeType = record.version === 1 ? 'image' : record.memeType;
      if (kind === 'memes' && (!['image', 'mface', 'face'].includes(memeType)
        || (record.version === 2 && (!object(record.send?.data) || record.send.type !== memeType)))) throw error('表情类型损坏', 500);
      const data = record.send?.data ?? {};
      const missingParameters = kind === 'generated' || memeType === 'image' ? original ? [] : ['file']
        : memeType === 'face' ? identifier(data.id) ? [] : ['id']
          : ['emoji_id', 'emoji_package_id', 'key'].filter((field) => field === 'key' ? !text(data.key).trim() : !identifier(data[field]));
      const status = kind === 'generated' ? original ? 'available' : 'incomplete'
        : !entry ? 'uncollected' : !entry.enabled ? 'disabled' : missingParameters.length ? 'incomplete' : 'available';
      if ((record.filename && !original) || (record.preview && !preview)) warnings++;
      const item = { key, id: record.id, kind,
        name: kind === 'generated' ? text(record.prompt, 160) || '未命名绘图' : text(entry?.name ?? record.name) || '未命名表情',
        createdAt: record.createdAt, mimeType: original?.mimeType ?? null, bytes: original?.size ?? 0,
        sessions: [...new Set(sessions)], ...(sessions.length === 1 ? { sessionKey: sessions[0] } : {}), status,
        previewVariant: preview ? 'preview' : original ? 'original' : null, originalAvailable: !!original,
        tags: kind === 'memes' ? tagsOf(entry?.tags ?? record.tags) : [], missingParameters,
        ...(kind === 'generated' ? { prompt: text(record.prompt, 12000), model: text(record.model, 160), size: text(record.size, 80) }
          : { memeType, usedCount: entry?.usedCount ?? 0, lastUsedAt: entry?.lastUsedAt ?? null }),
      };
      items.push(item);
    } catch { warnings++; } // A broken asset does not hide the rest of the gallery.
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key));
  const counts = { generated: items.filter((item) => item.kind === 'generated').length, memes: items.filter((item) => item.kind === 'memes').length };
  const sessions = [...new Set(items.flatMap((item) => item.sessions))].sort();
  const filtered = items.filter((item) => item.kind === filter.kind && (!filter.sessionKey || item.sessions.includes(filter.sessionKey))
    && (!filter.status || item.status === filter.status)
    && (!filter.q || [item.name, item.prompt, item.model, ...item.tags].filter(Boolean).join(' ').toLocaleLowerCase().includes(filter.q)));
  const end = filter.offset + filter.limit;
  return { items: filtered.slice(filter.offset, end), total: filtered.length, nextOffset: end < filtered.length ? end : null, counts, sessions, warnings };
}

async function readFile({ key, variant = 'original' } = {}) {
  if (typeof key !== 'string' || !keyPattern.test(key) || !['original', 'preview'].includes(variant)) throw error('媒体资源标识不正确');
  try {
    const root = mediaPaths().root;
    const record = await readRecord(root, key);
    const { bytes, mimeType, filename } = await imageFile(root, key, record, variant, true);
    return { bytes, mimeType, filename };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ELOOP' || err.code === 'ENOTDIR') throw error('媒体资源不存在', 404);
    if (err.status) throw err;
    throw error('媒体资源不可读取', 500);
  }
}

export function createMediaService() { return { list, readFile }; }
