// AIChat MVP · Task 5 验证（add-aichat-mvp spec G1/G3/G4/G5/G6）：
// chat 触发器全链路——私聊全量、群 @bot、不触发矩阵、空文本、多轮上下文（LLM messages
// 形状断言）、冷却跳过、LLM 失败/超时兜底、ping 优先、未配置 key 不生效、注册顺序。
// 装配：mock OneBot + mock LLM 双服务器 → env → 手动 register(ping)+register(chat)
//（与 index.js 同序；index.js 的真实顺序另做静态断言）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startMockServer } from './mock-onebot.js';
import { startLlmServer } from './llm-server.js';

const TOKEN = 'chat-test-token';
const DATA_DIR = `tmp/test-chat-${process.pid}`;
const MSG_DIR = join(DATA_DIR, 'messages');
const SEND_INTERVAL_MS = 50;
const SELF_ID = 10000; // 事件里的 self_id：@bot 判断依据
const FALLBACK = 'AI 开小差了，稍后再试～';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(cond, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil 超时（${timeoutMs}ms 内条件未满足）`);
    await delay(stepMs);
  }
}

// ---- 文件级装配：双 mock → env → 动态 import → 注册（ping 先、chat 后，同 index.js）----
const onebotServer = await startMockServer({ token: TOKEN });
const llmServer = await startLlmServer();
process.env.ONEBOT_WS_URL = onebotServer.url;
process.env.ONEBOT_ACCESS_TOKEN = TOKEN;
process.env.SEND_INTERVAL_MS = String(SEND_INTERVAL_MS);
process.env.RECONNECT_DELAY_MS = '100';
process.env.API_TIMEOUT_MS = '2000';
process.env.DATA_DIR = DATA_DIR;
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.DEEPSEEK_BASE_URL = llmServer.url;
process.env.CHAT_TIMEOUT_MS = '500';
process.env.CHAT_CONTEXT_LINES = '20';
process.env.CHAT_COOLDOWN_MS = '600';

const onebot = await import('../src/connection/onebot.js');
const dispatcher = await import('../src/dispatch/dispatcher.js');
const registry = await import('../src/dispatch/registry.js');
const { config } = await import('../src/config.js');
const ping = (await import('../src/triggers/ping.js')).default;
const chat = (await import('../src/triggers/chat.js')).default;

after(async () => {
  await delay(SEND_INTERVAL_MS * 3); // 等发送队列的间隔定时器自然落定
  onebot.stopConnection();
  await onebotServer.close();
  await llmServer.close();
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
registry.register(ping);
registry.register(chat);
onebot.startConnection();
await onebotServer.waitForConnectionCount(1);
await waitForApiReady();

// ---- 事件构造 ----
let messageSeq = 0;
function privateEvent(raw, userId, nickname = `私聊${userId}`) {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: userId,
    self_id: SELF_ID,
    time: 1760003000 + ++messageSeq,
    message_id: -400000 + messageSeq,
    message: [{ type: 'text', data: { text: raw } }],
    raw_message: raw,
    sender: { nickname, card: '', role: '' },
  };
}
function groupEvent(text, groupId, userId, nickname, atQq = null) {
  const message = [];
  if (atQq !== null) message.push({ type: 'at', data: { qq: String(atQq) } });
  if (text !== null) message.push({ type: 'text', data: { text } });
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    user_id: userId,
    self_id: SELF_ID,
    time: 1760003000 + ++messageSeq,
    message_id: -400000 + messageSeq,
    message,
    raw_message: `${atQq !== null ? `[@bot] ` : ''}${text ?? ''}`,
    sender: { nickname, card: '', role: 'member' },
  };
}

async function readLines(sessionKey) {
  const { readFile: rf } = await import('node:fs/promises');
  const text = await rf(join(MSG_DIR, `${sessionKey}.jsonl`), 'utf8');
  return text.split('\n').filter((line) => line !== '');
}

// 帧基线等待：mock 的 waitForFrame 会命中历史帧，等待「新增帧」必须先记录基线。
// waitUntil 成功时返回 void，故先等到条件成立、再回查具体帧。
async function waitNextFrame(baseline, predicate, { timeoutMs = 3000 } = {}) {
  await waitUntil(() => onebotServer.frames.slice(baseline).some(predicate), { timeoutMs });
  return onebotServer.frames.slice(baseline).find(predicate);
}

test('私聊触发：LLM 收到 [system, user]，回复出站，会话文件含 bot:true 回复行', { timeout: 10000 }, async () => {
  onebotServer.injectEvent(privateEvent('你好', 2001));

  const frame = await onebotServer.waitForFrame(
    (f) => f.action === 'send_msg' && f.params?.message_type === 'private' && f.params?.user_id === 2001
  );
  assert.equal(frame.params.message, 'MOCK_LLM_REPLY');

  const req = llmServer.requests.at(-1);
  assert.equal(req.body.model, 'deepseek-chat');
  assert.deepEqual(req.body.messages, [
    { role: 'system', content: req.body.messages[0].content },
    { role: 'user', content: '你好' },
  ]);
  assert.equal(req.body.messages[0].role, 'system');

  // 回存：入站行 + bot 行（bot:true、无 message_id）
  await waitUntil(async () => {
    try {
      return (await readLines('p-2001')).length === 2;
    } catch {
      return false; // 文件尚未创建（fire-and-forget 异步写）
    }
  });
  const [inbound, botLine] = (await readLines('p-2001')).map((line) => JSON.parse(line));
  assert.equal(inbound.raw_message, '你好');
  assert.ok(!inbound.bot, '入站行不带 bot 标记');
  assert.equal(botLine.bot, true);
  assert.equal(botLine.sessionKey, 'p-2001');
  assert.equal(botLine.message_type, 'private');
  assert.equal(botLine.user_id, 2001);
  assert.equal(botLine.raw_message, 'MOCK_LLM_REPLY');
  assert.ok(!('message_id' in botLine), 'bot 行不应有 message_id');
});

test('多轮上下文：第二条消息的 messages = [system, user1, assistant1, user2]，当前消息不重复', { timeout: 10000 }, async () => {
  await delay(700); // 等 600ms 会话冷却过期
  const frameBaseline = onebotServer.frames.length;
  onebotServer.injectEvent(privateEvent('再来', 2001));

  const frame = await waitNextFrame(
    frameBaseline,
    (f) => f.action === 'send_msg' && f.params?.user_id === 2001 && f.params?.message === 'MOCK_LLM_REPLY'
  );
  assert.ok(frame.params.message_type === 'private');

  const messages = llmServer.requests.at(-1).body.messages;
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'user']
  );
  assert.equal(messages[1].content, '你好');
  assert.equal(messages[2].content, 'MOCK_LLM_REPLY', '上一轮 bot 回复行 → assistant 角色');
  assert.equal(messages[3].content, '再来', '当前消息恰出现一次（message_id 去重后）');
});

test('群聊 @bot 触发：at 段剥离、昵称前缀、回复发往同群、bot 行带 group_id', { timeout: 10000 }, async () => {
  const frameBaseline = onebotServer.frames.length;
  onebotServer.injectEvent(groupEvent(' 讲个笑话', 3001, 3002, '群友甲', SELF_ID));

  const frame = await waitNextFrame(
    frameBaseline,
    (f) => f.action === 'send_msg' && f.params?.message_type === 'group' && f.params?.group_id === 3001
  );
  assert.equal(frame.params.message, 'MOCK_LLM_REPLY');

  const messages = llmServer.requests.at(-1).body.messages;
  const last = messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content, '群友甲: 讲个笑话', 'at 段剥离 + 昵称前缀');
  assert.ok(!last.content.includes('[@'), 'at 不得混入内容');

  await waitUntil(async () => {
    try {
      return (await readLines('g-3001')).length === 2;
    } catch {
      return false; // 文件尚未创建（fire-and-forget 异步写）
    }
  });
  const [, botLine] = (await readLines('g-3001')).map((line) => JSON.parse(line));
  assert.equal(botLine.bot, true);
  assert.equal(botLine.group_id, 3001);
  assert.equal(botLine.raw_message, 'MOCK_LLM_REPLY');
});

test('不触发矩阵：群聊不@ / @他人 / @全体 → 不调 LLM、无出站帧', { timeout: 10000 }, async () => {
  onebotServer.injectEvent(groupEvent('你们聊', 3101, 3102, '路人乙')); // 不 @
  onebotServer.injectEvent(groupEvent('@的是别人', 3102, 3103, '路人丙', 99999)); // @他人
  onebotServer.injectEvent(groupEvent('@全体成员', 3103, 3104, '路人丁', 'all')); // @全体
  await delay(400);

  // 按会话归属断言（比全局计数稳）：三个群都不得出现在任何 LLM 请求或出站帧中
  const groups = [3101, 3102, 3103];
  assert.ok(
    !llmServer.requests.some((r) => JSON.stringify(r.body).includes('你们聊')),
    '「不 @」不得调 LLM'
  );
  assert.ok(
    !llmServer.requests.some((r) => JSON.stringify(r.body).includes('@的是别人')),
    '「@他人」不得调 LLM'
  );
  assert.ok(
    !llmServer.requests.some((r) => JSON.stringify(r.body).includes('@全体成员')),
    '「@全体」不得调 LLM'
  );
  assert.ok(
    !onebotServer.frames.some((f) => f.params?.group_id !== undefined && groups.includes(f.params.group_id)),
    '三者都不得产生出站帧'
  );
});

test('空文本忽略：仅 @bot 无文本 → 不调 LLM、无出站帧', { timeout: 10000 }, async () => {
  onebotServer.injectEvent(groupEvent(null, 3201, 3202, '只@君', SELF_ID));
  await delay(400);

  assert.ok(
    !llmServer.requests.some((r) => JSON.stringify(r.body).includes('只@君')),
    '纯 @bot 无文本不得调 LLM（占位文本不得混入 prompt）'
  );
  assert.ok(
    !onebotServer.frames.some((f) => f.params?.group_id === 3201),
    '纯 @bot 无文本不得产生出站帧'
  );
});

test('冷却跳过：同一会话冷却窗口内第二条消息静默（无 LLM 调用、无回复）', { timeout: 10000 }, async () => {
  const frameBaseline = onebotServer.frames.length;
  onebotServer.injectEvent(privateEvent('第一条', 4001));
  const first = await waitNextFrame(
    frameBaseline,
    (f) => f.action === 'send_msg' && f.params?.user_id === 4001 && f.params?.message === 'MOCK_LLM_REPLY'
  );
  assert.ok(first);

  const afterFirst = onebotServer.frames.length; // 第一条回复已收到：此后到 4001 的私聊帧都算违规
  onebotServer.injectEvent(privateEvent('第二条', 4001)); // 距上一条 < 600ms
  await delay(400); // 观察窗口

  assert.ok(
    !llmServer.requests.some((r) => JSON.stringify(r.body).includes('第二条')),
    '冷却内不得调用 LLM'
  );
  assert.ok(
    !onebotServer.frames.slice(afterFirst).some((f) => f.params?.user_id === 4001),
    '冷却内不得产生新出站帧'
  );

  // 不同会话不受影响：另一个用户正常触发
  const crossBaseline = onebotServer.frames.length;
  onebotServer.injectEvent(privateEvent('隔壁会话', 4002));
  await waitNextFrame(crossBaseline, (f) => f.action === 'send_msg' && f.params?.user_id === 4002);
});

test('LLM 失败兜底：HTTP 500 → reply 固定文案 + WARN 日志', { timeout: 10000 }, async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  llmServer.setFail();
  try {
    onebotServer.injectEvent(privateEvent('这回要挂', 5001));
    const frame = await onebotServer.waitForFrame(
      (f) => f.action === 'send_msg' && f.params?.user_id === 5001 && f.params?.message === FALLBACK
    );
    assert.ok(frame, '兜底文案应出站');
    await waitUntil(() => logs.some((line) => line.includes('WARN') && line.includes('LLM 调用失败')));
  } finally {
    console.log = originalLog;
    llmServer.setReply('MOCK_LLM_REPLY');
  }
});

test('LLM 超时兜底：mock 挂起 → CHAT_TIMEOUT_MS 后 reply 固定文案', { timeout: 10000 }, async () => {
  llmServer.setHang();
  try {
    onebotServer.injectEvent(privateEvent('等超时', 5002));
    const frame = await onebotServer.waitForFrame(
      (f) => f.action === 'send_msg' && f.params?.user_id === 5002 && f.params?.message === FALLBACK
    );
    assert.ok(frame, '超时后兜底文案应出站');
  } finally {
    llmServer.setReply('MOCK_LLM_REPLY');
  }
});

test('ping 优先：注册顺序保障，私聊 ping 回 pong 且 LLM 无新请求', { timeout: 10000 }, async () => {
  const reqBaseline = llmServer.requests.length;
  onebotServer.injectEvent(privateEvent('ping', 6001));

  const frame = await onebotServer.waitForFrame(
    (f) => f.action === 'send_msg' && f.params?.user_id === 6001 && f.params?.message === 'pong'
  );
  assert.equal(frame.params.message, 'pong', 'ping→pong 优先，不得落到 chat 触发器');
  await delay(300);
  assert.equal(llmServer.requests.length, reqBaseline, 'ping 不得触发 LLM 调用');
});

test('未配置 key：chat 触发器不生效（私聊消息不吞、不调 LLM）', { timeout: 10000 }, async () => {
  const savedKey = config.deepseekApiKey;
  config.deepseekApiKey = ''; // 临时改写（沿袭 connection.test.js 的 config 变更法），用毕恢复
  try {
    const reqBaseline = llmServer.requests.length;
    const frameBaseline = onebotServer.frames.length;
    onebotServer.injectEvent(privateEvent('没key就别说话', 6002));
    await delay(400);
    assert.equal(llmServer.requests.length, reqBaseline, '未配置 key 不得调用 LLM');
    assert.equal(onebotServer.frames.length, frameBaseline, '未配置 key 不得产生出站帧');
  } finally {
    config.deepseekApiKey = savedKey;
  }
});

test('readRecentMessages：尾部 limit 截取、ENOENT 空数组、损坏行跳过', { timeout: 10000 }, async () => {
  const { readRecentMessages } = await import('../src/store/message-store.js');
  const { writeFile } = await import('node:fs/promises');

  // 已有会话 p-2001（你好/回复/再来/回复 四行）：limit=1 取尾部一条
  const tail = await readRecentMessages('p-2001', 1);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].raw_message, 'MOCK_LLM_REPLY');

  // 不存在的会话 → []（不抛、不 WARN 升级）
  assert.deepEqual(await readRecentMessages('g-404', 20), []);

  // 损坏行跳过：一坏一好，只读到好的那条
  await writeFile(
    join(MSG_DIR, 'g-dirty.jsonl'),
    'not-json\n' + JSON.stringify({ sessionKey: 'g-dirty', raw_message: 'ok', message_id: 1 }) + '\n',
    'utf8'
  );
  const dirty = await readRecentMessages('g-dirty', 20);
  assert.equal(dirty.length, 1, '损坏行被跳过');
  assert.equal(dirty[0].raw_message, 'ok');
});

test('index.js 注册顺序静态断言：register(ping) 先于 register(chat)', { timeout: 10000 }, async () => {
  const source = await readFile('src/index.js', 'utf8');
  const iPing = source.indexOf('register(ping)');
  const iChat = source.indexOf('register(chat)');
  assert.ok(iPing !== -1 && iChat !== -1, 'index.js 应同时注册 ping 与 chat');
  assert.ok(iPing < iChat, 'ping 必须先注册（命中即停语义下的优先级保障）');
});
