// 识图分流验证（upgrade-vision）：mock OneBot + mock LLM + mock 图源（image-server 的
// GET /img 充当 QQ CDN）三服务器端到端。
// 覆盖：群聊自带图全链路（「在看」提示先出站 → flash 块数组上送（text 块带 speaker 前缀、
// image_url 块逐字节等于 IMG_BYTES）→ 回答出站 → 双 bot 行回存 JSONL → usage 按 flash 记账）、
// 多图取第一张（单次一张边界）、周围图（@ 消息无图时 get_group_msg_history 查同用户
// 时间窗内近图）、时间窗外/他人图不取（纯文本路径零识图痕迹）、拉图失败回退纯文本
//（提示已发、对话不中断）、flash 失败还原 string 换 deepseek-chat 重试一次、私聊带图。
// 装配（同 chat.test.js 模式）：三 mock → env → 动态 import → 注册 ping → chat
//（识图是 chat 内部子路径，非独立触发器）；CHAT_COOLDOWN_MS=0 专注识图行为（冷却由
// chat.test.js 覆盖）；随机延迟基线关闭。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startMockServer } from './mock-onebot.js';
import { startLlmServer } from './llm-server.js';
import { startImageServer, IMG_BYTES } from './image-server.js';

const TOKEN = 'vision-test-token';
const DATA_DIR = `tmp/test-vision-${process.pid}`;
const MSG_DIR = join(DATA_DIR, 'messages');
const PERSONA_DIR = join(DATA_DIR, 'personas');
const USAGE_DIR = join(DATA_DIR, 'usage');
const SEND_INTERVAL_MS = 50;
const SELF_ID = 10000;
const GROUP_ID = 888;
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

// ---- 文件级装配：三 mock → env → 动态 import → 注册（ping → chat，同 index.js 相对序）----
const onebotServer = await startMockServer({ token: TOKEN });
const llmServer = await startLlmServer();
const imageServer = await startImageServer(); // GET /img 即图源（CDN mock），IMG_BYTES 充当图片
process.env.ONEBOT_WS_URL = onebotServer.url;
process.env.ONEBOT_ACCESS_TOKEN = TOKEN;
process.env.SEND_INTERVAL_MS = String(SEND_INTERVAL_MS);
process.env.RECONNECT_DELAY_MS = '100';
process.env.API_TIMEOUT_MS = '2000';
process.env.DATA_DIR = DATA_DIR;
process.env.PERSONA_DIR = PERSONA_DIR;
process.env.USAGE_DIR = USAGE_DIR;
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.DEEPSEEK_BASE_URL = llmServer.url;
process.env.CHAT_TIMEOUT_MS = '500';
process.env.DEEPSEEK_VISION_MODEL = 'deepseek-flash';
process.env.CHAT_COOLDOWN_MS = '0';
process.env.CHAT_CONTEXT_LINES = '20';
// CONFIG_PATH 指向不存在路径：行为开关跑全默认，不受本机 config.json 干扰
process.env.CONFIG_PATH = join(DATA_DIR, 'absent.json');

const onebot = await import('../src/connection/onebot.js');
const dispatcher = await import('../src/dispatch/dispatcher.js');
const registry = await import('../src/dispatch/registry.js');
const { config } = await import('../src/config.js');
const ping = (await import('../src/triggers/ping.js')).default;
const chat = (await import('../src/triggers/chat.js')).default;

// 基线：关闭随机延迟（默认开启且区间 2–8s，会把所有用例拖到秒级）
config.behavior.reply.delay.enabled = false;

after(async () => {
  const { drainSender } = await import('../src/sender/sender.js');
  assert.equal(await drainSender(5000), true, '关闭 mock 前应发完所有回复');
  onebot.stopConnection();
  await onebotServer.close();
  await llmServer.close();
  await imageServer.close();
  await rm(DATA_DIR, { recursive: true, force: true });
});

