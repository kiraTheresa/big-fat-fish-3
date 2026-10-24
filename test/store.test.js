// Task 6 验证（spec G6）：消息存储——群/私聊 JSONL 落盘路径与字段形状、
// 同会话 append-only、出站回复不回存。mock + 真连接 + 真 dispatcher 全链路。
// 模式：先起 mock → 设 env → 动态 import；DATA_DIR 注入 tmp/test-store，after 清理。
// 存储故障隔离用例需要不同的 DATA_DIR，拆在独立文件 test/store-failure.test.js。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startMockServer } from './mock-onebot.js';

const TOKEN = 'store-test-token';
const DATA_DIR = 'tmp/test-store';
const MSG_DIR = join(DATA_DIR, 'messages');
const SEND_INTERVAL_MS = 50;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(cond, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil 超时（${timeoutMs}ms 内条件未满足）`);
    await delay(stepMs);
  }
}

// ---- 文件级装配：mock → env → 动态 import ----
const server = await startMockServer({ token: TOKEN });
process.env.ONEBOT_WS_URL = server.url;
process.env.ONEBOT_ACCESS_TOKEN = TOKEN;
process.env.SEND_INTERVAL_MS = String(SEND_INTERVAL_MS);
process.env.RECONNECT_DELAY_MS = '100';
process.env.API_TIMEOUT_MS = '2000';
process.env.DATA_DIR = DATA_DIR;

const onebot = await import('../src/connection/onebot.js');
const dispatcher = await import('../src/dispatch/dispatcher.js');
const registry = await import('../src/dispatch/registry.js');

after(async () => {
  await delay(SEND_INTERVAL_MS * 3); // 等发送队列的间隔定时器自然落定
  onebot.stopConnection();
  await server.close();
  await rm(DATA_DIR, { recursive: true, force: true });
});

async function waitForApiReady() {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return await onebot.callApi('send_msg', { message_type: 'group', group_id: 0, message: 'ready-probe' });
    } catch (err) {
      if (!err.message.includes('WS 未连接') || Date.now() > deadline) throw err;
      await delay(10);
    }
  }
}

onebot.onEvent(dispatcher.dispatch);
registry.register({
  name: 'store-echo',
  match: (e) => e.raw_message.startsWith('hi'),
  handle: (ctx) => { ctx.reply('echo-back'); },
});
onebot.startConnection();
await server.waitForConnectionCount(1);
await waitForApiReady();

async function readLines(sessionKey) {
  const text = await readFile(join(MSG_DIR, `${sessionKey}.jsonl`), 'utf8');
  return text.split('\n').filter((line) => line !== '');
}

test('群消息落盘：g-{group_id}.jsonl 追加一行，JSON 可解析、字段完整正确；回复不回存', { timeout: 10000 }, async () => {
  server.injectEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 123,
    user_id: 1001,
    time: 1760000501,
    message_id: 5001,
    raw_message: 'hi group',
    sender: { nickname: '阿群', card: '', role: 'member' },
  });

  // 回复仍正常出站：证明 fire-and-forget 存储不阻塞主管道
  const replyFrame = await server.waitForFrame(
    (f) => f.action === 'send_msg' && f.params?.message === 'echo-back' && f.params?.group_id === 123
  );
  assert.equal(replyFrame.action, 'send_msg');

  // 落盘为 fire-and-forget 异步写：轮询等待文件出现
  await waitUntil(async () => {
    try {
      return (await readLines('g-123')).length === 1;
    } catch {
      return false;
    }
  });

  const lines = await readLines('g-123');
  assert.equal(lines.length, 1, '一条入站消息应恰好一行');
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.sessionKey, 'g-123');
  assert.equal(rec.time, 1760000501);
  assert.equal(rec.message_id, 5001);
  assert.equal(rec.message_type, 'group');
  assert.equal(rec.group_id, 123);
  assert.equal(rec.user_id, 1001);
  assert.equal(rec.raw_message, 'hi group');
  assert.deepEqual(rec.sender, { nickname: '阿群', card: '', role: 'member' });

  // 出站回复不回存：回复已出站（上方 waitForFrame），等待超过一个发送间隔后行数不变
  await delay(SEND_INTERVAL_MS * 4);
  assert.equal((await readLines('g-123')).length, 1, '出站回复不得回存（仍只含入站那条）');
});

test('append-only：同会话第二条消息后文件恰好 2 行', { timeout: 10000 }, async () => {
  server.injectEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 123,
    user_id: 1002,
    time: 1760000502,
    message_id: 5002,
    raw_message: 'hi again',
    sender: { nickname: '阿二', card: '', role: 'member' },
  });
  await waitUntil(async () => (await readLines('g-123')).length === 2);

  const lines = await readLines('g-123');
  assert.equal(lines.length, 2, '同会话两条消息应恰好 2 行（追加而非覆盖）');
  const first = JSON.parse(lines[0]);
  const second = JSON.parse(lines[1]);
  assert.equal(first.message_id, 5001, '首条记录应原样保留');
  assert.equal(second.sessionKey, 'g-123');
  assert.equal(second.time, 1760000502);
  assert.equal(second.message_id, 5002);
  assert.equal(second.user_id, 1002);
  assert.equal(second.raw_message, 'hi again');
});

test('私聊落盘：p-{user_id}.jsonl，快照不含 group_id', { timeout: 10000 }, async () => {
  server.injectEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 456,
    time: 1760000503,
    message_id: 5003,
    raw_message: 'yo private',
    sender: { nickname: '阿私', card: '', role: '' },
  });
  await waitUntil(async () => {
    try {
      return (await readLines('p-456')).length === 1;
    } catch {
      return false;
    }
  });

  const lines = await readLines('p-456');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.sessionKey, 'p-456');
  assert.equal(rec.time, 1760000503);
  assert.equal(rec.message_id, 5003);
  assert.equal(rec.message_type, 'private');
  assert.equal(rec.user_id, 456);
  assert.equal(rec.raw_message, 'yo private');
  assert.deepEqual(rec.sender, { nickname: '阿私', card: '', role: '' });
  assert.ok(!('group_id' in rec), '私聊快照不应包含 group_id 字段');
});
