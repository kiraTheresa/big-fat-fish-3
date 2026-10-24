// Task 5 验证（spec G3）：L2 分发层——非 message 事件拦截、sessionKey 打标（g-/p-）、
// 命中即停、全不匹配静默、match/handle 抛异常记 ERROR 且不影响后续事件、
// ctx.reply 群/私聊路由。mock + 真连接 + 真 sender 全链路。
// 模式：先起 mock → 设 env → 动态 import；注册表为模块级状态，用例间通过互斥的
// raw_message 前缀隔离各自的测试触发器（node:test 同文件内按声明顺序串行执行）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { startMockServer } from './mock-onebot.js';

const TOKEN = 'dispatch-test-token';
const DATA_DIR = 'tmp/test-dispatch';
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

// 服务端接受连接与客户端 open 事件存在竞态：用探测调用轮询，直到 callApi 真正可用
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

let messageSeq = 0;
function groupEvent(raw, groupId = 123, userId = 1001) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    user_id: userId,
    time: 1760000000 + ++messageSeq,
    message_id: -100000 + messageSeq,
    raw_message: raw,
    sender: { nickname: `成员${userId}`, card: '', role: 'member' },
  };
}
function privateEvent(raw, userId = 456) {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: userId,
    time: 1760000000 + ++messageSeq,
    message_id: -100000 + messageSeq,
    raw_message: raw,
    sender: { nickname: `用户${userId}`, card: '', role: '' },
  };
}

// 全链路接线：事件 → dispatcher（内部经 registry 匹配、经 sender 出站）
onebot.onEvent(dispatcher.dispatch);
onebot.startConnection();
await server.waitForConnectionCount(1);
await waitForApiReady();

test('非 message 事件拦截：meta_event / notice 注入后无出站帧', { timeout: 10000 }, async () => {
  const baseline = server.frames.length;
  server.injectEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat', time: 1760000100, self_id: 10000 });
  server.injectEvent({ post_type: 'notice', notice_type: 'group_upload', time: 1760000101, group_id: 123, user_id: 1001 });
  await delay(250);
  assert.equal(server.frames.length, baseline, '非 message 事件不得触发任何出站帧');
});

test('打标：群消息 ctx.sessionKey === g-{group_id}，私聊 === p-{user_id}', { timeout: 10000 }, async () => {
  const captured = [];
  registry.register({
    name: 'sk-probe',
    match: (e) => e.raw_message.startsWith('sk-'),
    handle: (ctx) => { captured.push(ctx); },
  });

  server.injectEvent(groupEvent('sk-group', 777, 2002));
  await waitUntil(() => captured.length === 1);
  assert.equal(captured[0].sessionKey, 'g-777');
  assert.equal(captured[0].event.raw_message, 'sk-group');

  server.injectEvent(privateEvent('sk-private', 888));
  await waitUntil(() => captured.length === 2);
  assert.equal(captured[1].sessionKey, 'p-888');
  assert.equal(captured[1].event.message_type, 'private');
});

test('命中即停：两个触发器均可匹配，仅注册在前者执行 handle', { timeout: 10000 }, async () => {
  const calls = [];
  registry.register({ name: 'stop-first', match: (e) => e.raw_message === 'stop-me', handle: () => { calls.push('first'); } });
  registry.register({ name: 'stop-second', match: (e) => e.raw_message === 'stop-me', handle: () => { calls.push('second'); } });

  server.injectEvent(groupEvent('stop-me'));
  await waitUntil(() => calls.length === 1);
  await delay(150); // 给「second」留出误执行的窗口
  assert.deepEqual(calls, ['first'], '仅注册顺序在前的触发器应执行');
});

test('全不匹配：无出站帧、无 ERROR，静默', { timeout: 10000 }, async () => {
  const baseline = server.frames.length;
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  try {
    server.injectEvent(groupEvent('nobody-matches-me'));
    await delay(250);
  } finally {
    console.log = originalLog;
  }
  assert.equal(server.frames.length, baseline, '全不匹配不得产生出站帧');
  assert.ok(!logs.some((line) => line.includes('ERROR')), `全不匹配应静默：${logs.join(' | ')}`);
});