// ---- 事件构造：与 dispatcher 同入口（post_type=message + 消息段数组）----
let messageSeq = 0;
function groupEvent({ text, userId, atBot = true, imageUrls = [] }) {
  ++messageSeq;
  const message = [];
  if (atBot) message.push({ type: 'at', data: { qq: String(SELF_ID) } });
  for (const url of imageUrls) message.push({ type: 'image', data: { file: 'x.png', url } });
  if (text !== null) message.push({ type: 'text', data: { text } });
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: userId,
    self_id: SELF_ID,
    time: 1760005000 + messageSeq,
    message_id: -600000 + messageSeq,
    message,
    // raw_message 模拟真实 OneBot CQ 码形态（dispatcher 原样落盘，后续上下文据此知「发过图」）
    raw_message: `${imageUrls.map(() => '[CQ:image,file=x.png]').join('')}${atBot ? '[@bot] ' : ''}${text ?? ''}`,
    sender: { nickname: `群友${userId}`, card: '', role: 'member' },
  };
}
function privateEvent({ text, userId, imageUrls = [] }) {
  ++messageSeq;
  const message = [];
  for (const url of imageUrls) message.push({ type: 'image', data: { file: 'x.png', url } });
  if (text !== null) message.push({ type: 'text', data: { text } });
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: userId,
    self_id: SELF_ID,
    time: 1760005000 + messageSeq,
    message_id: -600000 + messageSeq,
    message,
    raw_message: `${imageUrls.map(() => '[CQ:image,file=x.png]').join('')}${text ?? ''}`,
    sender: { nickname: `私聊${userId}`, card: '', role: '' },
  };
}

// 周围图历史消息（get_group_msg_history 的 data.messages 元素形状，NapCat 实测同构）
function historyImageMsg({ userId, time, messageId }) {
  return {
    message_id: messageId,
    user_id: userId,
    time,
    message: [{ type: 'image', data: { file: 'x.png', url: `${imageServer.url}/img` } }],
    sender: { nickname: `群友${userId}` },
  };
}

// ---- frames / requests 水位：防前序用例异步遗留串扰（同 draw.test.js 纪律）----
function onlyNew(mark, pred) {
  return (f) => pred(f) && onebotServer.frames.indexOf(f) >= mark;
}

// 回答出站帧谓词：quote 加工链可能把首帧变 reply+text 段数组，两种形态都认
function isReplySend(f) {
  if (f.action !== 'send_msg') return false;
  const m = f.params?.message;
  return m === 'MOCK_LLM_REPLY' ||
    (Array.isArray(m) && m.some((s) => s?.type === 'text' && s.data?.text === 'MOCK_LLM_REPLY'));
}

