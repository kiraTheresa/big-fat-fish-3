import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMG_BYTES } from './image-server.js';
import { renderUsageShareContent } from '../web/usage-view.js';

const root = await mkdtemp(join(tmpdir(), 'fish-image-pricing-'));
Object.assign(process.env, { DATA_DIR: join(root, 'data'), USAGE_DIR: join(root, 'usage'), CONFIG_PATH: join(root, 'none.json'),
  IMAGE_API_BASE_URL: 'https://api2.laozhang.ai/v1', IMAGE_MODEL: 'gpt-image-2.5-flare-vip', IMAGE_API_KEY: 'test-only-key' });
const { config } = await import('../src/config.js');
const { snapshotUsagePrice, estimateUsageCost } = await import('../src/usage/pricing.js');
const { appendUsage, readUsageOverview } = await import('../src/store/usage-store.js');
const { beginUsage, finishUsage, setUsagePolicy } = await import('../src/platform/usage-policy.js');
const { readUsageDashboard } = await import('../src/usage/overview.js');
const { generateImage } = await import('../src/imagegen.js');
const now = Date.parse('2026-11-13T11:26:00+08:00');
const nativeFetch = globalThis.fetch;
const tariff = extra => snapshotUsagePrice({ kind: 'draw', model: 'gpt-image-2.5-flare-vip', baseUrl: 'https://api2.laozhang.ai/v1', time: now, ...extra });
const row = extra => ({ time: now, kind: 'draw', model: 'gpt-image-2.5-flare-vip', status: 'success',
  httpStatus: 200, images: 1, imageResponseComplete: true, usageKnown: false, pricing: tariff(), ...extra });
let index = 0;
beforeEach(t => { config.usageDir = join(root, `ledger-${index++}`); setUsagePolicy({}); t.mock.timers.enable({ apis: ['Date'], now }); });
afterEach(() => { globalThis.fetch = nativeFetch; });
after(async () => { await rm(root, { recursive: true, force: true }); });

test('only verified LaoZhang VIP models and endpoints receive the fixed CNY per-call tariff', () => {
  for (const host of ['api.laozhang.ai', 'api2.laozhang.ai']) {
    for (const path of ['', '/', '/v1', '/v1/']) {
      const price = tariff({ baseUrl: `https://${host}${path}` });
      assert.equal(price.callUsd, 0.03);
      assert.equal(price.usdCny, 6.7);
      assert.equal(price.callNano, 201000000);
      assert.equal(price.unit, 'call');
    }
  }
  assert.equal(tariff({ model: 'gpt-image-2.5-sunburst-vip' }).status, 'available');
  for (const baseUrl of ['http://api2.laozhang.ai/v1', 'https://api.laozhang.ai.evil.test/v1', 'https://proxy.test/v1',
    'https://api2.laozhang.ai/custom', 'https://key@api2.laozhang.ai/v1', 'https://api2.laozhang.ai/v1?key=secret', 'https://api2.laozhang.ai/v1#x']) {
    assert.equal(tariff({ baseUrl }).status, 'pending', baseUrl);
  }
  for (const model of ['gpt-image-2.5-flare', 'gpt-image-2-vip', 'deepseek-flash']) assert.equal(tariff({ model }).status, 'pending');
  assert.equal(tariff({ time: Date.parse('2026-11-12T23:59:59+08:00') }).status, 'pending');
  assert.equal(tariff({ time: NaN }).status, 'pending');
});

