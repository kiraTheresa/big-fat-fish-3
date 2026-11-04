import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const dir = await mkdtemp(join(tmpdir(), 'fish-request-console-'));
Object.assign(process.env, { DATA_DIR: dir, USAGE_DIR: join(dir, 'usage'), PERSONA_DIR: join(dir, 'personas'),
  CONFIG_PATH: join(dir, 'none.json'), ADMIN_TOKEN: 'isolated-request-console-test-token', ADMIN_PORT: '0',
  DEEPSEEK_API_KEY: '', IMAGE_API_KEY: '', LOG_LEVEL: 'ERROR' });
const { startPlatform } = await import('../src/platform/runtime.js');
const { appendUsage } = await import('../src/store/usage-store.js');
const { logger } = await import('../src/utils/logger.js');
const { usageDayStart } = await import('../src/platform/usage-policy.js');
const platform = await startPlatform({ schedule: false });
const now = Date.now();
const start = Math.max(usageDayStart(now), now - 10 * 60000);
const base = { kind: 'chat', status: 'success', source: 'live', model: 'deepseek-flash', httpStatus: 200, elapsedMs: 1000 };
for (let i = 0; i < 25; i++) await appendUsage('g-100', { ...base, id: `attempt-${i}`, time: start + i });
for (let i = 0; i < 2; i++) await appendUsage('g-100', { ...base, id: `failed-${i}`, time: start + 100 + i, status: 'failure', httpStatus: 503, traceId: 'trace-ui', error: 'Upstream busy <script>bad</script>' });
await appendUsage('p-200', { ...base, time: start + 200, status: 'failure', httpStatus: undefined, error: 'fetch failed' });
await appendUsage('p-200', { ...base, time: start + 201, status: undefined, source: undefined, elapsedMs: undefined });
await appendUsage('p-200', { ...base, time: start + 202, status: 'interrupted', elapsedMs: 999999 });
for (const [kind, source, session] of [['vision', 'test', 'p-200'], ['distill', 'scheduled', 'g-100']]) {
  for (let i = 0; i < 2; i++) await appendUsage(session, { ...base, kind, source, time: start + 300 + i });
}
await appendUsage('g-100', { ...base, kind: 'draw', time: start + 400, elapsedMs: 10000 });
await appendUsage('g-100', { ...base, time: usageDayStart(now) - 60000 });
logger.event('handler.started', { traceId: 'trace-ui', source: 'live' });
for (let i = 0; i < 101; i++) logger.event('tool.started', { traceId: 'trace-ui', operationId: `tool-${i}`, source: 'live' });
logger.event('model.request.finished', { traceId: 'trace-ui', source: 'live', outcome: 'failed', data: { httpStatus: 503 } });
logger.event('reply.finished', { traceId: 'trace-ui', source: 'live', outcome: 'confirmed' });
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const screenshotDir = process.env.SCREENSHOT_DIR;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  const shot = async name => { if (screenshotDir) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true }); } };
  await page.goto(`http://127.0.0.1:${platform.management.port}/#requests`);
  await page.locator('#admin-token').fill(process.env.ADMIN_TOKEN);
  await page.locator('.login-submit').click();
  await page.waitForSelector('.request-summary');
  assert.match(await page.locator('.request-stat').first().innerText(), /35/);
  assert.equal(await page.locator('.request-ledger tbody tr').count(), 20);
  await shot('requests-desktop');
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'requests-viewport.png') });
  await page.locator('[data-action="next-page"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.request-ledger tbody tr').length === 15);
  assert.match(await page.locator('.request-stat').first().innerText(), /35/);
  await page.locator('[data-action="first-page"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.request-ledger tbody tr').length === 20);
  await page.locator('[data-action="request-reason"][data-reason="upstream_busy"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.request-ledger tbody tr').length === 2);
  assert.match(await page.locator('.request-stat').first().innerText(), /35/);
  await page.locator('[data-action="request-detail"]').first().click();
  assert.equal(await page.locator('#detail-dialog').isVisible(), true);
  assert.match(await page.locator('#dialog-content').innerText(), /Upstream busy/);
  assert.equal(await page.locator('#dialog-content script').count(), 0);
  await page.locator('[data-action="request-trace"]').click();
  await page.waitForSelector('.request-trace');
  assert.match(await page.locator('.request-trace').innerText(), /平台已确认/);
  await page.locator('[data-action="request-trace-more"]').click();
  await page.waitForFunction(() => document.querySelector('.request-trace').textContent.includes('处理器开始'));
  assert.equal(await page.locator('#detail-dialog').evaluate(el => el.scrollTop), 0);
  await shot('requests-trace');
  await page.keyboard.press('Escape');
  await page.locator('[data-action="request-reset"]').click();
  await page.waitForSelector('.request-summary');
  await page.locator('[data-action="request-failures"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.request-ledger tbody tr').length === 4);
  const [unfiltered] = await Promise.all([
    page.waitForRequest(req => req.url().includes('/api/requests/dashboard') && !new URL(req.url()).searchParams.has('failedOnly')),
    page.locator('[data-action="request-failures"]').click(),
  ]);
  assert.equal(new URL(unfiltered.url()).searchParams.has('asOf'), false, 'Clearing anomalies resumes fresh snapshots');
  await page.waitForFunction(() => document.querySelectorAll('.request-ledger tbody tr').length === 20);
  await page.locator('[data-action="request-session"][data-session="p-200"]').click();
  await page.waitForFunction(() => document.querySelector('.request-stat strong')?.textContent.trim() === '5次');
  await page.locator('[data-action="request-reset"]').click();
  await page.waitForSelector('.request-summary');
  await page.locator('#requests-filter select[name="source"]').selectOption('test');
  await page.locator('#requests-filter button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('.request-stat strong')?.textContent.trim() === '2次');
  await page.locator('#requests-filter select[name="kind"]').selectOption('draw');
  await page.locator('#requests-filter button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('.request-stat strong')?.textContent.trim() === '0次');
  assert.match(await page.locator('.request-ledger').innerText(), /暂无请求/);
  await page.locator('[data-action="request-reset"]').click();
  await page.locator('[data-action="request-period"][data-period="yesterday"]').click();
  await page.waitForFunction(() => document.querySelector('.request-stat strong')?.textContent.trim() === '1次');
  await page.locator('[data-action="request-period"][data-period="7d"]').click();
  await page.waitForFunction(() => document.querySelector('.request-stat strong')?.textContent.trim() === '36次');
  await page.locator('[data-action="request-period"][data-period="custom"]').click();
  const yesterday = new Date(usageDayStart(now) - 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  await page.locator('#requests-filter input[name="since"]').fill(yesterday);
  await page.locator('#requests-filter input[name="until"]').fill(yesterday);
  await page.locator('#requests-filter button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('.request-stat strong')?.textContent.trim() === '1次');
  await page.locator('[data-action="request-reset"]').click();
  await page.waitForFunction(() => document.querySelector('.request-stat strong')?.textContent.trim() === '35次');
  await page.locator('.request-chart-bar[aria-label*="35 次"]').click();
  await page.waitForSelector('.request-detail-scope');
  await page.locator('[data-action="request-clear-detail"]').click();
  await page.waitForFunction(() => !document.querySelector('.request-detail-scope'));
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.reload(); await page.waitForSelector('.request-summary');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px page overflow`);
    await shot(`requests-${width}`);
  }
  const file = join(dir, 'usage', 'g-100.jsonl');
  const original = await readFile(file, 'utf8');
  await writeFile(file, '{broken');
  await page.locator('#refresh').click();
  await page.waitForSelector('.error-state');
  assert.equal(await page.locator('.request-summary').count(), 0);
  await writeFile(file, original);
  await page.locator('[data-action="retry"]').click();
  await page.waitForSelector('.request-summary');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', checks: ['real dashboard API', 'login', 'scope/session filters', 'pagination with full summaries', 'failure drilldown and reset', 'call detail', 'trace pagination', 'date presets and custom dates', 'chart drilldown', 'empty state', '320/390/768/1440px overflow', 'ledger failure and recovery', 'no page errors'] }));
} finally { await browser?.close(); await platform.stop(); await rm(dir, { recursive: true, force: true }); }
