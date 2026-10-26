// Task 6 验证（spec G6「存储故障隔离」）：DATA_DIR 指向一个已存在的普通文件 →
// mkdir {DATA_DIR}/messages 失败（ENOTDIR），仅记 WARN 不崩；
// 触发器仍执行、回复仍出站。
// ⚠ 独立测试文件：与 store.test.js 需要不同的 DATA_DIR，node:test 每文件独立进程，
// config 实例天然隔离（env 必须在 import config 之前设置）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { startMockServer } from './mock-onebot.js';

const TOKEN = 'store-failure-token';
const BLOCKER = 'tmp/test-blocker'; // 一个普通文件，充当「不可创建子目录的 DATA_DIR」
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

// ---- 文件级装配：先造故障现场（普通文件）→ mock → env → 动态 import ----
await mkdir('tmp', { recursive: true });
await writeFile(BLOCKER, 'this is a plain file, not a directory', { flag: 'w' });

const server = await startMockServer({ token: TOKEN });
process.env.ONEBOT_WS_URL = server.url;
process.env.ONEBOT_ACCESS_TOKEN = TOKEN;
process.env.SEND_INTERVAL_MS = String(SEND_INTERVAL_MS);
process.env.RECONNECT_DELAY_MS = '100';
process.env.API_TIMEOUT_MS = '2000';
process.env.DATA_DIR = BLOCKER;

const onebot = await import('../src/connection/onebot.js');
const dispatcher = await import('../src/dispatch/dispatcher.js');
const registry = await import('../src/dispatch/registry.js');

after(async () => {
  await delay(SEND_INTERVAL_MS * 3); // 等发送队列的间隔定时器自然落定
  onebot.stopConnection();
  await server.close();
  await rm(BLOCKER, { force: true });
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
  name: 'failure-echo',
  match: (e) => e.raw_message === 'ping',
  handle: (ctx) => { ctx.reply('pong'); },
});
onebot.startConnection();
await server.waitForConnectionCount(1);
await waitForApiReady();

test('存储故障隔离：mkdir 失败仅记 WARN，触发器仍执行、回复仍出站，进程不崩', { timeout: 10000 }, async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  try {
    server.injectEvent({
      post_type: 'message',
      message_type: 'group',
      group_id: 123,
      user_id: 1001,
      time: 1760000601,
      message_id: 6001,
      raw_message: 'ping',
      sender: { nickname: '触发者', card: '', role: 'member' },
    });

    // 触发器仍执行（handle 内 reply）且回复仍出站
    const frame = await server.waitForFrame((f) => f.action === 'send_msg' && f.params?.message === 'pong');
    assert.equal(frame.action, 'send_msg', '回复仍应出站');
    assert.equal(frame.params.group_id, 123);

    // fire-and-forget 的写失败是异步到达的：轮询等待 WARN 出现
    await waitUntil(() => logs.some((line) => line.includes('WARN') && line.includes('消息存储失败')));
  } finally {
    console.log = originalLog;
  }

  assert.ok(
    logs.some((line) => line.includes('WARN') && line.includes('消息存储失败')),
    `写失败应仅记 WARN：${logs.join(' | ')}`
  );
  assert.ok(
    !logs.some((line) => line.includes('ERROR')),
    `存储失败不得升级为 ERROR：${logs.join(' | ')}`
  );
});
