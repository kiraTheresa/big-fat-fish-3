import { readUsageRecords } from '../store/usage-store.js';
import { usageDayStart } from '../platform/usage-policy.js';
import { redactText } from '../utils/logger.js';

const DAY = 86400000;
const KINDS = ['chat', 'vision', 'distill', 'draw', 'image_lab'];
const SOURCES = ['live', 'test', 'scheduled', 'admin', 'system', 'unknown'];
const REASONS = ['upstream_busy', 'rate_limited', 'timeout', 'auth_failed', 'balance_required', 'request_rejected', 'upstream_error', 'network_error', 'interrupted', 'other'];
const invalid = message => Object.assign(new Error(message), { status: 400 });
const asTime = value => typeof value === 'number' ? value : /^\d+$/.test(value ?? '') ? Number(value) : Date.parse(value);
const knownDuration = row => typeof row.elapsedMs === 'number' && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0;
const resultOf = row => ['success', 'failure', 'interrupted'].includes(row.status) ? row.status : 'unknown';

export function requestFailureReason(row) {
  if (row.status === 'interrupted') return 'interrupted';
  if (row.status !== 'failure') return null;
  const status = row.httpStatus;
  if (status === 503) return 'upstream_busy';
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'auth_failed';
  if (status === 402) return 'balance_required';
  if (/timeout|timed out|超时|aborted due to timeout/i.test(row.error ?? '')) return 'timeout';
  if (status >= 500) return 'upstream_error';
  if (status >= 400) return 'request_rejected';
  if (/fetch failed|ECONN|ENOTFOUND|network|网络/i.test(row.error ?? '')) return 'network_error';
  return 'other';
}

function decodeCursor(value) {
  if (value === undefined || value === '') return null;
  try {
    if (typeof value !== 'string' || value.length > 512 || !/^req1\.[A-Za-z0-9_-]+$/.test(value)) throw invalid('请求游标无效');
    const row = JSON.parse(Buffer.from(value.slice(5), 'base64url').toString());
    if (!Number.isFinite(row.time) || !Number.isFinite(row.asOf) || !/^[A-Za-z0-9_-]{1,120}:\d+$/.test(row.key)) throw invalid('请求游标无效');
    return row;
  } catch { throw invalid('请求游标无效，请返回最新记录'); }
}

