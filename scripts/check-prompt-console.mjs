import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
// Optional browser check: provide PLAYWRIGHT_MODULE and CHROME_EXECUTABLE when not installed locally.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const dir = await mkdtemp(join(tmpdir(), 'fish-prompt-ui-'));
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const request = JSON.parse(raw);
  const message = request.messages.at(-1).role === 'tool' ? { role: 'assistant', content: '记住啦，测试记忆已保存。' } : { role: 'assistant', content: null, tool_calls: [{ id: `call-${Date.now()}`, type: 'function', function: { name: 'remember_fact', arguments: '{"content":"不吃香菜"}' } }] };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 12 } }));
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, { DATA_DIR: dir, PERSONA_DIR: join(dir, 'personas'), USAGE_DIR: join(dir, 'usage'), DEEPSEEK_API_KEY: 'isolated-ui-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.address().port}`, ADMIN_TOKEN: 'isolated-console-test-token', ADMIN_PORT: '0', IMAGE_API_KEY: '' });
const { startPlatform } = await import('../src/platform/runtime.js');
const platform = await startPlatform({ schedule: false });
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const screenshotDir = process.env.SCREENSHOT_DIR;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  const screenshot = async (name) => {
    if (!screenshotDir) return;
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true });
  };
  const assertNoPanelScroll = async () => {
    const panels = page.locator('.pp-cards-view:visible, .pp-json-view:visible, .pp-test');
    const overflowing = await panels.evaluateAll((nodes) => nodes.filter((node) => node.scrollHeight > node.clientHeight + 1).map((node) => node.className));
    assert.deepEqual(overflowing, [], 'Prompt panels should expand with their content');
  };
  await page.goto(`http://127.0.0.1:${platform.management.port}/#prompt`);
  await screenshot('login');
  await page.locator('#admin-token').fill('isolated-console-test-token');
  await page.locator('.login-submit').click();
  await page.waitForSelector('#pp-request-blocks .pp-budget', { state: 'attached' });
  await screenshot('prompt-desktop');
  await page.locator('.pp-delivery > summary').click();
  assert.match(await page.locator('#pp-publish-reason').innerText(), /聊天测试/);
  await page.locator('#pp-edit').click();
  const seed = page.locator('[data-pp-field="prompts.seed"]');
  await seed.fill('# 大肥鱼\n一条喜欢海洋、简短说话的鱼。');
  await page.waitForTimeout(600);
  assert.equal(await page.locator('#pp-test').isDisabled(), true);
  await page.locator('#pp-save').click();
  await page.waitForFunction(() => !document.querySelector('#pp-test').disabled);
  await page.locator('#pp-test').click();
  await page.waitForSelector('[data-pp-action="pass"]');
  assert.match(await page.locator('#pp-result').innerText(), /记住啦/);
  await page.locator('[data-pp-action="pass"]').click();
  await page.waitForFunction(() => !document.querySelector('#pp-publish').disabled);
  assert.match(await page.locator('#pp-publish-reason').innerText(), /已满足/);
  await page.locator('#pp-note').fill('隔离实例端到端测试');
  await page.locator('#pp-publish').click();
  await page.waitForFunction(() => document.querySelector('.pp-page-controls').textContent.includes('v1'));
  await page.waitForFunction(() => !document.querySelector('#pp-test').disabled);
  await page.locator('#pp-edit').click();
  await page.locator('[data-pp-field="context.historyLimit"]').fill('8');
  await page.waitForTimeout(600);
  assert.equal(await page.locator('#pp-publish').isDisabled(), true);
  await page.locator('#pp-save').click();
  await page.waitForFunction(() => !document.querySelector('#pp-test').disabled);
  await page.locator('.pp-test > .pp-advanced > summary').first().click();
  await page.locator('#pp-compare').click();
  await page.waitForFunction(() => document.querySelectorAll('.pp-run').length === 2 && !document.querySelector('#pp-test').disabled);
  assert.equal(await page.locator('[data-pp-action="pass"]').count(), 1);
  await assertNoPanelScroll();
  await page.locator('#pp-edit').click();
  assert.equal(await page.locator('[data-pp-field="tools.draw.enabled"]').isChecked(), true);
  await page.waitForFunction(() => document.querySelector('[data-pp-tool-status="draw"]').textContent.includes('未配置'));
  await page.locator('[data-pp-field="tools.remember_fact.enabled"]').uncheck();
  await page.waitForTimeout(650);
  const preview = JSON.parse(await page.locator('#pp-request-json').inputValue());
  assert.ok(!preview.tools.some((t) => t.function.name === 'remember_fact'));
  assert.equal(await page.locator('#pp-test').isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoPanelScroll();
  await page.locator('[data-pp-view="json"]').click();
  await assertNoPanelScroll();
  await page.locator('[data-pp-view="cards"]').click();
  await page.locator('[data-pp-jump="test"]').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pp-test-stage');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await screenshot('prompt-mobile');
  // Discard only the isolated test draft when navigating to the other pages.
  page.on('dialog', (dialog) => dialog.accept());
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const name of ['overview', 'logs', 'usage', 'config', 'jobs', 'users']) {
      if (name === 'logs') await page.locator('#section-navigation [data-page="requests"]').click();
      const nav = name === 'logs' ? '#diagnostic-navigation' : ['overview', 'config'].includes(name) ? '#navigation' : '#section-navigation';
      await page.locator(`${nav} [data-page="${name}"]`).click();
      await page.waitForFunction(() => document.querySelector('#content').getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('.error-state').count(), 0, name);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} at ${width}px`);
      await screenshot(`${name}-${width}`);
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', checked: ['login', 'workflow navigation', 'publish requirements', 'draft save', 'tools trace', 'manual review', 'publish', 'same snapshot compare', 'edit invalidates pass', 'tool preview', 'all pages desktop/mobile overflow'], pageErrors: errors }));
} finally {
  await browser?.close(); await platform.stop(); mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve)); await rm(dir, { recursive: true, force: true });
}
