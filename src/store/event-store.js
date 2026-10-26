// Full protocol inbox, deliberately separate from LLM/chat history.
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { appendJsonl } from '../platform/persistence.js';

let writeChain = Promise.resolve();
const inboxDir = () => join(config.dataDir, 'events');
const inboxFile = (receivedAt) => join(inboxDir(), `${new Date(receivedAt).toISOString().slice(0, 10)}.jsonl`);
let received = 0;
let failed = 0;
let lastEventAt = null;
const postTypes = Object.create(null);
const sessions = Object.create(null);

export function appendEvent(record) {
  // Snapshot at submission time: later trigger mutations cannot alter evidence.
  let stored;
  try {
    stored = structuredClone({ ...record, id: randomUUID(), receivedAt: Date.now() });
  } catch (err) {
    failed++;
    logger.warn(`事件存储失败: ${err.message}`);
    return Promise.resolve(null);
  }
  const file = inboxFile(stored.receivedAt);
  writeChain = writeChain.then(async () => {
    try {
      await appendJsonl(file, stored);
      received++;
      lastEventAt = stored.receivedAt;
      postTypes[stored.postType ?? stored.event?.post_type ?? 'unknown'] = (postTypes[stored.postType ?? stored.event?.post_type ?? 'unknown'] ?? 0) + 1;
      if (stored.sessionKey) sessions[stored.sessionKey] = (sessions[stored.sessionKey] ?? 0) + 1;
      return stored;
    } catch (err) {
      failed++;
      logger.warn(`事件存储失败: ${err.message}`);
      return null;
    }
  });
  return writeChain;
}

async function* storedEvents(directory) {
  const files = (await readdir(directory)).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort();
  for (const file of files) {
    const stream = createReadStream(join(directory, file), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row && typeof row === 'object' && !Array.isArray(row)) yield row;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // retention may remove an older file during a read
    } finally { lines.close(); stream.destroy(); }
  }
}

export async function readEvents({ limit = 50, postType, sessionKey, before } = {}) {
  await writeChain;
  const size = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
  try {
    // UUID cursor names a persisted row, remaining stable as new events arrive.
    // Keep only one page + one sentinel in memory even as heartbeat logs grow.
    const rows = [];
    let foundCursor = before == null;
    for await (const row of storedEvents(inboxDir())) {
      if (before != null && row.id === before) { foundCursor = true; break; }
      if ((postType && row.postType !== postType) || (sessionKey && row.sessionKey !== sessionKey)) continue;
      rows.push(row);
      if (rows.length > size + 1) rows.shift();
    }
    if (!foundCursor) return { items: [], nextCursor: null };
    const items = rows.slice(-size).reverse();
    return { items, nextCursor: rows.length > size ? items.at(-1).id : null };
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`事件读取失败: ${err.message}`);
    return { items: [], nextCursor: null };
  }
}

// Process-lifetime counters are explicitly distinguished from persisted inbox size.
export function getEventStats() {
  return { received, failed, lastEventAt, postTypes: { ...postTypes }, sessions: { ...sessions }, scope: 'process' };
}
export function flushEventStore() { return writeChain; }
