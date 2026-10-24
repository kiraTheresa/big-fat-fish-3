// Task 3 验证（spec G2）：L1 连接层——正确 token 连接、错误 token 被拒、
// callApi resolve / reject（含 wording）、调用超时、断线自动重连、坏帧丢弃。
// 模式：先起 mock → 设 env → 动态 import src 模块（config 在首次 import 时求值；
// node:test 每个测试文件独立进程，本文件全程共用同一份 config 实例，
// 故 RECONNECT_DELAY_MS=100 与 API_TIMEOUT_MS=200 同时设置、全部用例共享）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer } from './mock-onebot.js';

const TOKEN = 'conn-test-token';
const RECONNECT_DELAY_MS = 100;
const API_TIMEOUT_MS = 200;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(cond, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitUntil 超时（${timeoutMs}ms 内条件未满足）`);
    await delay(stepMs);
  }
}

// 服务端接受连接与客户端 open 事件存在竞态：waitForConnectionCount 只反映服务端视角。
// 用探测调用轮询，直到 callApi 真正可用（不再因「WS 未连接」被拒）。
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

// ---- 文件级装配：mock → env → 动态 import ----
const server = await startMockServer({ token: TOKEN });
process.env.ONEBOT_WS_URL = server.url;
process.env.ONEBOT_ACCESS_TOKEN = TOKEN;
process.env.RECONNECT_DELAY_MS = String(RECONNECT_DELAY_MS);
process.env.API_TIMEOUT_MS = String(API_TIMEOUT_MS);

const onebot = await import('../src/connection/onebot.js');
const { config } = await import('../src/config.js');

after(async () => {
  onebot.stopConnection();
  await server.close();
});

// 把连接收敛到确定状态：先停净（当前在线连接归零）再以正确 token 重连
async function restartConnection() {
  onebot.stopConnection();
  await waitUntil(() => server.connections === 0);
  onebot.startConnection();
  await server.waitForConnectionCount(1);
  await waitForApiReady(); // 等客户端侧 open 真正完成，后续 callApi 不受竞态影响
}

test('正确 token：连接成功，mock 侧 connections >= 1', { timeout: 10000 }, async () => {
  await restartConnection();
  assert.ok(server.connections >= 1);
});

test('错误 token：连接被 mock 拒绝（关闭），记 WARN 按间隔重连，不崩溃', { timeout: 10000 }, async () => {
  onebot.stopConnection();
  await waitUntil(() => server.connections === 0);

  // 本文件仅一份 config 实例：临时改写 accessToken 模拟「客户端持有错误 token」，用毕恢复
  const savedToken = config.accessToken;
  const logs = [];
  const originalLog = console.log;
  config.accessToken = 'definitely-wrong-token';
  console.log = (...args) => logs.push(args.map(String).join(' '));
  try {
    onebot.startConnection();
    await delay(RECONNECT_DELAY_MS * 4); // 覆盖至少两次「被拒 → 重连」循环
  } finally {
    console.log = originalLog;
    onebot.stopConnection();
    config.accessToken = savedToken;
  }

  assert.equal(server.connections, 0, '错误 token 的连接不应被 mock 接受');
  const disconnects = logs.filter((line) => line.includes('连接断开'));
  assert.ok(
    disconnects.length >= 2,
    `被拒后应持续重连（至少 2 次断开记录），实际 ${disconnects.length} 次：${logs.join(' | ')}`
  );
});

test('callApi resolve：mock 自动应答 retcode=0，resolve 出 data.message_id', { timeout: 10000 }, async () => {
  await restartConnection();
  const data = await onebot.callApi('send_msg', { message_type: 'group', group_id: 123, message: 'x' });
  assert.equal(typeof data.message_id, 'number');
});

test('callApi reject：retcode!=0 时 reject，错误信息含 wording', { timeout: 10000 }, async () => {
  await restartConnection();
  server.failNextCall(1404, 'action 不存在');
  await assert.rejects(onebot.callApi('nonexistent_action', {}), /action 不存在/);
});

test('超时：API_TIMEOUT_MS 内无应答则 reject 超时', { timeout: 10000 }, async () => {
  await restartConnection();
  server.setAutoRespond(false);
  try {
    const timeoutProbe = assert.rejects(
      onebot.callApi('send_msg', { message_type: 'group', group_id: 1, message: 'timeout-probe' }),
      /API 调用超时/
    );
    // 帧已发出且被 mock 记录，只是无人应答
    await server.waitForFrame((f) => f.action === 'send_msg' && f.params?.message === 'timeout-probe');
    await timeoutProbe;
  } finally {
    server.setAutoRespond(true);
  }
});

test('断线自动重连：mock 主动断开后按 reconnectDelayMs 自动重连成功', { timeout: 10000 }, async () => {
  await restartConnection();
  server.disconnectClients();
  // 说明：mock 的 connections / waitForConnectionCount 统计「当前在线连接数」——
  // disconnectClients 后旧连接即被移除，重连成功的判据是在线数 0 → 1（而非累计连接数 2）。
  await waitUntil(() => server.connections === 0);
  await server.waitForConnectionCount(1, { timeoutMs: 3000 });
  // 重连后的新连接链路可用（echo 应答正常；探测轮询同时化解 open 事件竞态）
  const data = await waitForApiReady();
  assert.equal(typeof data.message_id, 'number');
});

test('坏帧：非 JSON 输入丢弃，不崩溃、不上抛事件；合法事件仍正常上抛', { timeout: 10000 }, async () => {
  const events = [];
  onebot.onEvent((event) => events.push(event));
  await restartConnection();

  server.sendRaw('not-json');
  await delay(150);
  assert.equal(events.length, 0, '坏帧不得上抛为事件');

  // 对照：合法事件帧正常上抛，证明上抛通道本身畅通
  const goodEvent = { post_type: 'message', message_type: 'group', group_id: 123, raw_message: 'ping' };
  server.injectEvent(goodEvent);
  await waitUntil(() => events.length === 1);
  assert.deepEqual(events[0], goodEvent);

  onebot.onEvent(null); // 还原，避免影响后续用例
});
