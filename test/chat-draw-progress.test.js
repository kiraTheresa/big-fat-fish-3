import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer } from './mock-onebot.js';

const root = await mkdtemp(join(tmpdir(), 'fish-progress-'));
const onebotServer = await startMockServer();
let replies = [];
let images = [];
let imageRequests = 0;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const sse = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const call = (id, prompt = '猫') => ({ id, type: 'function', function: { name: 'draw', arguments: JSON.stringify({ prompt }) } });
const toolMessage = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });
const mock = createServer(async (req, res) => {
  for await (const _ of req) { /* drain request */ }
  if (req.url === '/images/generations') {
    imageRequests++;
    const item = images.shift();
    if (typeof item === 'function') return item(res);
    res.writeHead(item?.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(item?.status ? { error: { message: 'mock image failed' } } : { data: [{ b64_json: 'aW1hZ2U=' }] }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const message = replies.shift() ?? { content: '完成' };
  if (typeof message === 'function') return message(res);
  const { tool_calls, ...rest } = message;
  res.end(sse({ ...rest, ...(tool_calls ? { tool_calls: tool_calls.map((c, index) => ({ ...c, index })) } : {}) }, tool_calls ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, {
  DATA_DIR: root, PERSONA_DIR: join(root, 'personas'), USAGE_DIR: join(root, 'usage'), CONFIG_PATH: join(root, 'absent.json'),
  DEEPSEEK_API_KEY: 'test-chat', DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.address().port}`, CHAT_STREAM: 'true',
  IMAGE_API_KEY: 'test-image', IMAGE_API_BASE_URL: `http://127.0.0.1:${mock.address().port}`, IMAGE_TIMEOUT_MS: '3000', CHAT_TIMEOUT_MS: '3000',
  ONEBOT_WS_URL: onebotServer.url, ONEBOT_ACCESS_TOKEN: '', SEND_INTERVAL_MS: '1',
});
const { config } = await import('../src/config.js');
const { dispatch } = await import('../src/dispatch/dispatcher.js');
const { register } = await import('../src/dispatch/registry.js');
const chat = (await import('../src/triggers/chat.js')).default;
const onebot = await import('../src/connection/onebot.js');
const { drainSender } = await import('../src/sender/sender.js');
const { readRecentMessages } = await import('../src/store/message-store.js');
const { setUsagePolicy } = await import('../src/platform/usage-policy.js');
const { readUsageOverview } = await import('../src/store/usage-store.js');
register(chat);
onebot.startConnection();
await onebotServer.waitForConnectionCount(1);
for (;;) {
  try { await onebot.callApi('get_login_info', {}); break; }
  catch (error) { if (!error.message.includes('WS 未连接')) throw error; await new Promise((r) => setTimeout(r, 10)); }
}
beforeEach(async () => {
  await drainSender(); onebotServer.frames.length = 0; replies = []; images = []; imageRequests = 0;
  config.behavior.reply.delay.enabled = false;
  setUsagePolicy();
});
after(async () => {
  await drainSender(); onebot.stopConnection(); await onebotServer.close();
  mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve)); await rm(root, { recursive: true, force: true });
});
let seq = 100;
const event = (type = 'private') => ({ post_type: 'message', message_type: type, user_id: ++seq, group_id: type === 'group' ? seq : undefined,
  self_id: 10000, message_id: seq, time: Math.floor(Date.now() / 1000), sender: { nickname: '测试用户' },
  message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '画一只猫' } }], raw_message: '画一只猫' });
const sent = () => onebotServer.frames.filter((f) => f.action === 'send_msg').map((f) => f.params.message);
const isImage = (message) => Array.isArray(message) && message.some((part) => part.type === 'image');

for (const type of ['private', 'group']) test(`${type}：图片未完成先反馈，图片先于最终模型文字发送，取消绘图后的拟人等待`, { timeout: 10000 }, async () => {
  const imageEntered = deferred(); const imageRelease = deferred();
  const finalEntered = deferred(); const finalRelease = deferred();
  replies.push(toolMessage(call('a')), async (res) => {
    finalEntered.resolve(); await finalRelease.promise;
    res.end(sse({ content: '画好啦' }, 'stop') + 'data: [DONE]\n\n');
  });
  images.push(async (res) => {
    imageEntered.resolve(); await imageRelease.promise;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }));
  });
  config.behavior.reply.delay = { enabled: true, minMs: 2000, maxMs: 2000 };
  const input = event(type);
  const pending = dispatch(input);
  try {
    await imageEntered.promise;
    await onebotServer.waitForFrame((f) => f.action === 'send_msg' && typeof f.params.message === 'string' && f.params.message.includes('在画啦'));
    assert.equal(sent().some(isImage), false);
    imageRelease.resolve(); await finalEntered.promise;
    await onebotServer.waitForFrame((f) => f.action === 'send_msg' && isImage(f.params.message));
    assert.equal(sent().length, 2);
    const started = Date.now(); finalRelease.resolve(); await pending; await drainSender();
    assert.ok(Date.now() - started < 1500, '绘图后不再等待配置中的 2000ms');
    assert.equal(sent().length, 3);
    const records = await readRecentMessages(`${type === 'group' ? 'g' : 'p'}-${input.user_id}`, 10);
    assert.equal(records.filter((r) => r.bot && /在画啦/.test(r.raw_message)).length, 1);
    assert.equal(records.filter((r) => r.bot && r.raw_message === '画好啦').length, 1);
  } finally { imageRelease.resolve(); finalRelease.resolve(); await pending; }
});

test('失败后再次实际绘图有提示，同参数失败复用不重复提示或请求', async () => {
  replies.push(toolMessage(call('a')), toolMessage(call('duplicate'), call('changed', '狗')), { content: '完成' });
  images.push({ status: 500 }, {});
  await dispatch(event()); await drainSender();
  assert.equal(imageRequests, 2);
  assert.deepEqual(sent().filter((m) => typeof m === 'string').slice(0, 2), [
    '收到～本鱼在画啦，生成图片需要一点时间，稍等哦', '刚才那次没画成，本鱼再试一次，稍等哦',
  ]);
});

test('工具参数完整但 SSE 缺结束标记时，不能执行或发送开始提示', async () => {
  replies.push((res) => res.end(sse({ tool_calls: [{ ...call('a'), index: 0 }] }, 'tool_calls')));
  await dispatch(event()); await drainSender();
  assert.equal(imageRequests, 0);
  assert.deepEqual(sent(), ['AI 开小差了，稍后再试～']);
});

test('参数无效和用量准入拒绝均不发送虚假绘图开始提示', async () => {
  const invalid = call('invalid'); invalid.function.arguments = '{"wrong":"猫"}';
  replies.push(toolMessage(invalid), { content: '参数有误' });
  await dispatch(event()); await drainSender();
  assert.equal(imageRequests, 0); assert.deepEqual(sent(), ['参数有误']);
  onebotServer.frames.length = 0;
  const overview = await readUsageOverview();
  setUsagePolicy({ maxCallsPerDay: overview.totals.calls + 1 });
  replies.push(toolMessage(call('budget')));
  await dispatch(event()); await drainSender();
  assert.equal(imageRequests, 0);
  assert.ok(sent().every((m) => typeof m === 'string' && !m.includes('在画啦')));
  assert.match(sent()[0], /调用次数已达上限/);
});
