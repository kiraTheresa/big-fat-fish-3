// draw 触发器全链路验证（draw 接入）：mock OneBot + mock 图片 API 双服务器端到端。
// 覆盖：注册顺序静态断言（draw 必须排在 command 前，否则 /draw 被 '/' match 吃掉）、
// match 边界（'/draw 独词/带参' 命中、'/drawxxx' 不命中、非指令不命中）、白名单外
// 静默（零出站零 API 请求，防探测）、空 prompt 用法提示、群/私成功流（先回「在画了」
// → 图片段 base64:// 出站 → 占位 bot 行落盘 JSONL → prompt 原样上送 API）、
// 生成失败兜底文案、'/drawxxx' 落 command 走「不认识」（反向证明 draw 边界正确）。
// 装配（同 chat.test.js 模式）：双 mock → env → 动态 import → 手动按 index.js 顺序注册
// ping → draw → command → chat（DEEPSEEK_API_KEY 留空：chat 恒不触发，无需 LLM mock）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startMockServer } from './mock-onebot.js';
import { startImageServer, IMG_BYTES } from './image-server.js';

const TOKEN = 'draw-test-token';
const DATA_DIR = `tmp/test-draw-${process.pid}`;
const SELF_ID = 10000;
const WHITELIST_QQ = 9001; // 白名单内
const OUTSIDER_QQ = 9002; // 白名单外
const GROUP_ID = 888;
const SEND_INTERVAL_MS = 50;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(cond, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil 超时`);
    await delay(stepMs);
  }
}

// ---- 文件级装配：双 mock → env → 动态 import → 注册（ping → draw → command → chat）----
const onebotServer = await startMockServer({ token: TOKEN });
const imageServer = await startImageServer();
process.env.ONEBOT_WS_URL = onebotServer.url;
process.env.ONEBOT_ACCESS_TOKEN = TOKEN;
process.env.SEND_INTERVAL_MS = String(SEND_INTERVAL_MS);
process.env.RECONNECT_DELAY_MS = '100';
process.env.API_TIMEOUT_MS = '2000';
process.env.DATA_DIR = DATA_DIR;
process.env.DRAW_WHITELIST_QQ = String(WHITELIST_QQ);
process.env.IMAGE_API_KEY = 'test-image-key';
process.env.IMAGE_API_BASE_URL = imageServer.url;
process.env.IMAGE_TIMEOUT_MS = '2000';
process.env.DEEPSEEK_API_KEY = ''; // chat 不生效：本文件只验 draw/command 链路
// CONFIG_PATH 指向不存在路径：行为开关跑全默认，不受本机 config.json 干扰
process.env.CONFIG_PATH = join(DATA_DIR, 'absent.json');

const onebot = await import('../src/connection/onebot.js');
const dispatcher = await import('../src/dispatch/dispatcher.js');
const registry = await import('../src/dispatch/registry.js');
const ping = (await import('../src/triggers/ping.js')).default;
const draw = (await import('../src/triggers/draw.js')).default;
const command = (await import('../src/triggers/command.js')).default;
const chat = (await import('../src/triggers/chat.js')).default;

after(async () => {
  await delay(SEND_INTERVAL_MS * 3); // 等发送队列的间隔定时器自然落定
  onebot.stopConnection();
  await onebotServer.close();
  await imageServer.close();
  await rm(DATA_DIR, { recursive: true, force: true });
});

// ---- 事件构造：与 dispatcher 同入口（post_type=message + 消息段数组）----
let messageSeq = 0;
function groupDrawEvent(raw, userId) {
  ++messageSeq;
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: userId,
    self_id: SELF_ID,
    time: 1760004000 + messageSeq,
    message_id: -700000 + messageSeq,
    message: [{ type: 'text', data: { text: raw } }],
    raw_message: raw,
    sender: { nickname: `群友${userId}`, card: '', role: 'member' },
  };
}
function privateDrawEvent(raw, userId) {
  ++messageSeq;
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: userId,
    self_id: SELF_ID,
    time: 1760004000 + messageSeq,
    message_id: -700000 + messageSeq,
    message: [{ type: 'text', data: { text: raw } }],
    raw_message: raw,
    sender: { nickname: `私聊${userId}`, card: '', role: '' },
  };
}

// ---- 注册顺序静态断言（draw 排 command 前）与运行时注册 ----
// index.js 顺序的运行时镜像：先静态读装配文件本身，再按同序注册
const indexSource = await readFile('./src/index.js', 'utf8');
const posDraw = indexSource.indexOf('register(draw)');
const posCommand = indexSource.indexOf('register(command)');
assert.ok(posDraw !== -1 && posCommand !== -1 && posDraw < posCommand, 'index.js 中 draw 必须注册在 command 之前');

onebot.onEvent(dispatcher.dispatch);
registry.register(ping);
registry.register(draw);
registry.register(command);
registry.register(chat);
onebot.startConnection();
await onebotServer.waitForConnectionCount(1);
// 连接就绪探测（同 chat.test.js：WS 稳定后再放用例）
for (;;) {
  try {
    await onebot.callApi('send_msg', { message_type: 'group', group_id: 0, message: 'ready-probe' });
    break;
  } catch (err) {
    if (!err.message.includes('WS 未连接')) throw err;
    await delay(10);
  }
}
onebotServer.frames.length = 0; // 清掉探测帧，用例从零计
imageServer.requests.length = 0;

// 出站帧谓词：send_msg 文本帧（message 为 string）/ 图片段帧（message 为数组含 image 段）
const isSendMsg = (frame) => frame?.action === 'send_msg';
const textFrame = (frame) => (typeof frame?.params?.message === 'string' ? frame.params.message : null);
const imageFrame = (frame) => {
  const msg = frame?.params?.message;
  return Array.isArray(msg) && msg.some((seg) => seg?.type === 'image') ? frame : null;
};

// 帧水位：用例开始记 frames.length，谓词只认此后新增的帧——防止 waitForFrame 捞到
// 前序用例遗留的历史帧（异步管道跨用例泄漏时的串扰源）
function onlyNew(mark, pred) {
  return (f) => pred(f) && onebotServer.frames.indexOf(f) >= mark;
}

test('match 边界：/draw 独词与带参命中；/drawxxx、/help、普通消息不命中', () => {
  assert.equal(draw.match(groupDrawEvent('/draw 一只猫', WHITELIST_QQ)), true);
  assert.equal(draw.match(groupDrawEvent('/draw', WHITELIST_QQ)), true);
  assert.equal(draw.match(groupDrawEvent('/drawxxx', WHITELIST_QQ)), false); // 正则边界：防误触
  assert.equal(draw.match(groupDrawEvent('/help', WHITELIST_QQ)), false);
  assert.equal(draw.match(groupDrawEvent('你好呀', WHITELIST_QQ)), false);
});

test('白名单外（群聊）：静默——零出站帧、零图片 API 请求（防探测）', async () => {
  onebotServer.injectEvent(groupDrawEvent('/draw 一只猫', OUTSIDER_QQ));
  await delay(300); // 静默语义：给足时间也不该有任何出站
  assert.equal(onebotServer.frames.filter(isSendMsg).length, 0);
  assert.equal(imageServer.requests.length, 0);
});

test('白名单外（私聊同样校验）：静默', async () => {
  onebotServer.injectEvent(privateDrawEvent('/draw 一只猫', OUTSIDER_QQ));
  await delay(300);
  assert.equal(onebotServer.frames.filter(isSendMsg).length, 0);
  assert.equal(imageServer.requests.length, 0);
});

test('空 prompt（白名单内）：回用法提示，不调图片 API', async () => {
  onebotServer.injectEvent(privateDrawEvent('/draw', WHITELIST_QQ));
  const frame = await onebotServer.waitForFrame((f) => textFrame(f)?.startsWith('用法：/draw'));
  assert.equal(frame.params.user_id, WHITELIST_QQ); // 私聊出站
  assert.equal(imageServer.requests.length, 0);
});

test('群聊成功流：「在画了」文本帧 → 图片段帧（base64://）→ 占位 bot 行落盘 JSONL', async () => {
  const mark = onebotServer.frames.length;
  onebotServer.injectEvent(groupDrawEvent('/draw 一只橘猫', WHITELIST_QQ));

  // 帧①：先回「在画了」（出图 20-70s 的体验铺垫）
  const ackFrame = await onebotServer.waitForFrame(onlyNew(mark, (f) => textFrame(f)?.includes('本鱼在画「一只橘猫」')));
  assert.equal(ackFrame.params.group_id, GROUP_ID);

  // 帧②：图片段出站（数组消息段 + base64:// 前缀 + 与 mock 图逐字节一致）
  const imgFrame = await onebotServer.waitForFrame(onlyNew(mark, (f) => imageFrame(f) !== null));
  const seg = imgFrame.params.message.find((s) => s.type === 'image');
  assert.ok(seg.data.file.startsWith('base64://'));
  assert.equal(seg.data.file.slice('base64://'.length), IMG_BYTES.toString('base64'));
  assert.equal(imgFrame.params.group_id, GROUP_ID);

  // API 侧：prompt 原样上送、白名单外用户期间无额外请求
  assert.equal(imageServer.requests.length, 1);
  assert.equal(imageServer.requests[0].body.prompt, '一只橘猫');

  // JSONL 侧：占位 bot 行已落盘（图不进上下文，占位文本可被后续追问接上）
  await waitUntil(async () => {
    const lines = (await readFile(join(DATA_DIR, 'messages', `g-${GROUP_ID}.jsonl`), 'utf8')).trim().split('\n');
    return lines.some((line) => {
      const rec = JSON.parse(line);
      return rec.bot === true && rec.raw_message === '[图片] 一只橘猫';
    });
  });
});

test('私聊成功流：图片段经 sendPrivate（params.user_id，无 group_id）', async () => {
  const mark = onebotServer.frames.length;
  onebotServer.injectEvent(privateDrawEvent('/draw 奶茶', WHITELIST_QQ));

  const imgFrame = await onebotServer.waitForFrame(onlyNew(mark, (f) => imageFrame(f) !== null));
  assert.equal(imgFrame.params.user_id, WHITELIST_QQ);
  assert.equal(imgFrame.params.group_id, undefined);
  assert.equal(imageServer.requests.at(-1).body.prompt, '奶茶');
});

test('生成失败（API 500）：回兜底文案，无图片段出站', async () => {
  const mark = onebotServer.frames.length;
  imageServer.setFail();
  try {
    onebotServer.injectEvent(groupDrawEvent('/draw 失败的猫', WHITELIST_QQ));
    const failFrame = await onebotServer.waitForFrame(onlyNew(mark, (f) => textFrame(f)?.includes('颜料打翻')));
    assert.equal(failFrame.params.group_id, GROUP_ID);
    await delay(SEND_INTERVAL_MS * 3); // 兜底后队列不会再吐图片段
    assert.equal(onebotServer.frames.slice(mark).filter((f) => imageFrame(f) !== null).length, 0);
  } finally {
    imageServer.setB64();
  }
});

test('/drawxxx 不命中 draw → 落 command 走「不认识」分支（边界正确性的反向证明）', async () => {
  const mark = onebotServer.frames.length;
  onebotServer.injectEvent(groupDrawEvent('/drawxxx', WHITELIST_QQ));
  const frame = await onebotServer.waitForFrame(onlyNew(mark, (f) => textFrame(f)?.includes('不认识')));
  assert.ok(frame !== undefined);
});

test('ping 优先不受 draw 注册影响', async () => {
  const mark = onebotServer.frames.length;
  onebotServer.injectEvent(groupDrawEvent('ping', WHITELIST_QQ));
  const frame = await onebotServer.waitForFrame(onlyNew(mark, (f) => textFrame(f) === 'pong'));
  assert.ok(frame !== undefined);
});
