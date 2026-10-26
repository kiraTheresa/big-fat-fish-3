// Gateway admission and durable in-flight reservations. Single-process serial
// admission prevents concurrent calls from exceeding the daily call budget.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from './persistence.js';
import { join } from 'node:path';
import { config } from '../config.js';
import { appendUsage, readUsageOverview, usageSessionKey } from '../store/usage-store.js';
import { logger, redactText } from '../utils/logger.js';

const DEFAULT_POLICY = { enabled: { chat: true, vision: true, draw: true, distill: true }, maxCallsPerDay: 0, maxTokensPerDay: 0 };
let policy = structuredClone(DEFAULT_POLICY);
let chain = Promise.resolve();
let pending = new Map();
let loadedDir = null;
let lastPersistenceError = null;
let lastLedgerError = null;
function serial(operation) {
  const result = chain.then(operation);
  chain = result.catch(() => {});
  return result;
}
export class UsageLimitError extends Error {
  constructor(message, code = 'USAGE_LIMIT') { super(message); this.name = 'UsageLimitError'; this.code = code; }
}
export function setUsagePolicy(next = {}) {
  policy = {
    enabled: { ...DEFAULT_POLICY.enabled, ...(next.features ?? next.enabled ?? {}) },
    maxCallsPerDay: Math.max(0, Math.floor(Number(next.limits?.maxCallsPerDay ?? next.maxCallsPerDay) || 0)),
    maxTokensPerDay: Math.max(0, Math.floor(Number(next.limits?.maxTokensPerDay ?? next.maxTokensPerDay) || 0)),
  };
  return getUsagePolicy();
}
export function getUsagePolicy() {
  return { features: { ...policy.enabled }, limits: { maxCallsPerDay: policy.maxCallsPerDay, maxTokensPerDay: policy.maxTokensPerDay } };
}
export const configureUsagePolicy = setUsagePolicy;

// Daily budgets reset at Asia/Shanghai midnight, independent of server timezone.
export function usageDayStart(now = Date.now()) {
  return Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
}
async function savePending() {
  const dir = config.usageDir;
  await atomicWriteJson(join(dir, '.pending.json'), [...pending.values()]);
  lastPersistenceError = null;
}
async function loadPending() {
  if (loadedDir === config.usageDir) return;
  const dir = config.usageDir;
  pending = new Map();
  let rows = [];
  try { rows = JSON.parse(await readFile(join(dir, '.pending.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(rows)) throw new Error('Usage reservation state is invalid');
  // Recover calls interrupted by process exit. Ignore any completed IDs whose
  // reservation removal was interrupted after the completed row was persisted.
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !Number.isFinite(row.time)) throw new Error('Usage reservation entry is invalid');
    const history = await readUsageOverview({ sessionKey: row.sessionKey, since: row.time, until: row.time, limit: 1000 });
    if (history.items.some((entry) => entry.id === row.id)) continue;
    const recovered = { ...row, status: 'interrupted', usageKnown: false, elapsedMs: Math.max(0, Date.now() - row.time), error: 'Process exited before API result was recorded' };
    if (!await appendUsage(row.sessionKey, recovered)) pending.set(row.id, row);
  }
  await savePending();
  loadedDir = dir;
}

export async function beginUsage({ kind = 'chat', model, sessionKey = 'system' }) {
  const key = usageSessionKey(sessionKey);
  return serial(async () => {
    if (!(kind in DEFAULT_POLICY.enabled)) throw new Error('Unknown model usage kind');
    if (policy.enabled[kind] === false) throw new UsageLimitError(`${kind} 已被管理配置停用`, 'FEATURE_DISABLED');
    try { await loadPending(); }
    catch (error) {
      lastPersistenceError = redactText(error.message);
      throw new UsageLimitError('用量状态不可读，暂停模型调用以避免绕过预算', 'USAGE_STORAGE');
    }
    const now = Date.now();
    const since = usageDayStart(now);
    let overview;
    try {
      overview = await readUsageOverview({ since, until: now, limit: 0 });
      lastLedgerError = null;
    } catch (error) {
      lastLedgerError = redactText(error.message);
      throw new UsageLimitError('用量账本不可读或损坏，暂停模型调用', 'USAGE_STORAGE');
    }
    const active = [...pending.values()].filter((entry) => entry.time >= since && entry.time <= now);
    if (policy.maxCallsPerDay && overview.totals.calls + active.length >= policy.maxCallsPerDay) {
      throw new UsageLimitError('今日模型调用次数已达上限');
    }
    if (policy.maxTokensPerDay && overview.totals.totalTokens >= policy.maxTokensPerDay) {
      throw new UsageLimitError('今日已报告 token 用量已达上限');
    }
    const attempt = { id: randomUUID(), time: now, kind, model: redactText(model), sessionKey: key };
    pending.set(attempt.id, attempt);
    try { await savePending(); }
    catch (error) {
      pending.delete(attempt.id);
      lastPersistenceError = redactText(error.message);
      throw new UsageLimitError('用量预留写入失败，暂停模型调用', 'USAGE_STORAGE');
    }
    return attempt;
  });
}

export async function finishUsage(attempt, { usage, error, httpStatus, images = 0 } = {}) {
  return serial(async () => {
    const numeric = (value) => Number.isFinite(value) && value >= 0 ? value : undefined;
    const promptTokens = numeric(usage?.prompt_tokens ?? usage?.input_tokens);
    const completionTokens = numeric(usage?.completion_tokens ?? usage?.output_tokens);
    const totalTokens = numeric(usage?.total_tokens) ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined);
    const record = {
      ...attempt,
      status: error ? 'failure' : 'success',
      elapsedMs: Math.max(0, Date.now() - attempt.time),
      usageKnown: totalTokens !== undefined,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(error ? { error: redactText(error.message ?? error, [config.deepseekApiKey, config.imageApiKey]) } : {}),
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      prompt_cache_hit_tokens: numeric(usage?.prompt_cache_hit_tokens),
      images: numeric(images) ?? 0,
    };
    const saved = await appendUsage(attempt.sessionKey, record);
    if (saved) {
      pending.delete(attempt.id);
      try { await savePending(); }
      catch (err) { lastPersistenceError = redactText(err.message); logger.warn(`用量预留清理失败: ${lastPersistenceError}`); }
    }
    logger[error ? 'warn' : 'info']('[model]', { kind: record.kind, model: record.model, sessionKey: record.sessionKey, status: record.status, elapsedMs: record.elapsedMs, totalTokens: record.total_tokens ?? null, ...(record.httpStatus ? { httpStatus: record.httpStatus } : {}), ...(record.error ? { error: record.error } : {}) });
    return record;
  });
}

export function initializeUsage() {
  return serial(async () => {
    try { await loadPending(); }
    catch (error) { lastPersistenceError = redactText(error.message); throw error; }
  });
}

export async function readUsageMonitor() {
  let ready = true;
  try { await initializeUsage(); } catch { ready = false; }
  await chain;
  const now = Date.now();
  let today = null;
  try {
    const overview = await readUsageOverview({ since: usageDayStart(now), until: now, limit: 0 });
    if (ready) today = overview.totals;
    lastLedgerError = null;
  } catch (error) { lastLedgerError = redactText(error.message); }
  return {
    policy: getUsagePolicy(), today, ledgerAvailable: today !== null,
    inFlight: [...pending.values()].map(({ id, kind, sessionKey, time }) => ({ id, kind, sessionKey, time })),
    lastPersistenceError: lastLedgerError ?? lastPersistenceError,
    resetAt: usageDayStart(now) + 86400000,
    tokenLimitMode: 'reported-usage',
  };
}
