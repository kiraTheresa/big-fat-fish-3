import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'fish-usage-dashboard-'));
Object.assign(process.env, { DATA_DIR: root, USAGE_DIR: join(root, 'usage'), CONFIG_PATH: join(root, 'none.json') });
const { config } = await import('../src/config.js');
const { snapshotUsagePrice, estimateUsageCost } = await import('../src/usage/pricing.js');
const { readUsageDashboard } = await import('../src/usage/overview.js');
const { appendUsage, readUsageOverview } = await import('../src/store/usage-store.js');
const { beginUsage, finishUsage, setUsagePolicy } = await import('../src/platform/usage-policy.js');
const { chatCompletion } = await import('../src/llm.js');
const { generateImage } = await import('../src/imagegen.js');
let index = 0;
const nativeFetch = globalThis.fetch;
beforeEach(() => { config.usageDir = join(root, `ledger-${index++}`); setUsagePolicy({}); globalThis.fetch = nativeFetch; });
after(async () => { globalThis.fetch = nativeFetch; await rm(root, { recursive: true, force: true }); });
const ms = text => Date.parse(text + '+08:00');
const now = ms('2026-11-04T11:26:00');
const price = (time = now, extra = {}) => snapshotUsagePrice({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', kind: 'chat', time, ...extra });
const row = (extra = {}) => ({ time: now - 60000, kind: 'chat', model: 'deepseek-flash', status: 'success', usageKnown: true,
  prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, pricing: price(), ...extra });

test('official tariff handles Shanghai peak boundaries, weekends, aliases and Pro; unknown providers/dates stay unpriced', () => {
  assert.equal(price(ms('2026-11-04T08:59:59')).band, 'off-peak');
  assert.equal(price(ms('2026-11-04T09:00:00')).band, 'peak');
  assert.equal(price(ms('2026-11-04T11:59:59')).outputNano, 8000);
  assert.equal(price(ms('2026-11-04T12:00:00')).outputNano, 4000);
  assert.equal(price(ms('2026-11-04T14:00:00')).inputNano, 2000);
  assert.equal(price(ms('2026-11-04T18:00:00')).inputNano, 1000);
  assert.equal(price(ms('2026-11-07T10:00:00')).band, 'off-peak');
  assert.equal(price(now, { model: 'deepseek-v4-flash' }).modelTier, 'flash');
  assert.equal(price(now, { model: 'deepseek-v4-pro' }).outputNano, 27000);
  for (const baseUrl of ['https://proxy.example/v1', 'https://api.deepseek.com.evil.example', 'http://api.deepseek.com', 'https://api.deepseek.com/custom', 'https://api.deepseek.com/?key=secret']) assert.equal(price(now, { baseUrl }).status, 'pending');
  assert.equal(price(now, { kind: 'draw' }).status, 'pending');
  assert.equal(price(now, { model: 'other-model' }).status, 'pending');
  assert.equal(price(ms('2026-11-03T10:00:00')).status, 'pending');
  assert.equal(price(ms('2027-01-01T10:00:00')).status, 'pending');
});

test('cost uses integer nanoyuan; failed attempts with usage cost money; unknown/inconsistent splits never become free', () => {
  assert.deepEqual(estimateUsageCost(row()), { status: 'estimated', costNano: 1232000 });
  assert.deepEqual(estimateUsageCost(row({ status: 'failure' })), { status: 'estimated', costNano: 1232000 });
  assert.equal(estimateUsageCost(row({ responseModel: 'DeepSeek-V4.1-Flash-1017' })).status, 'estimated');
  for (const extra of [{ pricing: undefined }, { prompt_cache_hit_tokens: undefined }, { prompt_tokens: undefined }, { completion_tokens: undefined }, { usageKnown: false }, { prompt_cache_hit_tokens: 1001 }, { prompt_cache_miss_tokens: 199 }, { total_tokens: 999 }, { responseModel: 'DeepSeek-V4-Pro-0813' }]) assert.equal(estimateUsageCost(row(extra)).status, 'pending');
  assert.deepEqual(estimateUsageCost(row({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 })), { status: 'estimated', costNano: 0 });
});

test('summaries, hourly buckets and session/kind costs agree across more records than the item limit', async () => {
  for (let i = 0; i < 205; i++) await appendUsage(i % 2 ? 'g-1' : 'p-2', row({ kind: i % 3 ? 'chat' : 'distill' }));
  await appendUsage('g-1', row({ time: ms('2026-11-03T11:25:00') }));
  await appendUsage('g-1', row({ time: ms('2026-11-03T11:27:00') }));
  await appendUsage('g-1', { time: now, kind: 'draw', images: 1, pricing: price(now, { kind: 'draw' }) });
  const dashboard = await readUsageDashboard({ limit: 2 }, now);
  assert.equal(dashboard.items.length, 2);
  assert.equal(dashboard.itemCount, 206);
  assert.equal(dashboard.totals.calls, 206);
  assert.equal(dashboard.totals.costNano, 205 * 1232000);
  assert.equal(dashboard.totals.pendingCostCalls, 1);
  assert.equal(dashboard.totals.cacheHitTokens, 205 * 800);
  assert.equal(dashboard.previous.calls, 1, 'Compare the previous day only through 11:26');
  assert.equal(dashboard.byTime.length, 12);
  for (const key of ['byKind', 'bySession', 'byTime']) assert.equal(dashboard[key].reduce((sum, entry) => sum + entry.costNano, 0), dashboard.totals.costNano, key);
  assert.equal((await readUsageDashboard({ sessionKey: 'p-2' }, now)).totals.calls, 103);
  const filtered = await readUsageDashboard({ detailKind: 'draw', pendingOnly: true }, now);
  assert.equal(filtered.totals.calls, 206, 'Detail filters do not change the summary');
  assert.equal(filtered.itemCount, 1);
  assert.equal(filtered.items[0].kind, 'draw');
  assert.equal((await readUsageOverview()).totals.calls, 208, 'Legacy aggregate contract remains available');
});

test('range filters reset at Shanghai midnight and custom dates are bounded and validated', async () => {
  await appendUsage('g-1', row({ time: ms('2026-11-03T23:59:59.999') }));
  await appendUsage('g-1', row({ time: ms('2026-11-04T00:00:00') }));
  assert.equal((await readUsageDashboard({}, now)).totals.calls, 1);
  assert.equal((await readUsageDashboard({ period: '7d' }, now)).byTime.length, 7);
  assert.equal((await readUsageDashboard({ period: '30d' }, now)).byTime.length, 30);
  const custom = await readUsageDashboard({ period: 'custom', since: ms('2026-11-03T00:00:00'), until: now }, now);
  assert.equal(custom.totals.calls, 2);
  assert.equal(custom.byTime.length, 2);
  for (const query of [{ period: '../file' }, { period: 'custom' }, { period: 'custom', since: now + 86400000, until: now }, { period: 'custom', since: 1, until: now }, { sessionKey: '../secret' }, { detailKind: '<script>' }, { pendingOnly: 'whatever' }]) await assert.rejects(readUsageDashboard(query, now));
});

test('historical records are pending, empty data is zero, missing usage is unknown, and corrupt ledgers fail closed', async () => {
  const empty = await readUsageDashboard({}, now);
  assert.equal(empty.totals.calls, 0);
  assert.equal(empty.totals.costNano, 0);
  await appendUsage('g-1', { time: now, total_tokens: 9 });
  await appendUsage('g-1', { time: now, kind: 'chat', usageKnown: false, pricing: price() });
  const result = await readUsageDashboard({}, now);
  assert.equal(result.totals.pricedCalls, 0);
  assert.equal(result.totals.pendingCostCalls, 2);
  assert.equal(result.totals.unknownUsageCalls, 1);
  assert.equal(result.pendingReasons.length, 2);
  await writeFile(join(config.usageDir, 'g-1.jsonl'), '{broken');
  await assert.rejects(readUsageDashboard({}, now), { code: 'USAGE_LEDGER_CORRUPT' });
});

test('price snapshots and cache splits survive persistence; gateways preserve failure usage without leaking base URL credentials', async () => {
  const attempt = await beginUsage({ sessionKey: 'g-1', kind: 'chat', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' });
  const saved = await finishUsage(attempt, { responseModel: 'DeepSeek-V4.1-Flash-1017', usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 } });
  assert.equal(saved.pricing.version, 'deepseek-cny-2026-11-04');
  assert.equal(saved.prompt_cache_miss_tokens, 200);
  assert.equal((await readFile(join(config.usageDir, 'g-1.jsonl'), 'utf8')).includes('https://'), false);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'failed' }, usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 0 } }), { status: 500 });
  await assert.rejects(chatCompletion([], { sessionKey: 'g-failed' }), /HTTP 500/);
  const failed = await readUsageOverview({ sessionKey: 'g-failed', includeCost: true });
  assert.equal(failed.totals.failures, 1);
  assert.equal(failed.totals.totalTokens, 12);
  assert.equal(failed.totals.pricedCalls, 1);
});

test('streamed response models reach the ledger; a different model tier stays unpriced, and image failures retain returned usage', async () => {
  globalThis.fetch = async () => new Response('data: '+JSON.stringify({ model:'DeepSeek-V4-Pro-0813',choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,prompt_cache_hit_tokens:0} })+'\n\ndata: [DONE]\n\n', { headers:{'Content-Type':'text/event-stream'} });
  await chatCompletion([], {sessionKey:'g-stream',stream:true});
  const stream=await readUsageOverview({sessionKey:'g-stream',includeCost:true});
  assert.equal(stream.items[0].responseModel,'DeepSeek-V4-Pro-0813');
  assert.equal(stream.totals.pricedCalls,0);
  assert.match(stream.items[0].cost.reason,/返回模型/);
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'failed'},usage:{input_tokens:4,output_tokens:1}}),{status:500});
  await assert.rejects(generateImage('test',{sessionKey:'g-image-failed'}),/HTTP 500/);
  const image=await readUsageOverview({sessionKey:'g-image-failed',includeCost:true});
  assert.equal(image.totals.totalTokens,5);
  assert.equal(image.totals.failures,1);
  assert.equal(image.totals.pendingCostCalls,1);
});
