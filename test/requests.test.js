import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'fish-request-stats-'));
Object.assign(process.env, { DATA_DIR: root, USAGE_DIR: join(root, 'usage'), CONFIG_PATH: join(root, 'none.json') });
const { config } = await import('../src/config.js');
const { appendUsage } = await import('../src/store/usage-store.js');
const { readRequestDashboard, requestFailureReason } = await import('../src/usage/requests.js');
const { configureLogger } = await import('../src/utils/logger.js');
const { startAdminServer } = await import('../src/admin/server.js');
const { renderRequestsView, renderRequestDetail, renderRequestTrace } = await import('../web/request-view.js');
const now = Date.parse('2026-11-04T12:00:00+08:00');
const midnight = Date.parse('2026-11-04T00:00:00+08:00');
let index = 0;
beforeEach(() => { config.usageDir = join(root, `case-${index++}`); configureLogger({ dataDir: null, secrets: ['request-secret'] }); });
after(async () => { configureLogger({ dataDir: null, secrets: [] }); await rm(root, { recursive: true, force: true }); });
const row = extra => ({ time: now - 60000, kind: 'chat', status: 'success', source: 'live', elapsedMs: 1000, model: 'deepseek-flash', ...extra });

test('request metrics use every matching row, with fixed-minute peaks, exact P95, source/kind filters and separate detail filters', async () => {
  for (let i = 1; i <= 205; i++) await appendUsage(i % 2 ? 'g-1' : 'p-2', row({ elapsedMs: i * 100 }));
  await appendUsage('g-1', row({ status: 'failure', httpStatus: 503 }));
  await appendUsage('g-1', row({ kind: 'vision', source: 'test' }));
  const all = await readRequestDashboard({ limit: 2 }, now);
  assert.equal(all.totals.calls, 207); assert.equal(all.items.length, 2);
  assert.equal(all.totals.peakPerMinute, 207);
  assert.equal(all.totals.p95Ms, 19500);
  assert.equal(all.totals.durationSamples, 206);
  assert.equal(all.byTime.reduce((sum, b) => sum + b.calls, 0), 207);
  assert.equal(all.byKind.reduce((sum, b) => sum + b.calls, 0), 207);
  assert.equal(all.bySession.reduce((sum, b) => sum + b.calls, 0), 207);
  const detail = await readRequestDashboard({ reason: 'upstream_busy' }, now);
  assert.deepEqual(detail.totals, all.totals); assert.equal(detail.matchingItems, 1);
  assert.equal((await readRequestDashboard({ source: 'live' }, now)).totals.calls, 206);
  assert.equal((await readRequestDashboard({ kind: 'vision' }, now)).totals.calls, 1);
  assert.equal((await readRequestDashboard({ sessionKey: 'p-2' }, now)).totals.calls, 102);
});

test('unknown results, interruptions and missing durations never become successful calls or zero latency', async () => {
  await appendUsage('g-1', row({ status: undefined, elapsedMs: undefined, source: undefined }));
  await appendUsage('g-1', row({ status: 'interrupted', elapsedMs: 999999999 }));
  await appendUsage('g-1', row({ elapsedMs: null }));
  await appendUsage('g-1', row({ status: 'failure', httpStatus: 200, error: 'The operation was aborted due to timeout' }));
  const result = await readRequestDashboard({}, now);
  assert.equal(result.totals.calls, 4); assert.equal(result.totals.successes, 1); assert.equal(result.totals.failures, 1);
  assert.equal(result.totals.unknownResults, 2); assert.equal(result.totals.interrupted, 1);
  assert.equal(result.totals.failureRate, 50);
  assert.equal(result.totals.p95Ms, null); assert.equal(result.totals.missingDurations, 1);
  assert.equal((await readRequestDashboard({ source: 'unknown' }, now)).totals.calls, 1);
  assert.equal((await readRequestDashboard({ failedOnly: 'true' }, now)).matchingItems, 2);
  const empty = await readRequestDashboard({ sessionKey: 'g-empty' }, now);
  assert.equal(empty.totals.calls, 0); assert.equal(empty.totals.failureRate, null);
});

test('historical in-flight overlap includes boundary-crossing calls and excludes interruptions; touching intervals do not overlap', async () => {
  await appendUsage('g-1', row({ time: midnight - 1000, elapsedMs: 2000 }));
  await appendUsage('g-1', row({ time: midnight + 1000, elapsedMs: 1000 }));
  const first = await readRequestDashboard({}, now);
  assert.equal(first.totals.calls, 1); assert.equal(first.totals.peakInFlight, 1);
  await appendUsage('g-1', row({ time: midnight + 500, elapsedMs: 1000 }));
  await appendUsage('g-1', row({ time: midnight + 501, status: 'interrupted', elapsedMs: 99999999 }));
  const next = await readRequestDashboard({}, now);
  assert.equal(next.totals.peakInFlight, 2); assert.equal(next.totals.overlapSamples, 3);
});

