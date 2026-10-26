// These are VM-level UI checks with explicit API fixtures, not browser acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

function harness(responder = () => ({})) {
  const nodes = new Map();
  const calls = [];
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      innerHTML: '', textContent: '', hidden: false, value: '', disabled: false, open: false, name: '',
      classList: { toggle() {} }, addEventListener() {}, setAttribute() {}, removeAttribute() {},
      focus() {}, contains() { return false; }, close() { this.open = false; }, showModal() { this.open = true; },
    });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: node, querySelectorAll() { return []; }, addEventListener() {}, title: '' },
    window: { addEventListener() {}, confirm() { return true; } },
    location: { hash: '' }, history: { replaceState() {} },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    AbortSignal, URLSearchParams, Intl, structuredClone,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const response = await responder(url, options);
      return { ok: (response.status ?? 200) < 400, status: response.status ?? 200, json: async () => response.body ?? response };
    },
  });
  vm.runInContext(source, context);
  const run = (expression) => vm.runInContext(expression, context);
  run("state.token='ephemeral-test-token'; state.sequence=1");
  return { run, nodes, node, context, calls };
}

function fixtures() {
  return {
    '/api/status': { startedAt: Date.now(), uptimeSeconds: 61, connection: { connected: false }, scheduler: { running: true, jobs: 2 }, usage: { today: { calls: 17, totalTokens: 123, unknownUsageCalls: 1 }, resetAt: Date.now(), ledgerAvailable: true }, storage: { dataDir: 'data' }, logStats: { written: 4 } },
    '/api/events': { items: [{ id: 'safe', receivedAt: Date.now(), postType: 'message', sessionKey: 'g-1', handling: 'blocked', event: { message_type: 'group', sender: { nickname: '<img src=x onerror=alert(1)>' }, message: [null, { type: 'text', data: { text: '<script>bad</script>' } }, { type: 'future_segment' }] } }], nextCursor: 'next' },
    '/api/config': { revision: 'revision-1', behavior: { reply: { split: { separator: '\n' } } }, policy: {}, connection: {}, capabilities: {} },
    '/api/users': { items: [{ id: '123', role: 'blocked', source: 'management', note: '<script>bad</script>' }], defaults: { draw: 'allow' } },
    '/api/jobs': { items: [{ id: 'job-1', name: '维护', type: 'maintenance', schedule: { kind: 'interval', everyMs: 1500 }, enabled: true, lastStatus: 'interrupted' }] },
    '/api/logs': { items: [{ time: Date.now(), level: 'WARN', message: '<script>bad</script>' }], nextCursor: null },
    '/api/usage': { totals: { calls: 1, failures: 1, unknownUsageCalls: 1 }, byKind: [{ kind: 'draw', calls: 1 }], bySession: [{ sessionKey: 'g-1', calls: 1 }], items: [{ time: Date.now(), kind: 'draw', status: 'failure' }] },
  };
}

test('七个页面使用真实契约渲染：转义不可信文本、容忍畸形消息段、区分失败和未知用量', async () => {
  const data = fixtures();
  const ui = harness((url) => data[url.split('?')[0]]);
  for (const page of ['overview', 'events', 'config', 'users', 'jobs', 'logs', 'usage']) {
    const html = await ui.run(`renderers.${page}(1)`);
    assert.ok(typeof html === 'string' && html.length > 100, page);
    assert.ok(!html.includes('<script>bad</script>'), `${page} must escape data`);
    assert.ok(!/\sstyle=|\sonclick=/.test(html), `${page} must work with CSP self`);
    if (page === 'overview') { assert.match(html, /今日调用/); assert.match(html, />17</); }
    if (page === 'events') { assert.match(html, /&lt;img/); assert.match(html, /future_segment/); assert.match(html, /已封禁，未处理/); }
    if (page === 'config') { assert.match(html, /<textarea id="separator"[^>]*>\n\n<\/textarea>/); assert.doesNotMatch(html, /id="separator"[^>]*required/); }
    if (page === 'jobs') { assert.match(html, /1.5 秒/); assert.match(html, /已中断/); }
    if (page === 'usage') { assert.match(html, /失败/); assert.match(html, /未返回/); }
  }
  assert.equal(ui.run("eventInfo({event:{message:[null,false,5,{type:'text',data:{text:42}}]}}).text"), '');
});