test('match 抛异常：记 ERROR，同事件后序触发器仍被尝试、后续事件正常', { timeout: 10000 }, async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  let fallbackRan = false;
  registry.register({
    name: 'err-match',
    match: (e) => { if (e.raw_message.startsWith('em-')) throw new Error('match 事故'); return false; },
    handle: () => {},
  });
  registry.register({ name: 'em-fallback', match: (e) => e.raw_message.startsWith('em-'), handle: () => { fallbackRan = true; } });
  try {
    server.injectEvent(groupEvent('em-hello'));
    await waitUntil(() => fallbackRan === true);
    await delay(50);
  } finally {
    console.log = originalLog;
  }

  assert.ok(
    logs.some((line) => line.includes('ERROR') && line.includes('err-match') && line.includes('match 异常')),
    `match 异常应记 ERROR：${logs.join(' | ')}`
  );
  assert.ok(fallbackRan, 'match 异常的触发器作废后，后序触发器仍应被尝试');
  // 顺带验证「完整流通路径」中间两段日志：收到消息（含 sessionKey）→ 触发器命中（含触发器名）
  assert.ok(
    logs.some((line) => line.includes('收到消息') && line.includes('[g-123]')),
    `收到消息应记 INFO 且含 sessionKey：${logs.join(' | ')}`
  );
  assert.ok(
    logs.some((line) => line.includes('触发器命中') && line.includes('em-fallback')),
    `命中应记 INFO 且含触发器名：${logs.join(' | ')}`
  );

  // 后续事件仍正常分发
  const seen = [];
  registry.register({ name: 'em-after', match: (e) => e.raw_message === 'later-ok', handle: (ctx) => { seen.push(ctx.sessionKey); } });
  server.injectEvent(privateEvent('later-ok'));
  await waitUntil(() => seen.length === 1);
  assert.equal(seen[0], 'p-456');
});

test('handle 抛异常：记 ERROR，后续事件仍正常分发处理', { timeout: 10000 }, async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  registry.register({ name: 'err-handle', match: (e) => e.raw_message === 'boom', handle: () => { throw new Error('handle 事故'); } });
  try {
    server.injectEvent(groupEvent('boom'));
    await waitUntil(() => logs.some((line) => line.includes('ERROR') && line.includes('err-handle') && line.includes('处理异常')));
  } finally {
    console.log = originalLog;
  }

  // 后续事件仍正常分发处理（含 reply 出站）
  const seen = [];
  registry.register({ name: 'after-probe', match: (e) => e.raw_message === 'after-ok', handle: (ctx) => { seen.push(ctx.sessionKey); ctx.reply('after-ok-back'); } });
  server.injectEvent(privateEvent('after-ok'));
  await waitUntil(() => seen.length === 1);
  const frame = await server.waitForFrame((f) => f.action === 'send_msg' && f.params?.message === 'after-ok-back');
  assert.equal(seen[0], 'p-456');
  assert.equal(frame.params.message_type, 'private', 'handle 异常不影响后续事件的回复出站');
});

test('reply 路由：群聊 reply 走 sendGroup、私聊走 sendPrivate', { timeout: 10000 }, async () => {
  registry.register({
    name: 'reply-probe',
    match: (e) => e.raw_message.startsWith('rp-'),
    handle: (ctx) => { ctx.reply(`${ctx.sessionKey}-back`); },
  });

  server.injectEvent(groupEvent('rp-group', 999, 3003));
  const groupFrame = await server.waitForFrame((f) => f.action === 'send_msg' && f.params?.message === 'g-999-back');
  assert.equal(groupFrame.params.message_type, 'group');
  assert.equal(groupFrame.params.group_id, 999);

  server.injectEvent(privateEvent('rp-private', 777));
  const privateFrame = await server.waitForFrame((f) => f.action === 'send_msg' && f.params?.message === 'p-777-back');
  assert.equal(privateFrame.params.message_type, 'private');
  assert.equal(privateFrame.params.user_id, 777);
});