async function readLines(dir, sessionKey) {
  const text = await readFile(join(dir, `${sessionKey}.jsonl`), 'utf8');
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

async function readUsage(sessionKey) {
  return readLines(USAGE_DIR, sessionKey);
}

async function usageCount(sessionKey) {
  try {
    return (await readUsage(sessionKey)).length;
  } catch {
    return 0; // 文件未生成（appendUsage 是 fire-and-forget，落盘有延迟）
  }
}

// ---- 装配收口：注册 + 连接 + 就绪探测（同 chat.test.js 模式）----
onebot.onEvent(dispatcher.dispatch);
registry.register(ping);
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

test('群聊自带图：先「在看」提示、flash 块数组上送、回答出站、双 bot 行回存、usage 按 flash 记账', { timeout: 10000 }, async () => {
  const mark = onebotServer.frames.length;
  const reqMark = llmServer.requests.length;
  const usageMark = await usageCount(`g-${GROUP_ID}`);
  const userId = 3001;
  onebotServer.injectEvent(
    groupEvent({ text: '识别图片内容', userId, imageUrls: [`${imageServer.url}/img`] })
  );

  await waitUntil(() => llmServer.requests.length > reqMark);
  const req = llmServer.requests.at(-1);
  assert.equal(req.body.model, 'deepseek-flash');
  const last = req.body.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.ok(Array.isArray(last.content), '带图路径最后一条 user content 应为块数组');
  assert.deepEqual(last.content[0], { type: 'text', text: `群友${userId}: 识别图片内容` });
  assert.equal(last.content[1].type, 'image_url');
  assert.equal(last.content[1].image_url.url, `data:image/png;base64,${IMG_BYTES.toString('base64')}`);

  const lookFrame = await onebotServer.waitForFrame(
    onlyNew(mark, (f) => f.action === 'send_msg' && f.params?.message === LOOKING)
  );
  const replyFrame = await onebotServer.waitForFrame(onlyNew(mark, isReplySend));
  // 过渡提示必须先于回答出站（赶在拉图/推理前安抚）
  assert.ok(onebotServer.frames.indexOf(lookFrame) < onebotServer.frames.indexOf(replyFrame));
  assert.equal(lookFrame.params.message_type, 'group');
  assert.equal(lookFrame.params.group_id, GROUP_ID);

  // 消息存储是异步旁路：出站确认不代表 JSONL 写入已经完成。
  await waitUntil(async () => (await readLines(MSG_DIR, `g-${GROUP_ID}`)).filter((line) => line.bot).at(-1)?.raw_message === 'MOCK_LLM_REPLY');
  // JSONL：「在看」提示 + 回答两条 bot 行（ctx.reply 与 persistAndSend 各回存一条）
  const lines = await readLines(MSG_DIR, `g-${GROUP_ID}`);
  const botLines = lines.filter((l) => l.bot === true).map((l) => l.raw_message);
  assert.deepEqual(botLines.slice(-2), [LOOKING, 'MOCK_LLM_REPLY']);

  // usage 按 flash 记账（fire-and-forget，等落盘）
  await waitUntil(async () => (await usageCount(`g-${GROUP_ID}`)) > usageMark);
  const usageLines = await readUsage(`g-${GROUP_ID}`);
  assert.equal(usageLines.at(-1).model, 'deepseek-flash');
  assert.equal(usageLines.at(-1).kind, 'vision');
});

test('多图取第一张：第二张不被拉取（单次一张边界）', { timeout: 10000 }, async () => {
  const mark = onebotServer.frames.length;
  const reqMark = llmServer.requests.length;
  onebotServer.injectEvent(
    groupEvent({
      text: '两张图', userId: 3002,
      // 第二张故意指向坏端口：若被选中会拉图失败回退纯文本（model 断言即失败）
      imageUrls: [`${imageServer.url}/img`, 'http://127.0.0.1:1/img'],
    })
  );
  await waitUntil(() => llmServer.requests.length > reqMark);
  const req = llmServer.requests.at(-1);
  assert.equal(req.body.model, 'deepseek-flash');
  assert.equal(
    req.body.messages.at(-1).content[1].image_url.url,
    `data:image/png;base64,${IMG_BYTES.toString('base64')}`
  );
  await onebotServer.waitForFrame(onlyNew(mark, isReplySend));
});

test('周围图：@ 消息无图时查历史，同用户时间窗内近图被识图', { timeout: 10000 }, async () => {
  const mark = onebotServer.frames.length;
  const reqMark = llmServer.requests.length;
  const userId = 3003;
  const ev = groupEvent({ text: '图里是啥', userId }); // 无图
  onebotServer.setActionResponse('get_group_msg_history', {
    messages: [historyImageMsg({ userId, time: ev.time - 10, messageId: -555001 })],
  });
  onebotServer.injectEvent(ev);

  await waitUntil(() => llmServer.requests.length > reqMark);
  const req = llmServer.requests.at(-1);
  assert.equal(req.body.model, 'deepseek-flash');
  assert.ok(Array.isArray(req.body.messages.at(-1).content));
  assert.equal(
    req.body.messages.at(-1).content[1].image_url.url,
    `data:image/png;base64,${IMG_BYTES.toString('base64')}`
  );

  // 历史查询帧确实出站且带对参数
  const histFrame = onebotServer.frames.find(
    onlyNew(mark, (f) => f.action === 'get_group_msg_history')
  );
  assert.ok(histFrame !== undefined, '应发出 get_group_msg_history');
  assert.equal(histFrame.params.group_id, GROUP_ID);
  assert.ok(histFrame.params.count > 0);
  await onebotServer.waitForFrame(onlyNew(mark, isReplySend));
  onebotServer.clearActionResponse('get_group_msg_history');
});

test('时间窗外不取：纯文本路径，无提示帧、无识图调用', { timeout: 10000 }, async () => {
  const mark = onebotServer.frames.length;
  const reqMark = llmServer.requests.length;
  const userId = 3004;
  const ev = groupEvent({ text: '刚才那张呢', userId });
  onebotServer.setActionResponse('get_group_msg_history', {
    // 差 300s，超出默认 120s 窗口
    messages: [historyImageMsg({ userId, time: ev.time - 300, messageId: -555002 })],
  });
  onebotServer.injectEvent(ev);

  await waitUntil(() => llmServer.requests.length > reqMark);
  const req = llmServer.requests.at(-1);
  assert.equal(req.body.model, 'deepseek-chat');
  assert.equal(typeof req.body.messages.at(-1).content, 'string');
  assert.equal(
    onebotServer.frames.findIndex(onlyNew(mark, (f) => f.params?.message === LOOKING)),
    -1,
    '窗口外不应有「在看」提示'
  );
  await onebotServer.waitForFrame(onlyNew(mark, isReplySend));
  onebotServer.clearActionResponse('get_group_msg_history');
});

test('他人图不取：历史里别人的图不算图源', { timeout: 10000 }, async () => {
  const mark = onebotServer.frames.length;
  const reqMark = llmServer.requests.length;
  const userId = 3005;
  const ev = groupEvent({ text: '图呢', userId });
  onebotServer.setActionResponse('get_group_msg_history', {
    messages: [historyImageMsg({ userId: userId + 999, time: ev.time - 10, messageId: -555003 })],
  });
  onebotServer.injectEvent(ev);

  await waitUntil(() => llmServer.requests.length > reqMark);
  const req = llmServer.requests.at(-1);
  assert.equal(req.body.model, 'deepseek-chat');
  assert.equal(typeof req.body.messages.at(-1).content, 'string');
  await onebotServer.waitForFrame(onlyNew(mark, isReplySend));
  onebotServer.clearActionResponse('get_group_msg_history');
});

test('拉图失败回退：提示已出站，纯文本对话不中断', { timeout: 10000 }, async () => {
  const mark = onebotServer.frames.length;
  const reqMark = llmServer.requests.length;
  onebotServer.injectEvent(
    groupEvent({ text: '看看', userId: 3006, imageUrls: ['http://127.0.0.1:1/img'] }) // 连接拒绝
  );

  await waitUntil(() => llmServer.requests.length > reqMark);
  const req = llmServer.requests.at(-1);
  assert.equal(req.body.model, 'deepseek-chat');
  assert.equal(typeof req.body.messages.at(-1).content, 'string');
  // 提示先于拉图（流程顺序），图挂了提示已在——用 waitForFrame 等待：sender 队列
  // 50ms 节流下，前序用例的出站可能还在排队，同步 find 会撞上时序竞争
  await onebotServer.waitForFrame(
    onlyNew(mark, (f) => f.action === 'send_msg' && f.params?.message === LOOKING)
  );
  await onebotServer.waitForFrame(onlyNew(mark, isReplySend)); // 回答仍正常出站
});

test('flash 失败回退：还原 string 换 deepseek-chat 重试一次成功', { timeout: 10000 }, async () => {
  const usageMark = await usageCount(`g-${GROUP_ID}`);
  const mark = onebotServer.frames.length;
  const reqMark = llmServer.requests.length;
  llmServer.setFailOnce(); // 首调（flash）500，次调（chat）恢复 ok
  onebotServer.injectEvent(
    groupEvent({ text: '识别一下', userId: 3007, imageUrls: [`${imageServer.url}/img`] })
  );

  await waitUntil(() => llmServer.requests.length >= reqMark + 2);
  const first = llmServer.requests.at(-2);
  const second = llmServer.requests.at(-1);
  assert.equal(first.body.model, 'deepseek-flash');
  assert.ok(Array.isArray(first.body.messages.at(-1).content));
  assert.equal(second.body.model, 'deepseek-chat');
  // 块数组还原为原 string（回退不能把图块残留在纯文本请求里）
  assert.equal(second.body.messages.at(-1).content, '群友3007: 识别一下');
  await onebotServer.waitForFrame(onlyNew(mark, isReplySend)); // 回退重试的回答正常出站
  const attempts = (await readUsage(`g-${GROUP_ID}`)).slice(usageMark);
  assert.equal(attempts.length, 2, '视觉失败和文本回退是两次真实请求，都必须计数');
  assert.deepEqual(attempts.map(({ kind, status }) => ({ kind, status })), [
    { kind: 'vision', status: 'failure' }, { kind: 'chat', status: 'success' },
  ]);
});

test('私聊带图：vision 路径，text 块无私聊前缀', { timeout: 10000 }, async () => {
  const mark = onebotServer.frames.length;
  const reqMark = llmServer.requests.length;
  onebotServer.injectEvent(
    privateEvent({ text: '这什么', userId: 3008, imageUrls: [`${imageServer.url}/img`] })
  );

  await waitUntil(() => llmServer.requests.length > reqMark);
  const req = llmServer.requests.at(-1);
  assert.equal(req.body.model, 'deepseek-flash');
  const last = req.body.messages.at(-1);
  assert.deepEqual(last.content[0], { type: 'text', text: '这什么' }); // 私聊不加 speaker 前缀
  assert.equal(last.content[1].image_url.url, `data:image/png;base64,${IMG_BYTES.toString('base64')}`);

  await onebotServer.waitForFrame(
    onlyNew(mark, (f) => f.action === 'send_msg' && f.params?.message_type === 'private' && f.params?.user_id === 3008)
  );
  await onebotServer.waitForFrame(onlyNew(mark, isReplySend));
});

test('私聊纯图片：没有 text 段也发送图片给视觉模型', async () => {
  const mark = llmServer.requests.length;
  await dispatcher.dispatch(privateEvent({ text: null, userId: 3010, imageUrls: [`${imageServer.url}/img`] }));
  assert.equal(llmServer.requests.length, mark + 1);
  const request = llmServer.requests.at(-1).body;
  assert.equal(request.model, 'deepseek-flash');
  assert.match(request.messages.at(-1).content[0].text, /图片/);
  assert.equal(request.messages.at(-1).content[1].image_url.url, `data:image/png;base64,${IMG_BYTES.toString('base64')}`);
});

test('私聊先发图再发文字：从本地会话历史取最近图片，无需 OneBot 私聊历史 API', async () => {
  const { appendMessage } = await import('../src/store/message-store.js');
  const event = privateEvent({ text: '刚发的图是什么', userId: 3011 });
  const sessionKey = 'p-3011';
  // 不等待写入，模拟 dispatcher 接收图片后紧接着收到文字。
  appendMessage({ ...historyImageMsg({ userId: '3011', time: event.time - 1, messageId: -9011 }), sessionKey, message_type: 'private' });
  const mark = onebotServer.frames.length;
  await dispatcher.dispatch(event);
  const request = llmServer.requests.at(-1).body;
  assert.equal(request.model, 'deepseek-flash');
  assert.equal(request.messages.at(-1).content[0].text, event.raw_message);
  assert.equal(request.messages.at(-1).content[1].image_url.url, `data:image/png;base64,${IMG_BYTES.toString('base64')}`);
  assert.ok(!onebotServer.frames.slice(mark).some((f) => /history/.test(f.action)));
});

test('私聊近图边界：排除过期、未来、无时间、他人、机器人、重置前及其他会话图片', async (t) => {
  const { appendMessage } = await import('../src/store/message-store.js');
  const { updateState } = await import('../src/store/session-state.js');
  let userId = 3020;
  for (const kind of ['expired', 'future', 'missing-time', 'other-user', 'bot', 'reset', 'other-session']) {
    await t.test(kind, async () => {
      const event = privateEvent({ text: `看图边界 ${kind}`, userId: userId++ });
      const sessionKey = `p-${event.user_id}`;
      const record = { ...historyImageMsg({ userId: event.user_id, time: event.time - 1, messageId: -event.user_id }), sessionKey, message_type: 'private' };
      if (kind === 'expired') record.time = event.time - config.visionImageWindowMs / 1000 - 1;
      if (kind === 'future') record.time = event.time + 1;
      if (kind === 'missing-time') delete record.time;
      if (kind === 'other-user') record.user_id = 99999;
      if (kind === 'bot') record.bot = true;
      if (kind === 'reset') await updateState(sessionKey, { resetAt: event.time });
      if (kind === 'other-session') record.sessionKey = 'p-99999';
      await appendMessage(record);
      await dispatcher.dispatch(event);
      assert.equal(llmServer.requests.at(-1).body.model, 'deepseek-chat');
      assert.equal(typeof llmServer.requests.at(-1).body.messages.at(-1).content, 'string');
    });
  }
});

test('私聊图源优先级：当前图片优先，其次最近的历史图片', async () => {
  const { appendMessage } = await import('../src/store/message-store.js');
  for (const own of [true, false]) {
    const event = privateEvent({ text: '看这张', userId: own ? 3040 : 3041, imageUrls: own ? [`${imageServer.url}/img`] : [] });
    const snapshot = (time, url, messageId) => ({ sessionKey: `p-${event.user_id}`, message_type: 'private',
      ...historyImageMsg({ userId: event.user_id, time, messageId }), message: [{ type: 'image', data: { url } }] });
    await appendMessage(snapshot(event.time - 2, 'http://127.0.0.1:1/img', -9040));
    if (!own) await appendMessage(snapshot(event.time - 1, `${imageServer.url}/img`, -9041));
    await dispatcher.dispatch(event);
    assert.equal(llmServer.requests.at(-1).body.model, 'deepseek-flash');
  }
});
