// DOM-contract regression for appearance switching; this is not visual/browser acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptConsole } from '../web/prompt.js';
import { defaultPromptConfig } from '../src/prompt/defaults.js';

function harness() {
  const config = defaultPromptConfig();
  const workspace = { published: { number: 0, config }, draft: { revision: 'draft-1', config }, tests: [], versions: [] };
  const calls = [];
  const appState = { page: 'prompt', token: 'test-token', sequence: 1, dirty: false, saving: false };
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      dataset: {}, value: '', checked: false, readOnly: false, disabled: false, textContent: '', innerHTML: '',
      attributes: {}, selectionStart: 0, selectionEnd: 0, scrollTop: 0, open: false,
      setAttribute(key, value) { this.attributes[key] = value; },
    });
    return nodes.get(selector);
  };
  const choices = ['workbench', 'relaxed'].map((style) => ({ dataset: { ppStyle: style }, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } }));
  const handlers = {};
  const root = {
    querySelector: node,
    querySelectorAll(selector) { return selector === '[data-pp-style]' ? choices : []; },
    addEventListener(name, handler) { handlers[name] = handler; },
    set innerHTML(_) { throw new Error('Switching style must not replace the page DOM'); },
  };
  node('#pp-session').value = 'new-group'; node('#pp-kind').value = 'chat'; node('#pp-input').value = '你好';
  const api = async (path, options) => {
    calls.push({ path, options });
    if (path === '/prompt/workspace') return structuredClone(workspace);
    if (path === '/prompt/sessions' || path === '/prompt/runs') return { items: [] };
    if (path === '/prompt/snapshot') return { id: 'snapshot-1', nowMs: 0, historyCount: 0, event: { user_id: '1', message_type: 'group' }, persona: { character: null, memory: '' } };
    if (path === '/prompt/preview') return { request: { model: 'test', messages: [{ role: 'system', content: 'system' }, { role: 'user', content: '你好' }] }, summary: { candidates: 0, sent: 0 }, availability: [], inspections: [] };
    throw new Error(`Unexpected API ${path}`);
  };
  const controller = createPromptConsole({ api, state: appState, toast() {} });
  return { controller, node, calls, appState, choices, handlers, root,
    click(style) { const button = choices.find((item) => item.dataset.ppStyle === style); handlers.click({ target: { closest: (selector) => selector === '[data-pp-style]' ? button : null } }); },
  };
}

test('切换保留未保存内容、原始 JSON、选区、展开项和测试结果；不发请求、不改变业务状态', async () => {
  const original = globalThis.localStorage;
  const saved = new Map();
  globalThis.localStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const ui = harness();
  try {
    assert.match(await ui.controller.render(1), /data-prompt-style="workbench"/);
    ui.controller.attach(ui.root);
    await new Promise((resolve) => setImmediate(resolve));
    const editor = ui.node('#pp-editor'); editor.innerHTML = '<textarea>原始编辑器</textarea>';
    const raw = ui.node('[data-pp-field="configJson"]');
    raw.dataset.ppField = 'configJson'; raw.value = '{ 尚未写完的 JSON'; raw.selectionStart = 3; raw.selectionEnd = 8; raw.scrollTop = 100;
    ui.handlers.input({ target: raw }); // An invalid JSON draft must still allow switching.
    ui.node('#pp-input').value = '还没提交的测试消息';
    ui.node('#pp-expected').value = '预期保持';
    ui.node('#pp-request-edit').checked = true;
    ui.node('#pp-request-json').value = '{"临时实验":true}';
    ui.node('#pp-result').innerHTML = '当前测试结果';
    ui.node('details').open = true;
    const before = [...ui.calls];
    const stateBefore = structuredClone(ui.appState);
    ui.click('relaxed'); ui.click('workbench'); ui.click('relaxed');
    assert.deepEqual(ui.calls, before);
    assert.deepEqual(ui.appState, stateBefore);
    assert.equal(ui.node('#pp-editor'), editor);
    assert.equal(editor.innerHTML, '<textarea>原始编辑器</textarea>');
    assert.equal(raw.value, '{ 尚未写完的 JSON');
    assert.deepEqual([raw.selectionStart, raw.selectionEnd, raw.scrollTop], [3, 8, 100]);
    assert.equal(ui.node('#pp-input').value, '还没提交的测试消息');
    assert.equal(ui.node('#pp-request-json').value, '{"临时实验":true}');
    assert.equal(ui.node('#pp-result').innerHTML, '当前测试结果');
    assert.equal(ui.node('details').open, true);
    assert.equal(ui.node('#prompt-console').dataset.promptStyle, 'relaxed');
    assert.deepEqual(ui.choices.map((choice) => choice.attributes['aria-pressed']), ['false', 'true']);
    assert.match(await harness().controller.render(1), /data-prompt-style="relaxed"/);
    assert.deepEqual([...saved.keys()], ['big-fat-fish.prompt-style']);
  } finally { ui.controller.clear(); globalThis.localStorage = original; }
});

test('测试进行中仍可切换；浏览器禁止持久化时不影响切换或业务状态', async () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const ui = harness();
  try {
    assert.match(await ui.controller.render(1), /data-prompt-style="workbench"/);
    ui.controller.attach(ui.root);
    await new Promise((resolve) => setImmediate(resolve));
    ui.appState.saving = true;
    ui.node('#pp-running').textContent = '测试运行中';
    const count = ui.calls.length;
    ui.click('relaxed');
    assert.equal(ui.calls.length, count);
    assert.equal(ui.appState.saving, true);
    assert.equal(ui.node('#pp-running').textContent, '测试运行中');
    assert.equal(ui.node('#prompt-console').dataset.promptStyle, 'relaxed');
  } finally { ui.controller.clear(); globalThis.localStorage = original; }
});
