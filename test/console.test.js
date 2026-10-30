// These are VM-level UI checks with explicit API fixtures, not browser acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

function harness(responder = () => ({}), { signedIn = true, storage = new Map(), now = 1800000000000, storageDisabled = false } = {}) {
  const nodes = new Map();
  const calls = [];
  const timers = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  let timerId = 0;
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      innerHTML: '', textContent: '', hidden: false, value: '', disabled: false, open: false, name: '',
      listeners: new Map(),
      classList: { toggle() {} }, addEventListener(event, callback) { this.listeners.set(event, callback); }, setAttribute() {}, removeAttribute() {},
      focus() {}, contains() { return false; }, close() { this.open = false; }, showModal() { this.open = true; },
    });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: node, querySelectorAll() { return []; }, addEventListener(event, callback) { documentListeners.set(event, callback); }, title: '' },
    window: { addEventListener(event, callback) { windowListeners.set(event, callback); }, confirm() { return true; } },
    location: { hash: '' }, history: { replaceState() {} },
    Date: class extends Date { static now() { return now; } },
    localStorage: {
      getItem(key) { if (storageDisabled) throw new Error('storage disabled'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageDisabled) throw new Error('storage disabled'); storage.set(key, value); },
      removeItem(key) { if (storageDisabled) throw new Error('storage disabled'); storage.delete(key); },
    },
    setInterval() {},
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    AbortSignal, URLSearchParams, Intl, structuredClone,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const response = await responder(url, options);
      return { ok: (response.status ?? 200) < 400, status: response.status ?? 200, json: async () => response.body ?? response };
    },
  });
  node('#app').hidden = true;
  const ready = vm.runInContext(source, context);
  const run = (expression) => vm.runInContext(expression, context);
  if (signedIn) run("state.token='ephemeral-test-token'; state.sequence=1");
  const advance = (ms, fireTimers = true) => {
    now += ms;
    if (fireTimers) for (const [id, timer] of timers) {
      if (timer.at <= now) { timers.delete(id); timer.callback(); }
    }
  };
  return { run, nodes, node, context, calls, ready, storage, advance, windowListeners, documentListeners };
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

const LOGIN_KEY = 'big-fat-fish.admin-session.v1';
const LOGIN_TTL = 30 * 60 * 1000;
const LOGIN_START = 1800000000000;
const loginRecord = (expiresAt = LOGIN_START + LOGIN_TTL) => JSON.stringify({ token: 'remembered-token', expiresAt });
const loginStorage = (record = loginRecord()) => new Map([[LOGIN_KEY, record]]);

test('成功验证后才记住令牌 30 分钟，刷新自动验证并进入，刷新不续期', async () => {
  const data = fixtures();
  const responder = (url) => data[url.split('?')[0]];
  const ui = harness(responder, { signedIn: false });
  await ui.ready;
  assert.equal(ui.calls.length, 0);
  ui.node('#admin-token').value = ' remembered-token ';
  await ui.node('#login-form').listeners.get('submit')({ preventDefault() {} });
  assert.equal(ui.node('#app').hidden, false);
  assert.equal(ui.node('#admin-token').value, '');
  assert.equal(ui.storage.get(LOGIN_KEY), loginRecord());
  const refreshed = harness(responder, { signedIn: false, storage: ui.storage, now: LOGIN_START + 10 * 60 * 1000 });
  assert.equal(refreshed.node('.login-submit').disabled, true);
  assert.equal(refreshed.run('state.token'), '');
  await refreshed.ready;
  assert.equal(refreshed.node('#app').hidden, false);
  assert.equal(refreshed.calls[0].options.headers.Authorization, 'Bearer remembered-token');
  assert.equal(refreshed.storage.get(LOGIN_KEY), loginRecord());
  refreshed.advance(20 * 60 * 1000 - 1);
  assert.equal(refreshed.node('#app').hidden, false);
  refreshed.advance(1);
  assert.equal(refreshed.node('#app').hidden, true);
  assert.equal(refreshed.run('state.token'), '');
  assert.equal(refreshed.storage.has(LOGIN_KEY), false);
  assert.match(refreshed.node('#login-error').textContent, /30 分钟/);
});

test('到期或损坏的登录记录被删除，不发送鉴权请求', async () => {
  for (const record of [loginRecord(LOGIN_START), loginRecord(LOGIN_START - 1), '{broken', 'null', '{}',
    JSON.stringify({ token: '', expiresAt: LOGIN_START + LOGIN_TTL }),
    JSON.stringify({ token: 123, expiresAt: LOGIN_START + LOGIN_TTL }),
    JSON.stringify({ token: 'token', expiresAt: String(LOGIN_START + LOGIN_TTL) }),
    loginRecord(LOGIN_START + LOGIN_TTL + 1)]) {
    const ui = harness(() => ({}), { signedIn: false, storage: loginStorage(record) });
    await ui.ready;
    assert.equal(ui.calls.length, 0, record);
    assert.equal(ui.storage.has(LOGIN_KEY), false);
    assert.equal(ui.node('#app').hidden, true);
  }
});

