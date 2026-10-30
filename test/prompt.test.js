import test, { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const root = await mkdtemp(join(tmpdir(), 'fish-prompt-'));
let responses = [];
const requests = [];
const mock = createServer(async (req, res) => {
  let body = ''; for await (const part of req) body += part;
  requests.push(JSON.parse(body));
  const next = responses.shift() ?? { role: 'assistant', content: '测试回复' };
  const message = typeof next === 'function' ? await next(requests.at(-1)) : next;
  res.writeHead(message.status ?? 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(message.image ? { data: [{ b64_json: message.image }], usage: { total_tokens: 2 } } : message.status ? { error: { message: 'mock failure' } } : { choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
process.env.DEEPSEEK_API_KEY = 'prompt-test-secret';
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
process.env.IMAGE_API_KEY = '';
process.env.DATA_DIR = root;
const { config } = await import('../src/config.js');
const store = await import('../src/prompt/store.js');
const { createPromptService } = await import('../src/prompt/service.js');
const { runToolConversation } = await import('../src/prompt/runner.js');
const { buildChatRequest } = await import('../src/prompt/builder.js');
const { toolDefinitions, executeTool } = await import('../src/tools/registry.js');
const { getPersona, appendMemory, readPersonaSnapshot, resetPersona } = await import('../src/store/persona-store.js');
const { appendMessage } = await import('../src/store/message-store.js');
const { initializePermissions, setUser } = await import('../src/platform/permissions.js');
const { setUsagePolicy } = await import('../src/platform/usage-policy.js');
const { readUsageOverview } = await import('../src/store/usage-store.js');
const { initializeSettings } = await import('../src/platform/settings.js');
const { startAdminServer } = await import('../src/admin/server.js');
const { saveRun, readRun } = await import('../src/prompt/traces.js');
const { configDiff, publishReadiness } = await import('../web/prompt.js');
let service;
beforeEach(async () => {
  const dir = await mkdtemp(join(root, 'case-'));
  config.dataDir = dir; config.personaDir = join(dir, 'personas'); config.usageDir = join(dir, 'usage');
  config.imageApiKey = ''; responses = []; requests.length = 0;
  setUsagePolicy(); await initializePermissions(); await initializeSettings(setUsagePolicy); await store.initializePrompts();
  service = createPromptService();
});
afterEach(async () => { await service.close(); });
after(async () => { mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve)); await rm(root, { recursive: true, force: true }); });
const call = (id, name = 'remember_fact', args = { content: '不吃香菜' }) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolMessage = (...calls) => ({ role: 'assistant', content: null, reasoning_content: 'retained-reasoning', tool_calls: calls });
const event = { message_type: 'group', user_id: '123', group_id: '999', sender: { nickname: '小明' } };
const context = () => ({ sessionKey: 'g-999', actorId: '123', speaker: '小明', mode: 'simulate', memory: { value: '' } });
async function finishRun(id) {
  for (let i = 0; i < 200; i++) {
    const run = await service.readRun(id);
    if (run.status !== 'running' && !service.isActive()) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('test did not finish');
}
async function testDraft({ snapshot, kind = 'chat', ...other } = {}) {
  const snap = snapshot ?? await service.snapshot({ scene: 'group' });
  const { draft } = store.getPromptWorkspace();
  const { id } = await service.startTest({ revision: draft.revision, snapshotId: snap.id, input: '记住我不吃香菜', kind, ...other });
  const run = await finishRun(id);
  return { run, draft, snap };
}
async function accept(run, revision) { return store.reviewPromptTest({ id: run.id, revision, passed: true, note: '检查实际请求与工具结果' }); }

test('真实网关发送 tools；完整回传工具 ID、结果与 reasoning；同参数重试只写一次沙盒', async () => {
  const cfg = store.getPromptConfig();
  const built = buildChatRequest(cfg, { persona: { character: '鱼', memory: '' }, records: [], event, text: '记住我不吃香菜' });
  const ctx = context();
  responses.push(toolMessage(call('a')), toolMessage(call('b')), { role: 'assistant', content: '记住啦' });
  const result = await runToolConversation(built.request, cfg, ctx);
  assert.equal(result.content, '记住啦');
  assert.equal(requests.length, 3);
  assert.equal(requests[0].tools[0].function.name, 'remember_fact'); // draw is unconfigured
  assert.equal(requests[1].messages.at(-2).reasoning_content, 'retained-reasoning');
  assert.equal(requests[1].messages.at(-1).tool_call_id, 'a');
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).sandbox, true);
  assert.equal(ctx.memory.value.match(/不吃香菜/g).length, 1);
  assert.ok(result.trace.some((e) => e.reused));
  assert.equal((await readUsageOverview()).totals.calls, 3);
  assert.equal((await readPersonaSnapshot('g-999')).character, null);
});

test('关闭工具、额外会话参数和未知函数都不能执行；模型只能使用后端绑定的会话', async () => {
  const cfg = store.getPromptConfig(); cfg.tools.remember_fact.enabled = false;
  const built = buildChatRequest(cfg, { persona: { character: '鱼', memory: '' }, event, text: '记住' });
  assert.ok(!built.request.tools.some((t) => t.function.name === 'remember_fact'));
  responses.push(toolMessage(call('a')), { role: 'assistant', content: '无法执行' });
  let executions = 0;
  const result = await runToolConversation(built.request, cfg, context(), { execute: async () => { executions++; } });
  assert.equal(executions, 0); assert.equal(result.trace.find((e) => e.phase === 'tool').result.ok, false);
  cfg.tools.remember_fact.enabled = true;
  responses.push(toolMessage(call('b', 'remember_fact', { content: '秘密', sessionKey: 'g-other' })), { role: 'assistant', content: '参数有误' });
  await runToolConversation({ ...built.request, tools: toolDefinitions(cfg) }, cfg, context(), { execute: async () => { executions++; } });
  assert.equal(executions, 0);
  await setUser('123', { role: 'blocked' });
  await assert.rejects(executeTool('remember_fact', { content: 'x' }, { ...context(), mode: 'live' }, cfg), /不可用/);
});

test('执行一次后模型失败不会重试副作用；循环次数受限，重复 ID 在执行前被拒绝', async () => {
  const cfg = store.getPromptConfig(); cfg.execution.maxToolRounds = 1;
  const request = buildChatRequest(cfg, { persona: { character: '鱼', memory: '' }, event, text: '记住' }).request;
  let executions = 0;
  responses.push(toolMessage(call('a')), { status: 500 });
  await assert.rejects(runToolConversation(request, cfg, context(), { execute: async () => { executions++; return { ok: true }; } }), (e) => e.toolStarted && /500/.test(e.message));
  assert.equal(executions, 1); assert.equal(requests[1].tool_choice, 'none');
  responses.push(toolMessage(call('dup'), call('dup')));
  await assert.rejects(runToolConversation(request, cfg, context(), { execute: async () => { executions++; } }), /重复/);
  assert.equal(executions, 1);
});

test('筛选之后取 N 条，排除当前输入、其他用户、重置前、命令、图片并显示原因', () => {
  const cfg = store.getPromptConfig();
  Object.assign(cfg.context, { historyLimit: 2, onlySpeaker: true, excludeCommands: true, image: false, budgetBytes: 20000 });
  const rows = [
    { message_id: 1, time: 1, user_id: '123', raw_message: 'reset前' },
    { message_id: 2, time: 2, user_id: '555', raw_message: '其他人' },
    { message_id: 3, time: 3, user_id: '123', raw_message: '/help' },
    { message_id: 4, time: 4, user_id: '123', raw_message: '[CQ:image,file=a]' },
    ...[5, 6, 7, 8].map((n) => ({ message_id: n, time: n, user_id: '123', raw_message: `消息${n}` })),
  ];
  const built = buildChatRequest(cfg, { persona: { character: '鱼', memory: '' }, event: { ...event, message_id: 8 }, records: rows, state: { resetAt: 2 }, text: '本轮' });
  assert.equal(built.summary.candidates, 7); assert.equal(built.summary.filtered, 3); assert.equal(built.summary.sent, 2);
  assert.ok(built.request.messages[1].content.includes('消息6'));
  assert.equal(built.inspections[0].reason, '早于会话重置');
  assert.equal(built.inspections[4].reason, '超过历史条数');
  cfg.context.historyLimit = 0;
  assert.equal(buildChatRequest(cfg, { persona: {}, event, records: rows, text: '本轮' }).request.messages.length, 2);
});

test('draft → 真实模型测试 → 人工评审 → 发布；测试不改线上；新种子只影响新建或重置会话', async () => {
  const existing = await getPersona('g-999');
  await appendMemory('g-999', '小明', '已有记忆');
  const workspace = store.getPromptWorkspace(); const cfg = structuredClone(workspace.draft.config);
  cfg.prompts.seed = '# 新人设\n热爱海洋的鱼'; cfg.context.historyLimit = 8;
  const updated = await store.savePromptDraft({ revision: workspace.draft.revision, config: cfg });
  assert.equal(store.getPromptConfig().context.historyLimit, workspace.published.config.context.historyLimit);
  await assert.rejects(store.publishPromptDraft({ revision: updated.draft.revision }), /测试/);
  const snap = await service.snapshot({ scene: 'private' });
  const preview = service.preview({ revision: updated.draft.revision, snapshotId: snap.id, input: '你好', target: 'draft' });
  const { run, draft } = await testDraft({ snapshot: snap, input: '你好' });
  assert.equal(run.status, 'completed'); assert.equal(run.usesSeed, true);
  assert.deepEqual(requests.at(-1), preview.request);
  await assert.rejects(store.publishPromptDraft({ revision: draft.revision }), /测试/);
  await accept(run, draft.revision);
  const published = await store.publishPromptDraft({ revision: draft.revision, note: '验证新模板' });
  assert.equal(published.published.number, 1); assert.equal(store.getPromptConfig().context.historyLimit, 8);
  assert.equal((await getPersona('g-999')).character, existing.character);
  assert.ok((await getPersona('g-999')).memory.includes('已有记忆'));
  assert.equal((await getPersona('p-456')).character, cfg.prompts.seed);
  await resetPersona('g-999'); assert.equal((await getPersona('g-999')).character, cfg.prompts.seed);
  await store.initializePrompts(); assert.equal(store.getPublishedPrompt().number, 1);
  assert.equal(store.getPromptWorkspace().tests[0].review.passed, true);
});

test('草稿改动使旧通过失效；并发保存冲突；回退载入草稿而不直接发布', async () => {
  const { run, draft } = await testDraft(); await accept(run, draft.revision);
  const cfg = structuredClone(draft.config); cfg.prompts.group += '\n少用拟声词';
  const next = await store.savePromptDraft({ revision: draft.revision, config: cfg });
  await assert.rejects(store.publishPromptDraft({ revision: next.draft.revision }), /测试/);
  await assert.rejects(store.savePromptDraft({ revision: draft.revision, config: cfg }), /草稿已变化/);
  const result = await store.restorePromptVersion({ revision: next.draft.revision, versionId: 'builtin' });
  assert.equal(result.published.number, 0); assert.notEqual(result.draft.revision, next.draft.revision);
  await assert.rejects(store.publishPromptDraft({ revision: result.draft.revision }), /测试/);
});

test('提炼修改必须有提炼测试；输出与记忆更新仅保留在测试结果，旧人设不落盘', async () => {
  await getPersona('g-999'); await appendMemory('g-999', '小明', '不吃香菜');
  const original = await readPersonaSnapshot('g-999'); const w = store.getPromptWorkspace();
  const cfg = structuredClone(w.draft.config); cfg.prompts.distill += '\n保留重要细节';
  const next = await store.savePromptDraft({ revision: w.draft.revision, config: cfg });
  const chat = await testDraft(); await accept(chat.run, next.draft.revision);
  await assert.rejects(store.publishPromptDraft({ revision: next.draft.revision }), /提炼/);
  const snap = await service.snapshot({ sessionKey: 'g-999' });
  responses.push({ role: 'assistant', content: JSON.stringify(original) });
  const result = await testDraft({ snapshot: snap, kind: 'distill' });
  assert.equal(result.run.status, 'completed'); await accept(result.run, result.draft.revision);
  await store.publishPromptDraft({ revision: result.draft.revision });
  assert.deepEqual(await readPersonaSnapshot('g-999'), original);
});

test('会话快照只读且冻结；JSON 实验不能发布、不能声明关闭的工具', async () => {
  await appendMessage({ sessionKey: 'g-999', time: 1, user_id: '123', raw_message: '旧消息' });
  const snap = await service.snapshot({ sessionKey: 'g-999' });
  assert.equal((await readPersonaSnapshot('g-999')).character, null);
  await appendMessage({ sessionKey: 'g-999', time: 2, user_id: '123', raw_message: '新消息' });
  const w = store.getPromptWorkspace();
  const args = { revision: w.draft.revision, snapshotId: snap.id, input: '你好' };
  const preview = service.preview(args);
  assert.equal(preview.summary.candidates, 1);
  const override = structuredClone(preview.request); override.messages.at(-1).content = '临时实验';
  const { id } = await service.startTest({ ...args, requestOverride: override });
  const run = await finishRun(id); assert.equal(run.override, true);
  await assert.rejects(accept(run, w.draft.revision), /原始请求测试/);
  override.tools.push({ type: 'function', function: { name: 'draw', parameters: {} } });
  await assert.rejects(service.startTest({ ...args, requestOverride: override }), /未启用/);
});

test('HTTP API 鉴权、快照、预览、测试、评审与发布串通；静态模块可访问', async () => {
  const token = 'test-admin-token-1234567890';
  const prompt = { ...service, workspace: store.getPromptWorkspace, saveDraft: store.savePromptDraft, review: store.reviewPromptTest, publish: store.publishPromptDraft };
  const server = await startAdminServer({ port: 0, token, services: { prompt } });
  const url = `http://127.0.0.1:${server.port}`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${url}/api/prompt/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal((await fetch(`${url}/api/prompt/workspace`)).status, 401);
    assert.equal((await fetch(`${url}/prompt.js`)).status, 200);
    const w = (await request('workspace')).body;
    const snap = (await request('snapshot', 'POST', {})).body;
    const args = { revision: w.draft.revision, snapshotId: snap.id, input: '你好' };
    assert.equal((await request('preview', 'POST', args)).status, 200);
    const started = await request('tests', 'POST', args); assert.equal(started.status, 202);
    const run = await finishRun(started.body.id); assert.equal(run.status, 'completed');
    assert.equal((await request('review', 'POST', { id: run.id, revision: w.draft.revision, passed: true })).status, 200);
    assert.equal((await request('publish', 'POST', { revision: w.draft.revision })).body.published.number, 1);
    assert.equal((await request('snapshot', 'POST', { sessionKey: '../secret' })).status, 400);
  } finally { await server.close(); }
});

test('敏感请求记录脱敏并标记，失败测试不能评审，配置拒绝未知变量 / 字段', async () => {
  const { randomUUID } = await import('node:crypto');
  const id = randomUUID();
  await saveRun({ id, source: 'live', createdAt: Date.now(), trace: [{ request: { messages: [{ content: `${config.deepseekApiKey}\n第二行 data:image/png;base64,YWJj` }] } }] });
  const run = await readRun(id);
  assert.equal(run.redacted, true); assert.ok(!JSON.stringify(run).includes(config.deepseekApiKey));
  assert.ok(run.trace[0].request.messages[0].content.includes('\n第二行'));
  responses.push({ status: 400 }); const failed = await testDraft();
  assert.equal(failed.run.status, 'failed'); await assert.rejects(accept(failed.run, failed.draft.revision));
  const cfg = store.getPromptConfig(); cfg.prompts.scene = '{{unknown}}'; assert.throws(() => store.validatePromptConfig(cfg), /未知模板变量/);
  cfg.prompts.scene = 'scene'; cfg.tools.shell = {}; assert.throws(() => store.validatePromptConfig(cfg), /未知字段/);
  assert.deepEqual(configDiff({ a: { b: 1 } }, { a: { b: 2 } }), [{ path: 'a.b', before: 1, after: 2 }]);
});


test('真实绘图测试只保存控制台产物，记录 Image API 请求并计入原有用量', async () => {
  config.imageApiKey = 'image-test-secret';
  config.imageApiBaseUrl = `http://127.0.0.1:${mock.address().port}`;
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCGkAAAAASUVORK5CYII=';
  responses.push(toolMessage(call('draw-1', 'draw', { prompt: '一只猫' })), { image: b64 }, { role: 'assistant', content: '图片已生成' });
  const { run } = await testDraft({ mode: 'execute' });
  assert.equal(run.status, 'completed'); assert.equal(run.imageCount, 1);
  assert.equal((await service.readRunImage(run.id, 0)).b64, b64);
  assert.ok(run.trace.some((e) => e.phase === 'request' && e.name === 'image_api' && e.request.prompt === '一只猫'));
  assert.ok(!JSON.stringify(run).includes(b64));
  const usage = await readUsageOverview(); assert.equal(usage.totals.calls, 3);
  assert.ok(usage.items.some((u) => u.kind === 'draw'));
});

test('线上记忆工具使用绑定会话和真实发言者；读取看到刚保存的事实', async () => {
  const settings = store.getPromptConfig();
  const ctx = { ...context(), mode: 'live' };
  await getPersona('g-999');
  assert.equal((await executeTool('remember_fact', { content: '不吃香菜' }, ctx, settings)).ok, true);
  const result = await executeTool('recall_memory', {}, ctx, settings);
  assert.match(result.memory, /小明: 不吃香菜/);
  assert.equal((await readPersonaSnapshot('g-888')).character, null);
});

test('发布按钮与后端一致：混合修改须聊天和提炼通过，新人设须全新素材通过', () => {
  const workspace = store.getPromptWorkspace(); const cfg = structuredClone(workspace.draft.config);
  cfg.prompts.seed += '新性格'; cfg.prompts.distill += '新提炼规则';
  const evidence = { revision: workspace.draft.revision, target: 'draft', status: 'completed', review: { passed: true }, override: false };
  workspace.tests = [{ ...evidence, kind: 'distill' }];
  assert.equal(publishReadiness(workspace, cfg), false);
  workspace.tests.push({ ...evidence, kind: 'chat', usesSeed: false });
  assert.equal(publishReadiness(workspace, cfg), false);
  workspace.tests[1].usesSeed = true;
  assert.equal(publishReadiness(workspace, cfg), true);
  assert.equal(publishReadiness(workspace, cfg, true), false);
});
