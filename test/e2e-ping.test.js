// Task 7 验证（spec G1/G6/G7）：E2E——MVP 验收标准「群里发 ping，机器人回 pong，
// 日志里能看到完整流通路径」的自动化等价（bot-core-design §2.3 一条 ping 的旅行）。
// 装配入口 index.js import 即启动：本文件不自行 register / startConnection，
// 只动态 import('../src/index.js') 完成「装配 → 连接 → 注入 → 断言」。
// 模式：起 mock（带 token）→ 设 env → monkey-patch console.log（logger 三级均走
// console.log，patch 必须在事件流动前完成）→ 动态 import → waitForConnectionCount(1)
// → injectEvent → 断言 → 清理（stopConnection + mock.close + 删 tmp）。
// 各用例共用同一 env 组合，靠互不相同的 group_id / user_id 天然隔离会话文件与出站帧。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startMockServer } from './mock-onebot.js';

const TOKEN = 'test-token';
const DATA_DIR = `tmp/test-e2e-${process.pid}`; // 进程级唯一，避免崩溃残留污染「恰 1 行」断言
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

// ---- 日志捕获（G7）：logger 的 INFO/WARN/ERROR 均经 console.log，patch 先于一切事件流动 ----
const logLines = [];
const originalLog = console.log;
console.log = (...args) => logLines.push(args.map(String).join(' '));

// ---- 文件级装配：mock → env → 动态 import index.js（装配即启动）----
const server = await startMockServer({ token: TOKEN });
process.env.ONEBOT_WS_URL = server.url;
process.env.ONEBOT_ACCESS_TOKEN = TOKEN;
process.env.SEND_INTERVAL_MS = String(SEND_INTERVAL_MS);
process.env.RECONNECT_DELAY_MS = '200';
process.env.API_TIMEOUT_MS = '2000';
process.env.DATA_DIR = DATA_DIR;

await import('../src/index.js'); // 装配：register(ping) + onEvent(dispatch) + startConnection()
const onebot = await import('../src/connection/onebot.js'); // 同一模块实例，仅用于收口清理

after(async () => {
  await delay(SEND_INTERVAL_MS * 3); // 等发送队列的间隔定时器自然落定
  onebot.stopConnection();
  await server.close();
  console.log = originalLog;
  await rm(DATA_DIR, { recursive: true, force: true });
});

// 「装配即启动」的等价断言：不调用 startConnection，连接也应由 import 建立起来
await server.waitForConnectionCount(1);
// 客户端 open 确认：「已连接」日志出现后，后续注入的事件才保证被收到（也保证 G7 首段已捕获）
await waitUntil(() => logLines.some((line) => line.includes('已连接 OneBot 服务')));

// ---- 事件构造：每用例独立 group_id / user_id，会话文件与出站帧互不干扰 ----
let messageSeq = 0;
function groupEvent(raw, groupId, userId, nickname = '测试者') {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    user_id: userId,
    time: 1760001000 + ++messageSeq,
    message_id: -300000 + messageSeq,
    raw_message: raw,
    sender: { nickname, card: '', role: 'member' },
  };
}
function privateEvent(raw, userId, nickname = '私聊者') {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: userId,
    time: 1760001000 + ++messageSeq,
    message_id: -300000 + messageSeq,
    raw_message: raw,
    sender: { nickname, card: '', role: '' },
  };
}

test('A 群聊 ping 全链路（G1）：注入群消息 ping → mock 收到 send_msg(pong) 回到同一群', { timeout: 10000 }, async () => {
  server.injectEvent(groupEvent('ping', 741883823, 2434546640, '测试者'));

  const frame = await server.waitForFrame(
    (f) => f.action === 'send_msg' && f.params?.message === 'pong' && f.params?.group_id === 741883823
  );
  assert.equal(frame.action, 'send_msg');
  assert.equal(frame.params.message, 'pong');
  assert.equal(frame.params.message_type, 'group');
  assert.equal(frame.params.group_id, 741883823);
});

test('B 私聊 ping 全链路：mock 收到 send_msg(pong) 回到同一私聊用户', { timeout: 10000 }, async () => {
  server.injectEvent(privateEvent('ping', 999, '私聊者'));

  const frame = await server.waitForFrame(
    (f) => f.action === 'send_msg' && f.params?.message === 'pong' && f.params?.user_id === 999
  );
  assert.equal(frame.action, 'send_msg');
  assert.equal(frame.params.message, 'pong');
  assert.equal(frame.params.message_type, 'private');
  assert.equal(frame.params.user_id, 999);
});

