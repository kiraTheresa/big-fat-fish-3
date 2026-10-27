// Shared file IO: per-path serialization, atomic replacement, bounded streaming reads.
// Stores decide whether failure is fatal; this layer never hides disk errors.
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const locks = new Map();
let lastError = null;
export function withStorageLock(key, fn) {
  const id = resolve(key);
  const next = (locks.get(id) ?? Promise.resolve()).then(fn);
  const settled = next.catch((err) => { lastError = { time: Date.now(), message: err.code ?? 'storage error' }; });
  locks.set(id, settled);
  settled.finally(() => { if (locks.get(id) === settled) locks.delete(id); });
  return next;
}
export async function atomicWriteFile(file, value) {
  return withStorageLock(file, async () => {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(value);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, file);
    } finally {
      await handle?.close();
      await unlink(temp).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    }
  });
}
export function atomicWriteJson(file, value) { return atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n'); }
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return structuredClone(fallback); throw err; }
}
export function appendJsonl(file, record) {
  // Snapshot now, before another caller can mutate the object.
  const line = JSON.stringify(record) + '\n';
  return withStorageLock(file, async () => {
    await mkdir(dirname(file), { recursive: true });
    const handle = await open(file, 'a', 0o600);
    try { await handle.writeFile(line); } finally { await handle.close(); }
  });
}
export async function readJsonl(file, { limit = 100, before, filter } = {}) {
  if (!Number.isInteger(limit) || limit < 1) return [];
  limit = Math.min(limit, 10000);
  const records = [];
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== 'object') continue;
      if (before !== undefined && (record.time ?? record.receivedAt) >= before) continue;
      if (filter && !filter(record)) continue;
      records.push(record);
      if (records.length > limit) records.shift();
    }
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  finally { lines.close(); stream.destroy(); }
  return records;
}
export async function flushPersistence() { while (locks.size) await Promise.all([...locks.values()]); }
export function getPersistenceStatus() { return { pendingWrites: locks.size, lastError, mode: 'atomic-json-and-jsonl' }; }