const summary = () => ({ calls: 0, successes: 0, failures: 0, interrupted: 0, unknownResults: 0 });
function count(target, row) {
  target.calls++;
  if (row.status === 'success') target.successes++;
  else if (row.status === 'failure') target.failures++;
  else { target.unknownResults++; if (row.status === 'interrupted') target.interrupted++; }
}
function peakInFlight(intervals) {
  const edges = intervals.flatMap(([start, end]) => [[start, 1], [end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0, peak = 0;
  for (const [, delta] of edges) { active += delta; peak = Math.max(peak, active); }
  return peak;
}

export async function readRequestDashboard(query = {}, now = Date.now()) {
  const { period = 'today', sessionKey, kind, source, reason, before } = query;
  if (!['today', 'yesterday', '7d', '30d', 'custom'].includes(period)) throw invalid('统计时段无效');
  if (kind && !KINDS.includes(kind)) throw invalid('调用用途无效');
  if (source && !SOURCES.includes(source)) throw invalid('调用来源无效');
  if (reason && !REASONS.includes(reason)) throw invalid('失败原因无效');
  if (query.failedOnly !== undefined && ![true, false, 'true', 'false'].includes(query.failedOnly)) throw invalid('异常筛选无效');
  const limit = Number(query.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid('明细数量需为 1–200');
  const cursor = decodeCursor(before);
  const asOf = cursor?.asOf ?? (query.asOf === undefined ? now : asTime(query.asOf));
  if (!Number.isFinite(asOf) || asOf < 0 || asOf > now) throw invalid('统计快照时间无效');
  const midnight = usageDayStart(asOf);
  const since = period === 'custom' ? asTime(query.since) : midnight - ({ yesterday: 1, '7d': 6, '30d': 29 }[period] ?? 0) * DAY;
  const until = period === 'custom' ? Math.min(asTime(query.until), asOf) : period === 'yesterday' ? midnight : asOf;
  if (!Number.isFinite(since) || !Number.isFinite(until) || since < 0 || since > until || until - since > 31 * DAY) throw invalid('日期范围无效，最多查看 31 天');
  const detailSince = query.detailSince === undefined ? since : asTime(query.detailSince);
  const detailUntil = query.detailUntil === undefined ? until : asTime(query.detailUntil);
  if (!Number.isFinite(detailSince) || !Number.isFinite(detailUntil) || detailSince < since || detailUntil > until || detailSince > detailUntil) throw invalid('明细时段超出统计范围');
  const interval = until - since <= DAY ? 'hour' : 'day';
  const step = interval === 'hour' ? 3600000 : DAY;
  const buckets = new Map();
  for (let time = since; time < until; time += step) buckets.set(time, { time, until: Math.min(time + step, until), ...summary() });
  const totals = summary();
  const byKind = new Map(), bySession = new Map(), bySource = new Map(), errors = new Map(), minutes = new Map();
  const durations = [], intervals = [], items = [];
  const positions = new Map();
  let missingDurations = 0, overlapSamples = 0, matchingItems = 0;
  const failedOnly = query.failedOnly === true || query.failedOnly === 'true';
  // shortcut: queries scan the local ledger; add an index if measured query latency becomes noticeable.
  for await (const record of readUsageRecords(sessionKey)) {
    const position = (positions.get(record.sessionKey) ?? 0) + 1;
    positions.set(record.sessionKey, position);
    const finishedAt = Number.isFinite(record.finishedAt) ? record.finishedAt
      : ['success', 'failure'].includes(record.status) && knownDuration(record) ? record.time + record.elapsedMs : record.time;
    if (finishedAt > asOf) continue;
    const recordKind = record.kind ?? 'chat';
    const recordSource = SOURCES.includes(record.source) ? record.source : 'unknown';
    if ((kind && recordKind !== kind) || (source && recordSource !== source)) continue;
    const status = resultOf(record);
    if (['success', 'failure'].includes(status) && knownDuration(record) && record.elapsedMs > 0
      && record.time < until && record.time + record.elapsedMs > since) {
      intervals.push([Math.max(since, record.time), Math.min(until, record.time + record.elapsedMs)]);
      overlapSamples++;
    }
    if (record.time < since || record.time >= until) continue;
    const row = { key: `${record.sessionKey}:${position}`, time: record.time, sessionKey: record.sessionKey,
      kind: recordKind, source: recordSource, status, reason: requestFailureReason(record),
      model: redactText(record.model ?? '未记录'),
      ...(typeof record.responseModel === 'string' ? { responseModel: redactText(record.responseModel) } : {}),
      ...(knownDuration(record) ? { elapsedMs: record.elapsedMs } : {}),
      ...(Number.isInteger(record.httpStatus) ? { httpStatus: record.httpStatus } : {}),
      ...(typeof record.traceId === 'string' ? { traceId: redactText(record.traceId) } : {}),
      ...(typeof record.id === 'string' ? { operationId: redactText(record.id) } : {}),
      ...(typeof record.error === 'string' ? { error: redactText(record.error).slice(0, 500) } : {}) };
    count(totals, row);
    for (const [map, key] of [[byKind, recordKind], [bySession, row.sessionKey], [bySource, recordSource]]) {
      if (!map.has(key)) map.set(key, summary());
      count(map.get(key), row);
    }
    const bucket = since + Math.floor((row.time - since) / step) * step;
    count(buckets.get(bucket), row);
    const minute = Math.floor(row.time / 60000);
    minutes.set(minute, (minutes.get(minute) ?? 0) + 1);
    if (row.status === 'success') {
      if (knownDuration(row)) durations.push(row.elapsedMs);
      else missingDurations++;
    }
    if (row.reason) errors.set(row.reason, (errors.get(row.reason) ?? 0) + 1);
    if ((reason && row.reason !== reason) || (failedOnly && !['failure', 'interrupted'].includes(row.status))
      || row.time < detailSince || row.time >= detailUntil) continue;
    matchingItems++;
    if (cursor && (row.time > cursor.time || (row.time === cursor.time && row.key.localeCompare(cursor.key) >= 0))) continue;
    items.push(row);
    items.sort((a, b) => b.time - a.time || b.key.localeCompare(a.key));
    if (items.length > limit + 1) items.pop();
  }
  durations.sort((a, b) => a - b);
  const knownResults = totals.successes + totals.failures;
  const next = items.length > limit;
  if (next) items.pop();
  const last = items.at(-1);
  return {
    range: { period, since, until, asOf, interval, timeZone: 'Asia/Shanghai' },
    totals: { ...totals, knownResults, failureRate: knownResults ? totals.failures / knownResults * 100 : null,
      peakPerMinute: Math.max(0, ...minutes.values()), averagePerMinute: until > since ? totals.calls * 60000 / (until - since) : null,
      p95Ms: durations.length ? durations[Math.ceil(durations.length * .95) - 1] : null, durationSamples: durations.length, missingDurations,
      peakInFlight: intervals.length ? peakInFlight(intervals) : totals.calls ? null : 0, overlapSamples },
    byTime: [...buckets.values()],
    byKind: [...byKind].map(([kind, values]) => ({ kind, ...values })),
    bySession: [...bySession].map(([sessionKey, values]) => ({ sessionKey, ...values })).sort((a, b) => b.calls - a.calls),
    bySource: [...bySource].map(([source, values]) => ({ source, ...values })),
    errors: [...errors].map(([reason, calls]) => ({ reason, calls })).sort((a, b) => b.calls - a.calls),
    items, matchingItems,
    nextCursor: next ? 'req1.' + Buffer.from(JSON.stringify({ time: last.time, key: last.key, asOf })).toString('base64url') : null,
  };
}
