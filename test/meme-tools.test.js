import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer } from './mock-onebot.js';

const root = await mkdtemp(join(tmpdir(), 'fish-meme-tools-'));
const wire = await startMockServer();
const replies = [];
const requests = [];
const model = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  const next = replies.shift();
  const message = typeof next === 'function' ? next(body) : next ?? { role: 'assistant', content: '完成' };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message }] }));
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, { DATA_DIR: root, PERSONA_DIR: join(root, 'personas'), USAGE_DIR: join(root, 'usage'),
  CONFIG_PATH: join(root, 'absent.json'), CHAT_COOLDOWN_MS: '0', CHAT_STREAM: 'false',
  DEEPSEEK_API_KEY: 'mock-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}`,
  ONEBOT_WS_URL: wire.url, ONEBOT_ACCESS_TOKEN: '', SEND_INTERVAL_MS: '1', API_TIMEOUT_MS: '1000' });
const { config } = await import('../src/config.js');
const { defaultPromptConfig } = await import('../src/prompt/defaults.js');
const { executeTool, toolDefinitions } = await import('../src/tools/registry.js');
const { runToolConversation } = await import('../src/prompt/runner.js');
const { collectMeme, searchMemes } = await import('../src/store/meme-library.js');
const store = await import('../src/prompt/store.js');
const { dispatch } = await import('../src/dispatch/dispatcher.js');
const { register } = await import('../src/dispatch/registry.js');
const { drainSender } = await import('../src/sender/sender.js');
const { readRecentMessages } = await import('../src/store/message-store.js');
const onebot = await import('../src/connection/onebot.js');
register((await import('../src/triggers/meme.js')).default);
register((await import('../src/triggers/chat.js')).default);
config.behavior.reply.delay.enabled = false;
onebot.startConnection();
await wire.waitForConnectionCount(1);
for (;;) {
  try { await onebot.callApi('get_login_info', {}); break; }
  catch (error) { if (!error.message.includes('WS 未连接')) throw error; await new Promise((r) => setTimeout(r, 10)); }
}
after(async () => {
  await drainSender(); onebot.stopConnection(); await wire.close(); model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve)); await rm(root, { recursive: true, force: true });
});
let seq = 10;
const event = (text, extra = [], group = 900) => ({ post_type: 'message', message_type: 'group', group_id: group,
  user_id: 42, self_id: 10000, sender: { nickname: '测试' }, time: Math.floor(Date.now() / 1000), message_id: ++seq,
  message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text } }, ...extra] });
const tool = (name, args, id) => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const settings = defaultPromptConfig();

test('真实装配链模拟：自然语言收藏商城表情→模型检索选择→只发原生表情，没有多余文字', async () => {
  replies.push(tool('save_meme', { description: '躺平 累了 加班 摆烂' }, 'save'), { role: 'assistant', content: '收下啦' });
  await dispatch(event('收下这个表情，以后累了用', [{ type: 'image', data: {
    emoji_id: '123', emoji_package_id: '456', key: 'native-secret', summary: '[躺平]', url: 'https://invalid.example/never-fetch',
  } }]));
  await drainSender();
  const items = await searchMemes('g-900', '躺平');
  assert.equal(items.length, 1);
  wire.frames.length = 0;
  replies.push(tool('search_memes', { query: '加班 躺平' }, 'search'), (body) => {
    const output = JSON.parse(body.messages.at(-1).content);
    assert.equal(output.items[0].id, items[0].id);
    assert.ok(!JSON.stringify(output).includes('native-secret'));
    return tool('send_meme', { id: output.items[0].id }, 'send');
  }, { role: 'assistant', content: null });
  await dispatch(event('今天又加班，好累')); await drainSender();
  const frames = wire.frames.filter((frame) => frame.action === 'send_msg');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].params.message, [{ type: 'mface', data: { emoji_id: '123', emoji_package_id: '456', key: 'native-secret', summary: '[躺平]' } }]);
  assert.equal((await searchMemes('g-900', '躺平'))[0].usedCount, 1);
  assert.ok((await readRecentMessages('g-900', 10)).some((row) => row.bot && row.memeId === items[0].id));
  assert.ok(requests.every((req) => !JSON.stringify(req).includes('native-secret')));
});