test('bill once per returned request; explicit errors are zero and incomplete outcomes remain pending', () => {
  for (const images of [1, 3]) assert.deepEqual(estimateUsageCost(row({ images })), { status: 'estimated', costNano: 201000000 });
  assert.equal(estimateUsageCost(row({ status: 'failure' })).costNano, 201000000, 'Delivery failure cannot erase generation fees');
  assert.equal(estimateUsageCost(row({ images: 0 })).costNano, 0);
  for (const httpStatus of [400, 401, 429, 451, 500, 503]) {
    assert.equal(estimateUsageCost(row({ status: 'failure', httpStatus, images: 0, imageResponseComplete: false })).costNano, 0);
  }
  for (const extra of [{ httpStatus: undefined }, { imageResponseComplete: false }, { imageResponseComplete: undefined },
    { images: NaN }, { images: -1 }, { status: 'interrupted', httpStatus: undefined, images: 0 }, { pricing: undefined },
    { pricing: { status: 'pending', reason: '绘图服务尚未配置价目' } }, { model: 'unknown' }]) {
    assert.equal(estimateUsageCost(row(extra)).status, 'pending');
  }
  for (const callNano of [-1, 0, NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(estimateUsageCost(row({ pricing: { ...tariff(), callNano } })).status, 'pending');
  }
});

test('real image gateway records generation evidence without usage, including download, response and storage failures', async () => {
  const b64 = IMG_BYTES.toString('base64');
  const cases = [
    { name: 'success', data: { data: [{ b64_json: b64 }] }, cost: 201000000, images: 1 },
    { name: 'multi', data: { data: [{ b64_json: b64 }, { b64_json: b64 }], usage: { input_tokens: 100, output_tokens: 200 } }, cost: 201000000, images: 2 },
    { name: 'empty', data: { data: [] }, error: /缺少/, cost: 0 },
    { name: 'upstream', status: 503, data: { error: 'busy' }, error: /503/, cost: 0 },
    { name: 'moderation', status: 451, data: { error: 'blocked' }, error: /451/, cost: 0 },
    { name: 'truncated', raw: '{', error: /JSON/, pending: true },
    { name: 'invalid-shape', data: null, error: /缺少/, pending: true },
    { name: 'timeout', timeout: true, error: /timeout/, pending: true },
    { name: 'download', data: { data: [{ url: 'https://image.invalid/image.png' }] }, error: /下载失败/, cost: 201000000, images: 1 },
  ];
  for (const scenario of cases) {
    globalThis.fetch = async url => {
      if (url === 'https://image.invalid/image.png') return new Response('', { status: 404 });
      assert.equal(url, 'https://api2.laozhang.ai/v1/images/generations');
      if (scenario.timeout) throw new DOMException('timeout', 'TimeoutError');
      return new Response(scenario.raw ?? JSON.stringify(scenario.data), { status: scenario.status ?? 200 });
    };
    const sessionKey = `g-${scenario.name}`;
    if (scenario.error) await assert.rejects(generateImage('test', { sessionKey }), scenario.error);
    else await generateImage('test', { sessionKey });
    const result = await readUsageOverview({ sessionKey, includeCost: true });
    assert.equal(result.totals.calls, 1, scenario.name);
    assert.equal(result.totals.images, scenario.images ?? 0, scenario.name);
    assert.equal(result.totals.pendingCostCalls, scenario.pending ? 1 : 0, scenario.name);
    if (!scenario.pending) assert.equal(result.totals.costNano, scenario.cost, scenario.name);
    const ledger = await readFile(join(config.usageDir, sessionKey + '.jsonl'), 'utf8');
    assert.ok(!ledger.includes('test-only-key') && !ledger.includes(b64) && !ledger.includes('image.invalid'));
  }
  const dataDir = config.dataDir;
  const blocker = join(root, 'blocked');
  await writeFile(blocker, 'not a directory');
  config.dataDir = blocker;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: b64 }] }));
  try {
    assert.equal((await generateImage('test', { sessionKey: 'g-storage' })).asset, null);
    assert.equal((await readUsageOverview({ sessionKey: 'g-storage', includeCost: true })).totals.costNano, 201000000);
  } finally { config.dataDir = dataDir; }
});

test('persisted price snapshots survive configuration changes; all summaries and shared report include image costs', async () => {
  const attempt = await beginUsage({ kind: 'draw', model: config.imageModel, sessionKey: 'g-one' });
  const savedPrice = structuredClone(attempt.pricing);
  const baseUrl = config.imageApiBaseUrl;
  config.imageApiBaseUrl = 'https://other.invalid/v1';
  try { await finishUsage(attempt, { httpStatus: 200, images: 1, imageResponseComplete: true }); }
  finally { config.imageApiBaseUrl = baseUrl; }
  await appendUsage('g-one', row({ pricing: { ...tariff(), callNano: 100000000, callUsd: 0.02, usdCny: 5 } }));
  await appendUsage('p-two', row());
  await appendUsage('g-one', row({ pricing: undefined }));
  await appendUsage('g-one', row({ httpStatus: undefined, imageResponseComplete: false, images: 0, status: 'interrupted' }));
  const result = await readUsageDashboard({ limit: 1 }, now);
  assert.equal(result.totals.calls, 5);
  assert.equal(result.totals.costNano, 502000000);
  assert.equal(result.totals.pricedCalls, 3);
  assert.equal(result.totals.pendingCostCalls, 2);
  assert.equal(result.pricing.image.usdCny, 6.7);
  for (const key of ['byKind', 'byTime', 'bySession']) assert.equal(result[key].reduce((sum, x) => sum + x.costNano, 0), 502000000, key);
  const session = await readUsageDashboard({ sessionKey: 'g-one' }, now);
  assert.equal(session.totals.costNano, 301000000);
  const persisted = JSON.parse((await readFile(join(config.usageDir, 'g-one.jsonl'), 'utf8')).split('\n')[0]);
  assert.deepEqual(persisted.pricing, savedPrice);
  const html = renderUsageShareContent(result, { capture: true });
  assert.match(html, /¥0\.50/);
  assert.match(html, /绘图/);
  assert.match(html, /2 次费用待确认/);
  assert.ok(!html.includes('g-one') && !html.includes('p-two'));
});
