// Local originals and metadata. Publish each complete asset with a directory rename.
import { mkdir, rename, rm } from 'node:fs/promises';
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

async function saveAsset(kind, bytes, details) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('媒体内容必须是非空 Buffer');
  const [extension, mimeType] = imageFormat(bytes);
  if (kind === 'memes' && extension === 'bin') throw new Error('表情包仅支持 PNG、JPEG、GIF、WebP');
  const paths = mediaPaths();
  const createdAt = new Date().toISOString();
  const id = randomUUID();
  const parent = kind === 'generated' ? join(paths.generated, createdAt.slice(0, 10)) : paths.memes;
  const directory = join(parent, id);
  const staging = join(parent, `.${id}.tmp`);
  const filename = `image.${extension}`;
  const record = {
    version: 1, id, kind, createdAt, filename, mimeType, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), ...details,
  };
  return withStorageLock(directory, async () => {
    await mkdir(parent, { recursive: true });
    await mkdir(staging, { mode: 0o700 });
    try {
      await atomicWriteFile(join(staging, filename), bytes);
      await atomicWriteJson(join(staging, 'metadata.json'), record);
      await rename(staging, directory);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    // Relative references survive moving the data directory or Docker mounts.
    return { ...record, path: relative(paths.root, join(directory, filename)).split('\\').join('/') };
  });
}

export function saveGeneratedImage(b64, { prompt, sessionKey, model, size } = {}) {
  if (typeof b64 !== 'string' || !b64.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1) {
    throw new Error('生成图片不是有效的 Base64');
  }
  return saveAsset('generated', Buffer.from(b64, 'base64'), { prompt, sessionKey, model, size });
}

// File/QQ import entry points can later feed original bytes here; never recompress GIFs.
export function saveMemeImage(bytes, { name = '', tags = [] } = {}) {
  if (typeof name !== 'string' || !Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new Error('表情包名称必须是字符串，标签必须是字符串数组');
  }
  return saveAsset('memes', bytes, { name, tags: [...new Set(tags)] });
}