test('C 非精确不回复：注入 pingg，等待窗口内无任何新出站帧（更无 send_msg）', { timeout: 10000 }, async () => {
  const baseline = server.frames.length;
  server.injectEvent(groupEvent('pingg', 555001, 2434546641, '手滑者'));
  await delay(400); // 覆盖「入队 → 限流出队 → 应答」全流程的观察窗口（sendIntervalMs=50 的 8 倍）
  const newFrames = server.frames.slice(baseline);
  assert.equal(newFrames.length, 0, `pingg 不应产生任何出站帧：${JSON.stringify(newFrames)}`);
  assert.equal(newFrames.filter((f) => f.action === 'send_msg').length, 0, 'pingg 不得触发 send_msg');
});

test('D 带空白命中：raw_message="  ping  " 去除首尾空白后仍回 pong', { timeout: 10000 }, async () => {
  server.injectEvent(groupEvent('  ping  ', 555002, 2434546642, '空格君'));

  const frame = await server.waitForFrame(
    (f) => f.action === 'send_msg' && f.params?.message === 'pong' && f.params?.group_id === 555002
  );
  assert.equal(frame.action, 'send_msg');
  assert.equal(frame.params.message, 'pong');
  assert.equal(frame.params.message_type, 'group');
  assert.equal(frame.params.group_id, 555002);
});

test('E 完整流通路径日志（G7）：启动 → 已连接 → 收到消息 → 触发器命中 → 发送确认 按序出现', { timeout: 10000 }, async () => {
  // 用例 A 的 pong 早已应答完成，四段日志此刻必然齐备；waitUntil 兜底等待最后一段落定
  await waitUntil(() =>
    ['已连接 OneBot 服务', '收到消息: [g-', '触发器命中: ping', '发送确认: message_id='].every((seg) =>
      logLines.some((line) => line.includes(seg))
    )
  );

  // 顺序断言：各段取「首次出现」的索引逐一比较
  const firstIndex = (seg) => logLines.findIndex((line) => line.includes(seg));
  const iStart = logLines.findIndex((line) => line.includes('Bot 核心启动') && line.includes(server.url));
  const iConn = firstIndex('已连接 OneBot 服务');
  const iRecv = firstIndex('收到消息: [g-');
  const iHit = firstIndex('触发器命中: ping');
  const iAck = firstIndex('发送确认: message_id=');

  assert.ok(iStart !== -1, `启动日志应出现且含目标 wsUrl：${logLines.join(' | ')}`);
  assert.ok(iConn !== -1 && iRecv !== -1 && iHit !== -1 && iAck !== -1, '四段流通路径日志均应出现');
  assert.ok(iStart < iConn, `启动日志应先于「已连接」（${iStart} < ${iConn}）`);
  assert.ok(iConn < iRecv, `「已连接」应先于「收到消息」（${iConn} < ${iRecv}）`);
  assert.ok(iRecv < iHit, `「收到消息」应先于「触发器命中」（${iRecv} < ${iHit}）`);
  assert.ok(iHit < iAck, `「触发器命中」应先于「发送确认」（${iHit} < ${iAck}）`);
});

test('F E2E 落盘（G6 + aichat 回存演进）：g-741883823.jsonl 恰 2 行（入站 ping + bot pong）', { timeout: 10000 }, async () => {
  const file = join(MSG_DIR, 'g-741883823.jsonl');
  // 存储为 fire-and-forget 异步写：轮询等待两行齐备（入站 + bot 回复）
  await waitUntil(async () => {
    try {
      return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '').length === 2;
    } catch {
      return false;
    }
  });
  await delay(SEND_INTERVAL_MS * 2); // 留出观察窗口（用例 A 的 pong 早已出站）

  const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 2, '恰 2 行：入站 ping + bot:true 的 pong 回存');
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.sessionKey, 'g-741883823');
  assert.equal(rec.raw_message, 'ping');
  assert.equal(rec.user_id, 2434546640);
  assert.equal(rec.group_id, 741883823);
  assert.equal(rec.message_type, 'group');
  assert.equal(rec.sender.nickname, '测试者');
  assert.ok(!rec.bot, '入站行不带 bot 标记');
  const botLine = JSON.parse(lines[1]);
  assert.equal(botLine.bot, true, '回复 pong 以 bot:true 回存（add-aichat-mvp spec）');
  assert.equal(botLine.raw_message, 'pong');
  assert.equal(botLine.sessionKey, 'g-741883823');
  assert.ok(!('message_id' in botLine), 'bot 行不应有 message_id');
});

test('G 非 message 事件静默：注入 meta_event.heartbeat，无任何出站帧', { timeout: 10000 }, async () => {
  const baseline = server.frames.length;
  server.injectEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat', time: 1760002000, self_id: 10000 });
  await delay(300);
  assert.equal(server.frames.length, baseline, '心跳事件不得产生任何出站帧');
});
