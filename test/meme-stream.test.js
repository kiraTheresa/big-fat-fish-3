import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer } from './mock-onebot.js';

const root = await mkdtemp(join(tmpdir(), 'fish-meme-stream-'));
const wire = await startMockServer();
const responses = [];
const requests = [];
const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const empty = () => frame({ role: 'assistant', content: null }, 'stop') + 'data: [DONE]\n\n';
const tool = (id, name, args) => frame({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
  function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls') + 'data: [DONE]\n\n';
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw));
  const response = responses.shift();
  res.writeHead(response === undefined ? 500 : 200, { 'Content-Type': 'text/event-stream' });
  res.end(response ?? 'data: {"error":{"message":"unexpected request"}}\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, { DATA_DIR: root, USAGE_DIR: join(root, 'usage'), CONFIG_PATH: join(root, 'absent.json'),
  ONEBOT_WS_URL: wire.url, SEND_INTERVAL_MS: '1', API_TIMEOUT_MS: '1000',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`, DEEPSEEK_API_KEY: 'test-key',
  CHAT_STREAM: 'true', CHAT_TIMEOUT_MS: '1000' });
const { chatCompletion } = await import('../src/llm.js');
const { runToolConversation } = await import('../src/prompt/runner.js');
const { toolDefinitions } = await import('../src/tools/registry.js');
const { defaultPromptConfig } = await import('../src/prompt/defaults.js');
const { collectMeme } = await import('../src/store/meme-library.js');
const { startConnection, stopConnection, callApi } = await import('../src/connection/onebot.js');
const { drainSender } = await import('../src/sender/sender.js');
const settings = defaultPromptConfig();
const event = { post_type: 'message', message_type: 'private', user_id: 456, message_id: 555,
  message: [{ type: 'text', data: { text: '发开心表情' } }] };
const context = () => ({ sessionKey: 'p-456', actorId: '456', mode: 'live', event,
  memeTurn: { saved: false, searched: false, sendAttempted: false, sent: false } });
const request = () => ({ model: 'test', tools: toolDefinitions(settings, '456'),
  messages: [{ role: 'user', content: '发开心表情' }] });
const { asset } = await collectMeme('p-456', { type: 'face', data: { id: '14' }, name: '开心', tags: ['开心'] });
startConnection();
await wire.waitForConnectionCount(1);
for (let i = 0; ; i++) {
  try { await callApi('get_status'); break; }
  catch (error) { if (i > 50 || !error.message.includes('WS 未连接')) throw error; await new Promise((resolve) => setTimeout(resolve, 5)); }
}
beforeEach(async () => { await drainSender(); responses.length = 0; requests.length = 0; wire.frames.length = 0; });
after(async () => {
  await drainSender(); stopConnection(); await wire.close();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

test('HTTP SSE 空内容默认拒绝，显式 opt-in 才允许完整的空回复', async () => {
  responses.push(empty());
  await assert.rejects(chatCompletion(request().messages), /缺少/);
  responses.push(empty());
  const result = await chatCompletion(request().messages, { allowEmptyContent: true });
  assert.equal(result.content, null);
  assert.equal(result.message.role, 'assistant');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((item) => item.stream === true));
  assert.ok(requests.every((item) => !('allowEmptyContent' in item)), '本地开关不应作为供应商请求字段');
});

test('完整 SSE 搜索→发送→空回复：真实工具和 OneBot mock 只发送一个表情', async () => {
  responses.push(tool('search', 'search_memes', { query: '开心' }), tool('send', 'send_meme', { id: asset.id }), empty());
  const ctx = context();
  const result = await runToolConversation(request(), settings, ctx);
  assert.equal(result.content, '');
  assert.equal(ctx.memeTurn.sent, true);
  const frames = wire.frames.filter((item) => item.action === 'send_msg');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].params.message, [{ type: 'face', data: { id: '14' } }]);
  assert.equal(frames[0].params.user_id, 456);
  assert.equal(requests.length, 3);
  const finalToolResult = JSON.parse(requests[2].messages.at(-1).content);
  assert.equal(finalToolResult.ok, true);
  assert.ok(finalToolResult.messageId);
});

test('发送没有成功确认时，不能用空回复结束', async () => {
  responses.push(tool('search', 'search_memes', { query: '开心' }), tool('send', 'send_meme', { id: asset.id }), empty());
  wire.failNextCall(1400, 'mock failure');
  const ctx = context();
  await assert.rejects(runToolConversation(request(), settings, ctx), (error) => {
    assert.equal(error.toolStarted, true);
    assert.match(error.message, /缺少|未返回/);
    return true;
  });
  assert.equal(ctx.memeTurn.sent, false);
  assert.equal(wire.frames.filter((item) => item.action === 'send_msg').length, 1);
});

test('即使允许空内容，截断的 SSE 仍拒绝；已发出的表情不重试', async () => {
  for (const broken of [frame({ role: 'assistant' }, 'stop'), frame({ role: 'assistant' }) + 'data: [DONE]\n\n']) {
    responses.push(broken);
    await assert.rejects(chatCompletion(request().messages, { allowEmptyContent: true }), /中断/);
  }
  responses.push(tool('search', 'search_memes', { query: '开心' }), tool('send', 'send_meme', { id: asset.id }), frame({}, 'stop'));
  const ctx = context();
  await assert.rejects(runToolConversation(request(), settings, ctx), (error) => error.toolStarted && /中断/.test(error.message));
  assert.equal(ctx.memeTurn.sent, true);
  assert.equal(wire.frames.filter((item) => item.action === 'send_msg').length, 1);
});
