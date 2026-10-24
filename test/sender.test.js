// Task 4 验证（spec G5）：L4 发送层——统一 send_msg 收口（禁止 send_group_msg /
// send_private_msg）、参数正确、固定间隔限流、单条失败续发。
// 模式：先起 mock → 设 env（SEND_INTERVAL_MS=100 缩短限流间隔便于计时）→ 动态 import。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer } from './mock-onebot.js';

const TOKEN = 'sender-test-token';

// ---- 文件级装配：mock → env → 动态 import ----
const server = await startMockServer({ token: TOKEN });
process.env.ONEBOT_WS_URL = server.url;
process.env.ONEBOT_ACCESS_TOKEN = TOKEN;
process.env.SEND_INTERVAL_MS = '100';
process.env.RECONNECT_DELAY_MS = '100';
process.env.API_TIMEOUT_MS = '2000';

const sender = await import('../src/sender/sender.js');
const onebot = await import('../src/connection/onebot.js');
const { config } = await import('../src/config.js');

after(async () => {
  // 先等发送队列自然清空（最后一条的应答与间隔定时器落定），再停连接与 mock
  await delay(config.sendIntervalMs * 2);
  onebot.stopConnection();
  await server.close();
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 服务端接受连接与客户端 open 事件存在竞态：用探测调用轮询，直到 callApi 真正可用
// （不再因「WS 未连接」被拒），保证后续 sendGroup/sendPrivate 出站的帧确实能发出。
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

// 全文件共用一条已建立的连接（sender 内部经 callApi 复用它）
onebot.startConnection();
await server.waitForConnectionCount(1);
await waitForApiReady();

test('sendGroup / sendPrivate 统一走 send_msg，参数正确', { timeout: 10000 }, async () => {
  sender.sendGroup(123, 'a');
  sender.sendPrivate(456, 'b');

  const groupFrame = await server.waitForFrame((f) => f.action === 'send_msg' && f.params?.message === 'a');
  const privateFrame = await server.waitForFrame((f) => f.action === 'send_msg' && f.params?.message === 'b');

  assert.equal(groupFrame.action, 'send_msg');
  assert.equal(groupFrame.params.message_type, 'group');
  assert.equal(groupFrame.params.group_id, 123);
  assert.equal(groupFrame.params.message, 'a');
  assert.ok(!('user_id' in groupFrame.params), '群发参数不应携带 user_id');

  assert.equal(privateFrame.action, 'send_msg');
  assert.equal(privateFrame.params.message_type, 'private');
  assert.equal(privateFrame.params.user_id, 456);
  assert.equal(privateFrame.params.message, 'b');
  assert.ok(!('group_id' in privateFrame.params), '私发参数不应携带 group_id');
});

test('限流：连续两条出站帧到达间隔 >= sendIntervalMs * 0.9', { timeout: 10000 }, async () => {
  sender.sendGroup(777, 'r1');
  sender.sendGroup(777, 'r2');

  // waitForFrame 在帧到达即 resolve（mock 与测试同进程），逐条等待并记录到达时刻
  await server.waitForFrame((f) => f.params?.message === 'r1');
  const firstAt = Date.now();
  await server.waitForFrame((f) => f.params?.message === 'r2');
  const secondAt = Date.now();

  const minGap = Math.floor(config.sendIntervalMs * 0.9);
  assert.ok(secondAt - firstAt >= minGap, `两条出站帧到达间隔 ${secondAt - firstAt}ms，应 >= ${minGap}ms`);
});

test('失败续发：首条失败记 WARN（含 wording），第二条仍成功出站', { timeout: 10000 }, async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  try {
    server.failNextCall(); // 默认 retcode=1400, wording='mock failure'
    sender.sendGroup(888, 'f1');
    sender.sendGroup(888, 'f2');

    const f1 = await server.waitForFrame((f) => f.action === 'send_msg' && f.params?.message === 'f1');
    const f2 = await server.waitForFrame((f) => f.action === 'send_msg' && f.params?.message === 'f2');
    assert.equal(f1.action, 'send_msg');
    assert.equal(f2.action, 'send_msg', '第一条失败后第二条仍应出站');
  } finally {
    console.log = originalLog;
  }

  assert.ok(
    logs.some((line) => line.includes('WARN') && line.includes('发送失败')),
    `首条失败应记 WARN：${logs.join(' | ')}`
  );
  assert.ok(logs.some((line) => line.includes('mock failure')), '失败信息应包含 wording');

  // 唯一收口：全程不允许出现 send_group_msg / send_private_msg 直调
  assert.ok(
    server.frames.every((f) => f.action !== 'send_group_msg' && f.action !== 'send_private_msg'),
    '出站 action 必须全部为 send_msg'
  );
});