test('用量账本不可读时展示不可用，不把未知的今日统计显示成零', async () => {
  const data = fixtures();
  data['/api/status'].usage = { today: null, ledgerAvailable: false, lastPersistenceError: '账本不可读' };
  const ui = harness((url) => data[url.split('?')[0]]);
  const html = await ui.run('renderOverview(1)');
  assert.match(html, /账本不可读/);
  assert.match(html, /今日调用[\s\S]*?metric-value">不可用/);
  assert.match(html, /今日 Token[\s\S]*?metric-value">不可用/);
  assert.match(html, /今日失败调用<\/dt><dd>不可用/);
  assert.match(html, /今日生成图片<\/dt><dd>不可用/);
});

test('旧页面的慢响应不会覆盖新页面正在使用的记录', async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const ui = harness(async () => { await pending; return { items: [{ id: 'old-row' }] }; });
  const oldRender = ui.run('renderEvents(1)');
  ui.run("state.sequence=2; state.rows=[{id:'current-row'}]");
  finish();
  assert.equal(await oldRender, '');
  assert.equal(ui.run('state.rows[0].id'), 'current-row');
});

test('仅当前令牌的 401 才退出；令牌在 Authorization 头中，不进入 URL', async () => {
  const ui = harness(() => ({ status: 401, body: { error: 'unauthorized' } }));
  ui.run("state.token='new-token'");
  await assert.rejects(ui.run("api('/status',{token:'old-token'})"), /令牌/);
  assert.equal(ui.run('state.token'), 'new-token');
  await assert.rejects(ui.run("api('/status')"), /令牌/);
  assert.equal(ui.run('state.token'), '');
  assert.equal(ui.node('#app').hidden, true);
  assert.equal(ui.node('#login').hidden, false);
  assert.equal(ui.calls[0].url, '/api/status');
  assert.equal(ui.calls[0].options.headers.Authorization, 'Bearer old-token');
  assert.equal(ui.calls[0].options.cache, 'no-store');
});

test('任务运行冲突保留服务端原因，不误报为配置版本冲突', async () => {
  const ui = harness(() => ({ status: 409, body: { error: '任务正在执行，请完成后修改' } }));
  await assert.rejects(ui.run("api('/jobs/job-1',{method:'PUT',body:{}})"), /任务正在执行/);
});

test('配置保存期间锁定控件并防重复提交；409 后保留编辑值并恢复控件', async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const ui = harness(async () => { await pending; return { status: 409, body: { error: 'stale' } }; });
  const fields = [
    { name: 'behavior.reply.delay.minMs', type: 'number', value: '2000', disabled: false },
    { name: 'behavior.reply.delay.maxMs', type: 'number', value: '8000', disabled: false },
    { name: 'aliases', value: '肥鱼， 小鱼', disabled: false },
    { name: 'separator', value: '', disabled: false },
  ];
  fields.aliases = fields[2]; fields.separator = fields[3];
  const button = ui.node('#save-config');
  fields.push(button);
  ui.context.testForm = { elements: fields };
  ui.run("state.config={revision:'original',behavior:{},policy:{}}; state.dirty=true; state.page='config'");
  const save = ui.run('saveConfig(testForm)');
  assert.equal(ui.run('state.saving'), true);
  assert.ok(fields.every((field) => field.disabled));
  ui.run("navigate('events')");
  assert.equal(ui.run('state.page'), 'config');
  await ui.run('saveConfig(testForm)');
  assert.equal(ui.calls.length, 1);
  const payload = JSON.parse(ui.calls[0].options.body);
  assert.equal(payload.revision, 'original');
  assert.deepEqual(payload.behavior.trigger.nameCall.aliases, ['肥鱼', '小鱼']);
  assert.equal(payload.behavior.reply.split.separator, '');
  finish();
  await save;
  assert.equal(ui.run('state.saving'), false);
  assert.equal(ui.run('state.dirty'), true);
  assert.ok(fields.every((field) => !field.disabled));
  assert.equal(fields.aliases.value, '肥鱼， 小鱼');
  assert.match(ui.node('#config-error').textContent, /配置已被其他操作更新/);
});
