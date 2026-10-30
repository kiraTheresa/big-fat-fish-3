// Local originals and metadata. Publish each complete asset with a directory rename.
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFile, atomicWriteJson, withStorageLock } from '../platform/persistence.js';

export function mediaPaths() {
  const root = resolve(config.dataDir, 'media');
  return { root, generated: join(root, 'generated'), memes: join(root, 'memes') };
}

export async function initializeMediaStore() {
  const paths = mediaPaths();
  await Promise.all([mkdir(paths.generated, { recursive: true }), mkdir(paths.memes, { recursive: true })]);
  return paths;
}

function imageFormat(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['png', 'image/png'];
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ['jpg', 'image/jpeg'];
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return ['gif', 'image/gif'];
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return ['webp', 'image/webp'];
  // Keep unrecognized generated payloads without pretending they are PNGs.
  return ['bin', 'application/octet-stream'];
}

function describeImage(bytes, prefix, allowUnknown = false) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('媒体内容必须是非空 Buffer');
  const [extension, mimeType] = imageFormat(bytes);
  if (!allowUnknown && extension === 'bin') throw new Error('表情包仅支持 PNG、JPEG、GIF、WebP');
  return { filename: `${prefix}.${extension}`, mimeType, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}

function assetReference(root, directory, record) {
  const pathOf = (filename) => filename ? relative(root, join(directory, filename)).split('\\').join('/') : null;
  return { ...record, path: pathOf(record.filename),
    ...(record.preview ? { preview: { ...record.preview, path: pathOf(record.preview.filename) } } : {}) };
}

async function saveAsset(kind, bytes, details, previewBytes = null) {
  // Snapshot buffers before awaiting disk IO, so callers cannot mutate an asset mid-write.
  const original = bytes === null ? null : describeImage(bytes, 'image', kind === 'generated');
  const preview = previewBytes === null ? null : describeImage(previewBytes, 'preview');
  bytes = bytes === null ? null : Buffer.from(bytes);
  previewBytes = previewBytes === null ? null : Buffer.from(previewBytes);
  const paths = mediaPaths();
  const createdAt = new Date().toISOString();
  const id = randomUUID();
  const parent = kind === 'generated' ? join(paths.generated, createdAt.slice(0, 10)) : paths.memes;
  const directory = join(parent, id);
  const staging = join(parent, `.${id}.tmp`);
  const record = {
    version: 1, id, kind, createdAt,
    ...(original ?? { filename: null, mimeType: null, bytes: 0, sha256: null }),
    ...details, ...(kind === 'memes' ? { preview } : {}),
  };
  return withStorageLock(directory, async () => {
    await mkdir(parent, { recursive: true });
    await mkdir(staging, { mode: 0o700 });
    try {
      if (original) await atomicWriteFile(join(staging, original.filename), bytes);
      if (preview) await atomicWriteFile(join(staging, preview.filename), previewBytes);
      await atomicWriteJson(join(staging, 'metadata.json'), record);
      await rename(staging, directory);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    // Relative references survive moving the data directory or Docker mounts.
    return assetReference(paths.root, directory, record);
  });
}

export function saveGeneratedImage(b64, { prompt, sessionKey, model, size } = {}) {
  if (typeof b64 !== 'string' || !b64.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1) {
    throw new Error('生成图片不是有效的 Base64');
  }
  return saveAsset('generated', Buffer.from(b64, 'base64'), { prompt, sessionKey, model, size });
}

// Reject values JSON would silently drop/change. Extension fields remain plain data.
function snapshotJsonObject(value) {
  const ancestors = new Set();
  function validate(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || ancestors.has(item)
      || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) {
      throw new Error('发送参数和来源必须是可无损保存的 JSON 数据');
    }
    ancestors.add(item);
    for (const child of Object.values(item)) validate(child);
    ancestors.delete(item);
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('发送参数和来源必须是 JSON 对象');
  validate(value);
  return JSON.parse(JSON.stringify(value));
}

const hasIdentifier = (value) => (typeof value === 'string' && value.trim() !== '')
  || (Number.isSafeInteger(value) && value >= 0);
const hasText = (value) => typeof value === 'string' && value.trim() !== '';

function missingParameters(type, data, hasOriginal) {
  if (type === 'face') return hasIdentifier(data.id) ? [] : ['id'];
  if (type === 'mface') return ['emoji_id', 'emoji_package_id', 'key'].filter((key) =>
    key === 'key' ? !hasText(data[key]) : !hasIdentifier(data[key]));
  return hasOriginal || hasText(data.file) ? [] : ['file'];
}

// No download or send occurs here. Native QQ references need no local image.
export function saveMeme({ type, data = {}, image = null, preview = null, name = '', tags = [], source = null } = {}) {
  if (!['image', 'mface', 'face'].includes(type)) throw new Error('表情类型仅支持 image、mface、face');
  if (typeof name !== 'string' || !Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new Error('表情包名称必须是字符串，标签必须是字符串数组');
  }
  const send = { type, data: snapshotJsonObject(data) };
  return saveAsset('memes', image, {
    version: 2, name, tags: [...new Set(tags)], memeType: type, send,
    source: source === null ? null : snapshotJsonObject(source),
    missingParameters: missingParameters(type, send.data, image !== null),
  }, preview);
}

// Compatibility wrapper for local image imports; preserve caller-provided image attributes.
export function saveMemeImage(bytes, { name = '', tags = [], data = {}, source = null } = {}) {
  if (bytes === null || bytes === undefined) return Promise.reject(new Error('媒体内容必须是非空 Buffer'));
  return saveMeme({ type: 'image', image: bytes, name, tags, data, source });
}

export async function readMeme(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new Error('无效的表情 ID');
  }
  const paths = mediaPaths();
  const directory = join(paths.memes, id);
  let record;
  try { record = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!record || record.id !== id || record.kind !== 'memes' || ![1, 2].includes(record.version)) {
    throw new Error('表情元数据无效或版本不支持');
  }
  for (const [file, prefix] of [[record.filename, 'image'], [record.preview?.filename, 'preview']]) {
    if (file != null && !new RegExp(`^${prefix}\\.(png|jpg|gif|webp)$`).test(file)) throw new Error('表情文件名无效');
    if (file != null && !(await stat(join(directory, file))).isFile()) throw new Error('表情文件无效');
  }
  if (record.version === 1) {
    // Old imports only had image bytes. Do not fabricate missing sticker attributes.
    record = { ...record, memeType: 'image', send: { type: 'image', data: {} }, source: null, preview: null };
  } else if (!['image', 'mface', 'face'].includes(record.memeType) || record.send?.type !== record.memeType) {
    throw new Error('表情发送类型无效');
  }
  record.send.data = snapshotJsonObject(record.send.data);
  record.missingParameters = missingParameters(record.memeType, record.send.data, !!record.filename);
  return assetReference(paths.root, directory, record);
}