test('命令入口通过 dispatcher 收藏 face，再按精确名称发送；未 @ 不执行', async () => {
  wire.frames.length = 0;
  await dispatch(event('/meme save 开心', [{ type: 'face', data: { id: '66' } }], 901)); await drainSender();
  assert.equal((await searchMemes('g-901', '开心')).length, 1);
  wire.frames.length = 0;
  const quiet = event('/meme send 开心', [], 901); quiet.message.shift();
  await dispatch(quiet); await drainSender(); assert.equal(wire.frames.length, 0);
  await dispatch(event('/meme send 开心', [], 901)); await drainSender();
  assert.deepEqual(wire.frames.find((f) => f.action === 'send_msg').params.message, [{ type: 'face', data: { id: '66' } }]);
});

test('工具拒绝猜 ID、跨会话、第二次搜索/发送；失败不标记已发送', async () => {
  const { asset } = await collectMeme('g-902', { type: 'face', data: { id: '1' }, name: '开心' });
  const ctx = { sessionKey: 'g-902', event: event('发个表情', [], 902), actorId: '42', memeTurn: {}, mode: 'live' };
  await assert.rejects(executeTool('send_meme', { id: asset.id }, ctx, settings), /候选/);
  await executeTool('search_memes', { query: '开心' }, ctx, settings);
  await assert.rejects(executeTool('search_memes', { query: '难过' }, ctx, settings), /已搜索/);
  wire.failNextCall();
  const failed = await executeTool('send_meme', { id: asset.id }, ctx, settings);
  assert.equal(failed.ok, false); assert.ok(!ctx.memeTurn.sent);
  await assert.rejects(executeTool('send_meme', { id: asset.id }, ctx, settings), /已经尝试/);
  const outsider = { ...ctx, sessionKey: 'g-903', event: event('发个表情', [], 903), memeTurn: {} };
  assert.deepEqual((await executeTool('search_memes', { query: '开心' }, outsider, settings)).items, []);
  await assert.rejects(executeTool('send_meme', { id: asset.id }, outsider, settings), /候选/);
});

test('Prompt 两种测试模式均不会收藏或发往 QQ；开关关闭立即拒绝', async () => {
  wire.frames.length = 0;
  for (const mode of ['simulate', 'execute']) for (const [name, args] of [
    ['save_meme', { description: '开心' }], ['search_memes', { query: '开心' }], ['send_meme', { id: 'anything' }],
  ]) assert.equal((await executeTool(name, args, { mode }, settings)).simulated, true);
  assert.equal(wire.frames.length, 0);
  const disabled = structuredClone(settings); disabled.tools.send_meme.enabled = false;
  await assert.rejects(executeTool('send_meme', { id: 'anything' }, { mode: 'simulate' }, disabled), /不可用/);
});

test('没有发送成功时，空最终回复不能被当作已完成', async () => {
  await assert.rejects(runToolConversation({ messages: [], tools: toolDefinitions(settings) }, settings,
    { sessionKey: 'g-900' }, { completion: async () => ({ message: { content: null } }) }), /未返回/);
});

test('旧 Prompt 配置升级增加工具，保留定制规则/关闭项，使旧评审失效且重复启动稳定', async () => {
  await store.initializePrompts();
  const file = join(root, 'management', 'prompts.json');
  const old = JSON.parse(await readFile(file, 'utf8'));
  old.tests = [{ id: 'old-review' }];
  for (const version of [old.published, old.draft, ...old.versions]) {
    for (const key of ['save_meme', 'search_memes', 'send_meme']) delete version.config.tools[key];
    version.config.prompts.toolRules = '自定义工具规则';
    version.config.tools.draw.enabled = false;
  }
  await writeFile(file, JSON.stringify(old));
  await store.initializePrompts();
  const migrated = store.getPromptWorkspace();
  assert.equal(migrated.published.config.tools.draw.enabled, false);
  assert.equal(migrated.published.config.tools.save_meme.enabled, true);
  assert.ok(migrated.published.config.prompts.toolRules.startsWith('自定义工具规则'));
  assert.notEqual(migrated.draft.revision, old.draft.revision);
  assert.deepEqual(migrated.tests, [{ id: 'old-review' }], '保留历史记录，新草稿 revision 已使旧评审不再适用');
  assert.equal(migrated.published.hash, store.configHash(migrated.published.config));
  await store.initializePrompts();
  assert.deepEqual(store.getPromptWorkspace(), migrated);
});