test('错误令牌不保存，自动恢复收到 401 清理记录，临时断网可再次刷新恢复', async () => {
  for (const restore of [false, true]) {
    const ui = harness(() => ({ status: 401 }), { signedIn: false, storage: restore ? loginStorage() : new Map() });
    await ui.ready;
    if (!restore) await ui.run("login('wrong-token')");
    assert.equal(ui.storage.has(LOGIN_KEY), false);
    assert.equal(ui.run('state.token'), '');
    assert.equal(ui.node('#app').hidden, true);
    assert.equal(ui.node('.login-submit').disabled, false);
    assert.match(ui.node('#login-error').textContent, /令牌/);
  }
  const offline = harness(() => { throw new Error('offline'); }, { signedIn: false, storage: loginStorage() });
  await offline.ready;
  assert.equal(offline.storage.get(LOGIN_KEY), loginRecord());
  assert.equal(offline.node('#app').hidden, true);
  assert.match(offline.node('#login-error').textContent, /无法连接/);
});

test('退出清除保存记录和内容，刷新不会重新登录', async () => {
  const ui = harness(() => ({}), { signedIn: false, storage: loginStorage() });
  await ui.ready;
  ui.storage.set('unrelated-preference', 'keep');
  ui.node('#logout').listeners.get('click')();
  assert.equal(ui.storage.has(LOGIN_KEY), false);
  assert.equal(ui.storage.get('unrelated-preference'), 'keep');
  assert.equal(ui.node('#content').innerHTML, '');
  assert.equal(ui.run('state.token'), '');
  const refreshed = harness(() => ({}), { signedIn: false, storage: ui.storage });
  await refreshed.ready;
  assert.equal(refreshed.calls.length, 0);
});

test('休眠导致计时器延迟时，恢复焦点或发起 API 请求仍检查到期', async () => {
  for (const trigger of ['focus', 'pageshow', 'visibilitychange', 'api']) {
    const ui = harness(() => ({}), { signedIn: false, storage: loginStorage() });
    await ui.ready;
    const calls = ui.calls.length;
    ui.advance(LOGIN_TTL, false);
    if (trigger === 'api') await assert.rejects(ui.run("api('/config')"), /30 分钟/);
    else if (trigger === 'visibilitychange') ui.documentListeners.get(trigger)();
    else ui.windowListeners.get(trigger)();
    assert.equal(ui.calls.length, calls);
    assert.equal(ui.run('state.token'), '');
    assert.equal(ui.storage.has(LOGIN_KEY), false);
  }
});

test('自动恢复的慢响应不能撤销退出或越过原到期时间', async () => {
  for (const action of ['logout()', `Date.now = () => ${LOGIN_START + LOGIN_TTL}`]) {
    let finish;
    const ui = harness(() => new Promise((resolve) => { finish = resolve; }), { signedIn: false, storage: loginStorage() });
    ui.run(action);
    finish({});
    await ui.ready;
    assert.equal(ui.run('state.token'), '');
    assert.equal(ui.node('#app').hidden, true);
    assert.equal(ui.storage.has(LOGIN_KEY), false);
    assert.equal(ui.node('.login-submit').disabled, false);
  }
});

test('另一标签页退出或更换登录时同步退出，保留该标签页写入的新记录', async () => {
  const ui = harness(() => ({}), { signedIn: false, storage: loginStorage() });
  await ui.ready;
  const newRecord = JSON.stringify({ token: 'new-token', expiresAt: LOGIN_START + LOGIN_TTL });
  ui.storage.set(LOGIN_KEY, newRecord);
  ui.windowListeners.get('storage')({ key: LOGIN_KEY, newValue: newRecord });
  assert.equal(ui.run('state.token'), '');
  assert.equal(ui.storage.get(LOGIN_KEY), newRecord);
  const other = harness(() => ({}), { signedIn: false, storage: ui.storage });
  await other.ready;
  ui.storage.delete(LOGIN_KEY);
  other.windowListeners.get('storage')({ key: LOGIN_KEY, newValue: null });
  assert.equal(other.run('state.token'), '');
});

test('浏览器禁用存储时仍允许登录并提示刷新需要重输，30 分钟后仍到期', async () => {
  const ui = harness(() => ({}), { signedIn: false, storageDisabled: true });
  await ui.ready;
  await ui.run("login('valid-token')");
  assert.equal(ui.node('#app').hidden, false);
  assert.match(ui.node('#toast').textContent, /刷新后需重新输入/);
  ui.advance(LOGIN_TTL);
  assert.equal(ui.run('state.token'), '');
});

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
  ui.storage.set(LOGIN_KEY, JSON.stringify({ token: 'new-token', expiresAt: LOGIN_START + LOGIN_TTL }));
  await assert.rejects(ui.run("api('/status',{token:'old-token'})"), /令牌/);
  assert.equal(ui.run('state.token'), 'new-token');
  assert.equal(ui.storage.has(LOGIN_KEY), true);
  await assert.rejects(ui.run("api('/status')"), /令牌/);
  assert.equal(ui.run('state.token'), '');
  assert.equal(ui.storage.has(LOGIN_KEY), false);
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
  fields.push({ name: 'behavior.trigger.poke.enabled', type: 'checkbox', checked: false, disabled: false },
    { name: 'behavior.trigger.poke.prompt', type: 'textarea', value: '简短回应', disabled: false },
    { name: 'behavior.chat.cooldownMs', type: 'number', value: '2000', disabled: false });
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
  assert.equal(payload.behavior.trigger.poke.enabled, false);
  assert.equal(payload.behavior.trigger.poke.prompt, '简短回应');
  assert.equal(payload.behavior.chat.cooldownMs, 2000);
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
