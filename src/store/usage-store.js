// One completed record per actual model API attempt. Legacy token-only rows and
// readUsageStats keys remain readable; malformed rows never erase good history.
import { readdir } from 'node:fs/promises';
import { appendJsonl } from '../platform/persistence.js';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger, redactText } from '../utils/logger.js';
import { estimateUsageCost } from '../usage/pricing.js';

let writeChain = Promise.resolve();
let lastWriteError = null;
let lastReadError = null;
export function usageSessionKey(key = 'system') {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(key)) throw new Error('Invalid usage session key');
  return key;
}

export function appendUsage(sessionKey, record) {
  // Capture directory at submission, so runtime config changes cannot redirect
  // an already queued write into a different data root.
  const dir = config.usageDir;
  writeChain = writeChain.then(async () => {
    try {
      const key = usageSessionKey(sessionKey);
      await appendJsonl(join(dir, `${key}.jsonl`), { ...record, kind: record.kind ?? 'chat' });
      lastWriteError = null;
      return true;
    } catch (err) {
      lastWriteError = redactText(err.message);
      logger.warn(`用量记录失败: ${lastWriteError}`);
      return false;
    }
  });
  return writeChain;
}

export function flushUsage() { return writeChain; }
export function getUsageStoreStats() { return { lastWriteError, lastReadError }; }
const tokens = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
function emptyTotals(includeCost = false) {
  return { calls: 0, successes: 0, failures: 0, unknownUsageCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, images: 0,
    ...(includeCost ? { costNano: 0, pricedCalls: 0, pendingCostCalls: 0, promptKnownCalls: 0, completionKnownCalls: 0, cacheHitTokens: 0, cacheReportedPromptTokens: 0, cacheUnknownCalls: 0 } : {}) };
}
function add(stats, rec, cost) {
  stats.calls++;
  if (rec.status === 'failure' || rec.status === 'interrupted') stats.failures++;
  else stats.successes++;
  if (rec.usageKnown === false || (rec.usageKnown === undefined && !Number.isFinite(rec.total_tokens))) stats.unknownUsageCalls++;
  stats.promptTokens += tokens(rec.prompt_tokens);
  stats.completionTokens += tokens(rec.completion_tokens);
  stats.totalTokens += tokens(rec.total_tokens);
  stats.images += tokens(rec.images);
  if (cost) {
    if (Number.isFinite(rec.prompt_tokens)) stats.promptKnownCalls++;
    if (Number.isFinite(rec.completion_tokens)) stats.completionKnownCalls++;
    if (cost.status === 'estimated') { stats.costNano += cost.costNano; stats.pricedCalls++; }
    else stats.pendingCostCalls++;
    if (Number.isFinite(rec.prompt_cache_hit_tokens) && Number.isFinite(rec.prompt_tokens) && rec.prompt_cache_hit_tokens >= 0 && rec.prompt_cache_hit_tokens <= rec.prompt_tokens) {
      stats.cacheHitTokens += rec.prompt_cache_hit_tokens;
      stats.cacheReportedPromptTokens += rec.prompt_tokens;
    } else if (rec.kind !== 'draw') stats.cacheUnknownCalls++;
  }
}
function asTime(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.parse(value);
}
function ledgerError(name, line) {
  const error = new Error(`Usage ledger contains an invalid record (${name}:${line}); repair the ledger before model calls resume`);
  error.code = 'USAGE_LEDGER_CORRUPT';
  error.status = 503;
  return error;
}
function validRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !Number.isFinite(record.time) || record.time < 0) return false;
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'images', 'elapsedMs']) {
    if (record[field] !== undefined && record[field] !== null && (!Number.isFinite(record[field]) || record[field] < 0)) return false;
  }
  if (record.status !== undefined && !['success', 'failure', 'interrupted'].includes(record.status)) return false;
  if (record.usageKnown !== undefined && typeof record.usageKnown !== 'boolean') return false;
  if (record.usageKnown === true && !Number.isFinite(record.total_tokens)) return false;
  return true;
}
async function* records(sessionKey, { strict = false } = {}) {
  let names;
  try {
    names = sessionKey ? [`${usageSessionKey(sessionKey)}.jsonl`] : (await readdir(config.usageDir)).filter((name) => /^[a-zA-Z0-9_-]+\.jsonl$/.test(name)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    const input = createReadStream(join(config.usageDir, name), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      let lineNumber = 0;
      for await (const line of lines) {
        lineNumber++;
        if (line.trim() === '') continue;
        let record;
        try { record = JSON.parse(line); }
        catch {
          if (strict) throw ledgerError(name, lineNumber);
          continue;
        }
        if (strict && !validRecord(record)) throw ledgerError(name, lineNumber);
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        yield { ...record, sessionKey: name.slice(0, -6) };
      }
    } catch (error) {
      if (error.code !== 'ENOENT' || !sessionKey) throw error;
    } finally { lines.close(); input.destroy(); }
  }
}

// Aggregates cover ALL matching records, independently of the bounded newest
// items list. since/until accept epoch milliseconds or ISO timestamps, inclusive.
// Invalid ledger rows fail closed here: silently skipping a charged attempt could
// reopen a daily budget. Legacy readUsageStats remains tolerant for /status.
export async function readUsageOverview({ since, until, sessionKey, kind, limit = 100, includeCost = false, interval, detailKind, pendingOnly = false } = {}) {
  await flushUsage();
  const totals = emptyTotals(includeCost);
  const kinds = new Map();
  const sessions = new Map();
  const buckets = new Map();
  const reasons = new Map();
  const items = [];
  let itemCount = 0;
  const from = asTime(since, -Infinity);
  const to = asTime(until, Infinity);
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) throw new Error('Invalid usage time filter');
  if (interval !== undefined && !['hour', 'day'].includes(interval)) throw new Error('Invalid usage interval');
  const cap = Math.max(0, Math.min(1000, Number(limit) || 0));
  try {
    for await (const record of records(sessionKey, { strict: true })) {
      if ((record.time ?? 0) < from || (record.time ?? 0) > to || (kind && record.kind !== kind)) continue;
      const cost = includeCost ? estimateUsageCost(record) : undefined;
      add(totals, record, cost);
      const recordKind = record.kind ?? 'chat';
      if (!kinds.has(recordKind)) kinds.set(recordKind, { kind: recordKind, ...emptyTotals(includeCost) });
      if (!sessions.has(record.sessionKey)) sessions.set(record.sessionKey, { sessionKey: record.sessionKey, ...emptyTotals(includeCost) });
      add(kinds.get(recordKind), record, cost);
      add(sessions.get(record.sessionKey), record, cost);
      if (cost?.status === 'pending') reasons.set(cost.reason, (reasons.get(cost.reason) ?? 0) + 1);
      if (interval) {
        const step = interval === 'hour' ? 3600000 : 86400000;
        const offset = interval === 'day' ? 8 * 3600000 : 0;
        const time = Math.floor((record.time + offset) / step) * step - offset;
        if (!buckets.has(time)) buckets.set(time, { time, ...emptyTotals(includeCost) });
        add(buckets.get(time), record, cost);
      }
      if ((detailKind && recordKind !== detailKind) || (pendingOnly && cost?.status !== 'pending')) continue;
      itemCount++;
      if (cap) {
        items.push(cost ? { ...record, cost } : record);
        items.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
        if (items.length > cap) items.pop();
      }
    }
  } catch (error) { lastReadError = redactText(error.message); throw error; }
  lastReadError = null;
  return { totals, byKind: [...kinds.values()], bySession: [...sessions.values()], items,
    ...(includeCost ? { itemCount, pendingReasons: [...reasons].map(([reason, calls]) => ({ reason, calls })) } : {}),
    ...(interval ? { byTime: [...buckets.values()].sort((a, b) => a.time - b.time) } : {}) };
}

export async function readUsageStats(sessionKey) {
  const stats = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0 };
  await flushUsage();
  try {
    for await (const rec of records(sessionKey)) {
      stats.calls++;
      stats.promptTokens += tokens(rec.prompt_tokens);
      stats.completionTokens += tokens(rec.completion_tokens);
      stats.totalTokens += tokens(rec.total_tokens);
      stats.cacheHitTokens += tokens(rec.prompt_cache_hit_tokens);
    }
  } catch (err) { logger.warn(`用量读取失败: ${err.message}`); }
  return stats;
}
