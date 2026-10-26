// Console compatibility + append-only structured logs. No config import: config
// itself uses this logger during startup. Call configureLogger from the runtime.
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { appendJsonl } from '../platform/persistence.js';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
let settings = { dataDir: null, secrets: [], level: 'INFO', retentionDays: 14 };
let writeChain = Promise.resolve();
let lastCleanupDay = null;
let pendingWrites = 0;
let lastError = null;
let written = 0;
const sensitiveKey = /authorization|api[-_]?key|access[-_]?token|password|secret|cookie|b64|base64|image_url|raw_message|^prompt$|^messages?$/i;

export function configureLogger(options = {}) {
  settings = { ...settings, ...options };
  settings.level = String(settings.level).toUpperCase();
  if (!(settings.level in LEVELS)) settings.level = 'INFO';
  settings.secrets = (settings.secrets ?? []).filter((value) => typeof value === 'string' && value !== '');
  settings.retentionDays = Math.max(1, Number(settings.retentionDays) || 14);
  lastCleanupDay = null;
  return getLogStats();
}

export function redactText(value, extraSecrets = []) {
  let text = String(value);
  const startupSecrets = ['DEEPSEEK_API_KEY', 'IMAGE_API_KEY', 'ONEBOT_ACCESS_TOKEN', 'ADMIN_TOKEN'].map((key) => process.env[key]);
  for (const secret of [...settings.secrets, ...extraSecrets, ...startupSecrets].filter((value) => typeof value === 'string' && value).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[REDACTED]');
  }
  return text.replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[-_]?key|access[-_]?token|token|password|secret)\s*[:=]\s*["']?[^\s,;"'}]+/gi, '$1=[REDACTED]')
    .replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, (value) => {
      // Origins remain useful for connection diagnostics; credentials, paths,
      // fragments and signed query strings are never retained.
      try { const url = new URL(value); return `${url.protocol}//${url.host}`; } catch { return '[URL]'; }
    })
    .replace(/data:[^\s;,]+;base64,[A-Za-z0-9+/=_-]+/gi, '[IMAGE]')
    .replace(/base64:\/\/[A-Za-z0-9+/=_-]+/gi, '[IMAGE]')
    .replace(/[A-Za-z0-9+/=_-]{120,}/g, '[PAYLOAD]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 4000);
}

function safeValue(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[BINARY]';
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4 || seen.has(value)) return '[OMITTED]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 30).map((entry) => safeValue(entry, depth + 1, seen));
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, entry]) => [
    key, sensitiveKey.test(key) ? '[REDACTED]' : safeValue(entry, depth + 1, seen),
  ]));
}

function log(level, args) {
  if (LEVELS[level] < LEVELS[settings.level]) return;
  const now = new Date();
  const safeArgs = args.map((arg) => safeValue(arg));
  const message = safeArgs.map((arg) => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ').slice(0, 8000);
  const time = now.toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${time}] ${level} ${message}`);
  if (!settings.dataDir) return;
  const entry = { id: randomUUID(), time: now.toISOString(), level, message };
  const options = { ...settings };
  pendingWrites++;
  writeChain = writeChain.then(async () => {
    const directory = join(options.dataDir, 'logs');
    const day = entry.time.slice(0, 10);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendJsonl(join(directory, `${day}.jsonl`), entry);
    written++;
    if (lastCleanupDay !== day) {
      lastCleanupDay = day;
      const cutoff = Date.now() - options.retentionDays * 86400000;
      for (const name of await readdir(directory)) {
        if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && Date.parse(name.slice(0, 10)) + 86400000 < cutoff) {
          await unlink(join(directory, name));
        }
      }
    }
    lastError = null;
  }).catch((error) => {
    lastError = redactText(error.message);
    // Never recurse through logger on an unwritable log destination.
    console.log(`[${time}] WARN 日志持久化失败: ${lastError}`);
  }).finally(() => { pendingWrites--; });
}

export const logger = {
  debug: (...args) => log('DEBUG', args),
  info: (...args) => log('INFO', args),
  warn: (...args) => log('WARN', args),
  error: (...args) => log('ERROR', args),
};

export function flushLogs() { return writeChain; }
export function getLogStats() {
  return { enabled: Boolean(settings.dataDir), level: settings.level, retentionDays: settings.retentionDays, pendingWrites, written, lastError };
}

// Append position is a tie-breaker for identical millisecond timestamps. Cursors
// refer to physical JSONL lines, including malformed/blank lines, so historical
// entries without IDs also remain stable as newer records are appended.
function encodeCursor(day, line) {
  return `log1.${Buffer.from(JSON.stringify({ day, line })).toString('base64url')}`;
}
function parseBefore(before) {
  if (before === undefined || before === null || before === '') return { time: Infinity };
  if (typeof before === 'string' && before.startsWith('log1.')) {
    try {
      if (before.length > 200) throw new Error();
      const cursor = JSON.parse(Buffer.from(before.slice(5), 'base64url').toString('utf8'));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cursor.day) || !Number.isSafeInteger(cursor.line) || cursor.line < 1) throw new Error();
      return { cursor, time: Infinity };
    } catch { throw new Error('Invalid log cursor'); }
  }
  const time = Number.isFinite(Number(before)) ? Number(before) : Date.parse(before);
  if (!Number.isFinite(time)) throw new Error('Invalid log cursor');
  return { time };
}

// Newest appended first. before accepts an opaque item.cursor (lossless) or a
// legacy timestamp (strictly older times). Filters are literal text/exact levels.
export async function readLogs({ level, q = '', limit = 100, before } = {}) {
  await flushLogs();
  const boundary = parseBefore(before);
  if (!settings.dataDir) return [];
  const directory = join(settings.dataDir, 'logs');
  const cap = Math.max(1, Math.min(1000, Number(limit) || 100));
  const expectedLevel = level ? String(level).toUpperCase() : null;
  const query = String(q).toLowerCase().slice(0, 500);
  const items = [];
  let files;
  try { files = (await readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  for (const name of files) {
    const day = name.slice(0, 10);
    if (boundary.cursor && day > boundary.cursor.day) continue;
    const input = createReadStream(join(directory, name), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const rows = [];
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber++;
        if (boundary.cursor && day === boundary.cursor.day && lineNumber >= boundary.cursor.line) break;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || typeof entry.message !== 'string' || !LEVELS[entry.level]) continue;
        const time = Date.parse(entry.time);
        if (!Number.isFinite(time) || time >= boundary.time || (expectedLevel && entry.level !== expectedLevel)) continue;
        if (query && !entry.message.toLowerCase().includes(query)) continue;
        rows.push({
          id: typeof entry.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(entry.id) ? entry.id : `legacy-${day}-${lineNumber}`,
          cursor: encodeCursor(day, lineNumber),
          time: entry.time, level: entry.level, message: redactText(entry.message),
        });
        if (rows.length > cap - items.length) rows.shift();
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { lines.close(); input.destroy(); }
    items.push(...rows.reverse());
    if (items.length >= cap) return items;
  }
  return items;
}
