// Task 4 验证（spec G5）：L4 发送层——统一 send_msg 收口（禁止 send_group_msg /
// send_private_msg）、参数正确、固定间隔限流、单条失败续发。
// upgrade-chat-pipeline Task 8 增补：发送确认成功后出站 message_id 记入 bot-msg-ids
// 集合（replyQuote 条件模块的数据源），失败路径不入集。
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

// ---- upgrade-chat-pipeline Task 8：发送确认记录出站 message_id ----

const { clearBotMessageIds, isBotMessageId } = await import('../src/sender/bot-msg-ids.js');

// 响应回程与 sender 记录存在微小时序差（waitForFrame 在帧到达即 resolve），轮询收敛
async function waitUntil(cond, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil 超时（${timeoutMs}ms 内条件未满足）`);
    await delay(stepMs);
  }
}

// 扫描集合中 mock 可能分配过的 id（nextMessageId 从 1000 起递增，上界 = 1000+累计
// action 帧数再放宽）。失败帧不占 id 序号，帧序与 id 序会错位，故不推断具体数值、
// 只按「clear 后新增了哪些 id」观察
function scanRecordedIds() {
  const found = [];
  for (let id = 1000; id <= 1000 + server.frames.length + 2; id++) {
    if (isBotMessageId(id)) found.push(id);
  }
  return found;
}

test('发送确认记录钩子：成功确认的 message_id 入 bot-msg-ids 集合，失败不入集', { timeout: 10000 }, async () => {
  // 先等 drain 静默：上一用例（失败续发）返回时 f2 的确认 record 可能还在途
  // （waitForFrame 在帧到达即 resolve，响应回程滞后），不等待就 clear 会与在途
  // record 竞态。sendIntervalMs=100，等 200ms 覆盖「响应回程 + 间隔定时器」全程
  await delay(200);

  // 成功路径：clear 后集合从空 → 恰新增一个 id（probe 不经 sender.drain，不会被记录）
  clearBotMessageIds();
  sender.sendGroup(999, 'id-record');
  await server.waitForFrame((f) => f.action === 'send_msg' && f.params?.message === 'id-record');
  await waitUntil(() => scanRecordedIds().length === 1, { timeoutMs: 2000 });
  const [recordedId] = scanRecordedIds();
  assert.ok(Number.isInteger(recordedId), '新增记录应为 mock 分配的数字 id');
  assert.equal(isBotMessageId(String(recordedId)), true, '数字入集字符串查应命中（两型归一）');

  // 失败路径：failNextCall 无成功确认，集合不得有任何新增（仍只有上一次的记录）
  server.failNextCall();
  sender.sendGroup(888, 'fail-no-record');
  await server.waitForFrame((f) => f.action === 'send_msg' && f.params?.message === 'fail-no-record');
  await delay(150); // 观察窗：若失败被误记录，此刻集合必已可见
  assert.deepEqual(
    scanRecordedIds(),
    [recordedId],
    '发送失败不得新增记录（仅 retcode=0 路径入集）'
  );
});