test('Shanghai date presets and half-open detail windows handle midnight; all query boundaries are validated', async () => {
  await appendUsage('g-1', row({ time: midnight - 1 }));
  await appendUsage('g-1', row({ time: midnight }));
  assert.equal((await readRequestDashboard({ period: 'yesterday' }, now)).totals.calls, 1);
  assert.equal((await readRequestDashboard({}, now)).totals.calls, 1);
  assert.equal((await readRequestDashboard({ detailUntil: midnight }, now)).matchingItems, 0);
  for (const query of [{ period: 'bad' }, { period: 'custom' }, { kind: 'bad' }, { source: 'bad' }, { reason: 'bad' }, { failedOnly: 'bad' },
    { limit: 201 }, { limit: -1 }, { sessionKey: '../file' }, { asOf: now + 1 }, { detailSince: now + 1 },
    { period: 'custom', since: now - 32 * 86400000, until: now }, { before: 'req1.e30' }]) await assert.rejects(readRequestDashboard(query, now));
});

test('cursor pagination has stable tie ordering and snapshot cutoff across appends; detail records omit payloads and redact errors', async () => {
  for (let i = 0; i < 4; i++) await appendUsage('g-1', row({ status: 'failure', httpStatus: 503, traceId: 'trace-1',
    prompt: 'DO_NOT_EXPOSE', messages: ['DO_NOT_EXPOSE'], endpoint: 'https://signed.example/private?token=secret', error: 'Bearer request-secret' }));
  const first = await readRequestDashboard({ limit: 2 }, now);
  await appendUsage('g-1', row({ time: now + 1 }));
  const second = await readRequestDashboard({ limit: 2, before: first.nextCursor }, now + 1000);
  assert.equal(second.range.asOf, now);
  assert.equal(new Set([...first.items, ...second.items].map(row => row.key)).size, 4);
  assert.equal(second.nextCursor, null);
  for (const secret of ['DO_NOT_EXPOSE', 'request-secret', 'signed.example']) assert.ok(!JSON.stringify(first).includes(secret));
});

test('failure reasons distinguish HTTP limits, auth, budget, overload, transport and unknown outcomes', () => {
  for (const [httpStatus, reason] of [[503, 'upstream_busy'], [429, 'rate_limited'], [401, 'auth_failed'], [402, 'balance_required'], [422, 'request_rejected'], [500, 'upstream_error']]) assert.equal(requestFailureReason({ status: 'failure', httpStatus }), reason);
  assert.equal(requestFailureReason({ status: 'failure', error: 'fetch failed' }), 'network_error');
  assert.equal(requestFailureReason({ status: 'interrupted' }), 'interrupted');
  assert.equal(requestFailureReason({ status: 'success', httpStatus: 200 }), null);
});

test('a late completion of an earlier request cannot change a pinned dashboard snapshot', async () => {
  await appendUsage('g-1', row({ finishedAt: now - 100 }));
  const first = await readRequestDashboard({}, now);
  await appendUsage('g-1', row({ finishedAt: now + 500 }));
  assert.equal((await readRequestDashboard({ asOf: first.range.asOf }, now + 1000)).totals.calls, 1);
  assert.equal((await readRequestDashboard({}, now + 1000)).totals.calls, 2);
  await appendUsage('g-1', row({ time: now - 100, elapsedMs: 2000 }));
  assert.equal((await readRequestDashboard({ asOf: now }, now + 1000)).totals.calls, 1, 'Legacy durations provide a completion estimate');
});

test('dashboard API is authenticated, serves its assets, propagates bad filters and never converts a broken ledger into zeros', async () => {
  const token = 'isolated-request-dashboard-admin-token';
  const admin = await startAdminServer({ port: 0, token, services: { readRequestDashboard: q => readRequestDashboard(q, now) } });
  const base = `http://127.0.0.1:${admin.port}`;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    assert.equal((await fetch(base + '/api/requests/dashboard')).status, 401);
    assert.equal((await fetch(base + '/api/requests/dashboard?kind=bad', { headers })).status, 400);
    assert.equal((await fetch(base + '/api/requests/dashboard', { headers })).status, 200);
    for (const path of ['/request-view.js', '/requests.css']) assert.equal((await fetch(base + path)).status, 200);
    await appendUsage('g-1', row());
    await writeFile(join(config.usageDir, 'g-1.jsonl'), '{broken');
    const response = await fetch(base + '/api/requests/dashboard', { headers });
    assert.equal(response.status, 503); assert.ok((await response.json()).error);
  } finally { await admin.close(); }
});

test('request views escape remote values, obey CSP, show data gaps and expose trace inspection only for associated records', async () => {
  await appendUsage('g-1', row({ model: '<script>bad</script>', status: 'failure', error: '<img src=x onerror=bad()>', traceId: 'trace-1' }));
  const result = await readRequestDashboard({}, now);
  for (const compact of [false, true]) {
    const html = renderRequestsView(result, {}, { compact });
    assert.ok(!html.includes('<script>bad</script>')); assert.ok(!/\sstyle=|\sonclick=/.test(html));
    assert.match(html, /历史在途峰值/); assert.match(html, /已知结果失败率/);
  }
  assert.match(renderRequestDetail(result.items[0]), /查看本轮业务链路/);
  assert.match(renderRequestDetail({ ...result.items[0], traceId: undefined }), /没有链路 ID/);
  const html = renderRequestTrace([{ time: new Date(now).toISOString(), event: 'reply.finished', outcome: 'unknown', data: { error: '<script>bad</script>' } }], null, 'trace-1');
  assert.match(html, /结果未知/); assert.ok(!html.includes('<script>bad</script>'));
});
