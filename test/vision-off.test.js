// 识图关闭验证（upgrade-vision）：DEEPSEEK_VISION_MODEL='' → 带图消息仍走纯文本路径——
// model=deepseek-chat、最后一条 user content 为 string、无「在看」提示帧。
// 与 draw-off.test.js 同模式（开关用例独立文件：config 是启动快照，一进程一套 env）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startMockServer } from './mock-onebot.js';
import { startLlmServer } from './llm-server.js';
import { startImageServer } from './image-server.js';

const TOKEN = 'vision-off-token';
const DATA_DIR = `tmp/test-vision-off-${process.pid}`;
const SEND_INTERVAL_MS = 50;
const SELF_ID = 10000;
const LOOKING = '本鱼凑近看看这张图哦，稍等～';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(cond, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil 超时`);
    await delay(stepMs);
  }
}

const onebotServer = await startMockServer({ token: TOKEN });
const llmServer = await startLlmServer();
const imageServer = await startImageServer();
process.env.ONEBOT_WS_URL = onebotServer.url;
process.env.ONEBOT_ACCESS_TOKEN = TOKEN;
process.env.SEND_INTERVAL_MS = String(SEND_INTERVAL_MS);
process.env.RECONNECT_DELAY_MS = '100';
process.env.API_TIMEOUT_MS = '2000';
process.env.DATA_DIR = DATA_DIR;
process.env.PERSONA_DIR = join(DATA_DIR, 'personas');
process.env.USAGE_DIR = join(DATA_DIR, 'usage');
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.DEEPSEEK_BASE_URL = llmServer.url;
process.env.CHAT_TIMEOUT_MS = '500';
process.env.DEEPSEEK_VISION_MODEL = ''; // 关闭识图（本文件唯一变量）
process.env.CHAT_COOLDOWN_MS = '0';
process.env.CONFIG_PATH = join(DATA_DIR, 'absent.json');

const onebot = await import('../src/connection/onebot.js');
const dispatcher = await import('../src/dispatch/dispatcher.js');
const registry = await import('../src/dispatch/registry.js');
const { config } = await import('../src/config.js');
const chat = (await import('../src/triggers/chat.js')).default;

config.behavior.reply.delay.enabled = false;

after(async () => {
  await delay(SEND_INTERVAL_MS * 3);
  onebot.stopConnection();
  await onebotServer.close();
  await llmServer.close();
  await imageServer.close();
  await rm(DATA_DIR, { recursive: true, force: true });
});

onebot.onEvent(dispatcher.dispatch);
registry.register(chat);
onebot.startConnection();
await onebotServer.waitForConnectionCount(1);
for (;;) {
  try {
    await onebot.callApi('send_msg', { message_type: 'group', group_id: 0, message: 'ready-probe' });
    break;
  } catch (err) {
    if (!err.message.includes('WS 未连接')) throw err;
    await delay(10);
  }
}

test('识图关闭：带图消息纯文本路径，model=chat、content 为 string、无提示帧', { timeout: 10000 }, async () => {
  const mark = onebotServer.frames.length;
  const reqMark = llmServer.requests.length;
  onebotServer.injectEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 4001,
    self_id: SELF_ID,
    time: 1760006000,
    message_id: -800001,
    message: [
      { type: 'image', data: { file: 'x.png', url: `${imageServer.url}/img` } },
      { type: 'text', data: { text: '识别' } },
    ],
    raw_message: '[CQ:image,file=x.png]识别',
    sender: { nickname: '关识图测试', card: '', role: '' },
  });

  await waitUntil(() => llmServer.requests.length > reqMark);
  const req = llmServer.requests.at(-1);
  assert.equal(req.body.model, 'deepseek-chat');
  assert.equal(typeof req.body.messages.at(-1).content, 'string');
  assert.equal(req.body.messages.at(-1).content, '识别');
  assert.equal(
    onebotServer.frames.findIndex(
      (f) => onebotServer.frames.indexOf(f) >= mark && f.params?.message === LOOKING
    ),
    -1
  );
});

test('识图关闭：私聊纯图片仍静默，不调用文本模型猜图', async () => {
  const mark = llmServer.requests.length;
  await dispatcher.dispatch({
    post_type: 'message', message_type: 'private', user_id: 4002, self_id: SELF_ID,
    time: 1760006001, message_id: -800002,
    message: [{ type: 'image', data: { file: 'x.png', url: `${imageServer.url}/img` } }],
    raw_message: '[CQ:image,file=x.png]', sender: { nickname: '纯图' },
  });
  assert.equal(llmServer.requests.length, mark);
});
