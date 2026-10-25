// AIChat 触发器验证（add-aichat-mvp G1/G3/G4/G5/G6 + add-self-evolving-persona Task 7）：
// 全链路——私聊全量、群 @bot、不触发矩阵、空文本、多轮上下文（LLM messages 形状断言）、
// 冷却跳过、LLM 失败/超时兜底、ping 优先、未配置 key 不生效、注册顺序；
// Task 7 增补——system 组装（种子人设 + applyPersonaPatch 自定义注入）、resetAt 水位
// 过滤（入站与 bot 行同滤）、usage 落盘（带 usage 记账 / null 不记）。
// upgrade-chat-pipeline Task 2/3 增补——at 开关关闭群聊不触发（私聊不受影响）、出口
// 加工链随机延迟（开启吃满下限 / 关闭不 sleep）、存储合并（一次 LLM 调用恰一条 bot 行）。
// Task 4/5 增补——|| 分段连发（多条逐条出站 + 单条 bot 行合并存储 + 上下文不碎片化
// + 关闭透传）、system 动态尾部（新会话/群聊静默 2 小时注入、缓存前缀逐字节稳定）。
// Task 7/8 增补——入口条件组合器新条件端到端：名字呼唤（无 @ 喊名触发）、引用回复
//（reply bot 出站 id 触发 / reply 他人不触发）。
// Task 9/10 增补——回复带引用（群聊首帧 reply+text 段数组、次帧纯文本、JSONL 合并
// bot 行、关闭透传）、群/私双套行为规则与身份锚定段注入 system。
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
const PERSONA_DIR = join(DATA_DIR, 'personas');
const USAGE_DIR = join(DATA_DIR, 'usage');
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
process.env.PERSONA_DIR = PERSONA_DIR; // 人设/用量随 DATA_DIR 落临时目录，测后一并清理（不污染真实 data/）
process.env.USAGE_DIR = USAGE_DIR;
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.DEEPSEEK_BASE_URL = llmServer.url;
process.env.CHAT_TIMEOUT_MS = '500';
// CONFIG_PATH 指向不存在路径：行为开关跑全默认，不受本机 config.json 干扰
//（曾因读到本地 replyQuote:false 的真实配置，导致引用回复端到端用例误挂）
process.env.CONFIG_PATH = join(DATA_DIR, 'absent.json');
process.env.CHAT_CONTEXT_LINES = '20';
process.env.CHAT_COOLDOWN_MS = '600';

const onebot = await import('../src/connection/onebot.js');
const dispatcher = await import('../src/dispatch/dispatcher.js');
const registry = await import('../src/dispatch/registry.js');
const { config } = await import('../src/config.js');
const ping = (await import('../src/triggers/ping.js')).default;
const chat = (await import('../src/triggers/chat.js')).default;

// 文件级基线：关闭随机延迟（默认开启且区间 2–8s，会把所有用例拖到秒级）；
// delay 行为另有专项用例临时开启并收窄区间验证
config.behavior.reply.delay.enabled = false;

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
  // system 组装断言（add-self-evolving-persona）：种子标题 + 记忆段 + 行为规则；子串即可，不断全文
  const system = req.body.messages[0].content;
  assert.ok(system.includes('# 大肥鱼'), 'system 应含种子人设标题');
  assert.ok(system.includes('## 记忆'), 'system 应含记忆段标题');
  assert.ok(system.includes('## 行为规则'), 'system 应含行为规则标题');

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

test('群聊 @bot 触发：at 段剥离、昵称前缀、回复带引用发往同群、bot 行带 group_id', { timeout: 10000 }, async () => {
  const frameBaseline = onebotServer.frames.length;
  const ev = groupEvent(' 讲个笑话', 3001, 3002, '群友甲', SELF_ID);
  onebotServer.injectEvent(ev);

  const frame = await waitNextFrame(
    frameBaseline,
    (f) => f.action === 'send_msg' && f.params?.message_type === 'group' && f.params?.group_id === 3001
  );
  // quote 模块（Task 9）默认开启：群聊首帧为消息段数组——reply 段指向触发消息
  // message_id + text 段携带回复内容（napcat-protocol §3.4 形状）
  assert.deepEqual(frame.params.message, [
    { type: 'reply', data: { id: String(ev.message_id) } },
    { type: 'text', data: { text: 'MOCK_LLM_REPLY' } },
  ], '群聊首帧应为 reply+text 段数组');

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

test('at 开关关闭：群聊 @bot 不触发（spec「条件全关」场景），私聊全量触发不受影响', { timeout: 10000 }, async () => {
  const savedAtEnabled = config.behavior.trigger.at.enabled;
  config.behavior.trigger.at.enabled = false; // 消息不含别名/reply 段，关 at 后其余条件也不命中
  try {
    onebotServer.injectEvent(groupEvent('关了还叫得动吗', 3301, 3302, '关开关', SELF_ID));
    await delay(400);

    assert.ok(
      !llmServer.requests.some((r) => JSON.stringify(r.body).includes('关了还叫得动吗')),
      'at 开关关闭后群聊 @bot 不得调 LLM'
    );
    assert.ok(
      !onebotServer.frames.some((f) => f.params?.group_id === 3301),
      'at 开关关闭后群聊 @bot 不得产生出站帧'
    );

    // 私聊全量触发在 chat.js 顶层短路，不归条件组合器管：开关关闭不影响私聊
    const frameBaseline = onebotServer.frames.length;
    onebotServer.injectEvent(privateEvent('私聊照常', 3303));
    await waitNextFrame(
      frameBaseline,
      (f) => f.action === 'send_msg' && f.params?.user_id === 3303 && f.params?.message === 'MOCK_LLM_REPLY'
    );
  } finally {
    config.behavior.trigger.at.enabled = savedAtEnabled;
  }
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

test('system 组装：种子人设注入（空记忆保留标题与空行）；patch 自定义 character/memory 注入', { timeout: 10000 }, async () => {
  const { applyPersonaPatch } = await import('../src/store/persona-store.js');

  // 种子会话（persona 首访落种子）：system = 种子 character + 空记忆段 + 行为规则
  const frameBaseline = onebotServer.frames.length;
  onebotServer.injectEvent(privateEvent('你是谁', 7001));
  await waitNextFrame(
    frameBaseline,
    (f) => f.action === 'send_msg' && f.params?.user_id === 7001 && f.params?.message === 'MOCK_LLM_REPLY'
  );

  let system = llmServer.requests.at(-1).body.messages[0].content;
  assert.ok(system.startsWith('# 大肥鱼'), 'system 应以种子 character 开头');
  assert.ok(system.includes('呆萌心大，反应慢半拍，但很真诚'), '种子性格内容应注入');
  assert.ok(system.includes('## 记忆'), '记忆段标题应保留（空记忆亦然）');
  // 空 memory：『## 记忆』与『## 行为规则』之间仅保留固定空行（结构稳定 > 内容紧凑，缓存友好）
  assert.equal(
    system.split('## 记忆')[1].split('## 行为规则')[0],
    '\n\n\n\n',
    '空记忆应保留标题与空行结构'
  );
  assert.ok(system.includes('## 行为规则'), '行为规则标题应在');
  assert.ok(system.includes('- 用简短口语化的中文回复，不要使用 Markdown 格式'), '行为规则行应注入');
  // Task 10：私聊版规则 + 身份锚定段（群/私分流与固定身份段端到端注入）
  assert.ok(system.includes('- 一对一私聊，可以聊得更展开、多接几句'), '私聊版规则应注入');
  assert.ok(!system.includes('不刷屏'), '私聊 system 不得混入群聊刷屏文案（分流不串台）');
  assert.ok(system.includes('## 身份与消息格式'), '身份锚定段应注入');
  assert.ok(system.includes('大肥鱼'), '身份段应含大肥鱼身份锚定');

  // patch 会话：applyPersonaPatch 预置自定义 character/memory 后，注入的应是自定义内容
  await applyPersonaPatch('p-7002', {
    character: '你是七号测试鱼，冷静话少。',
    memory: '- [2026-10-25 10:00] 测试者: 七号鱼爱吃火锅',
  });
  const baseline2 = onebotServer.frames.length;
  onebotServer.injectEvent(privateEvent('你记得啥', 7002));
  await waitNextFrame(
    baseline2,
    (f) => f.action === 'send_msg' && f.params?.user_id === 7002 && f.params?.message === 'MOCK_LLM_REPLY'
  );

  system = llmServer.requests.at(-1).body.messages[0].content;
  assert.ok(system.startsWith('你是七号测试鱼，冷静话少。'), 'patch 的 character 应注入');
  assert.ok(system.includes('七号鱼爱吃火锅'), 'patch 的 memory 应注入');
  assert.ok(system.includes('## 记忆') && system.includes('## 行为规则'), '段结构保持固定');
  assert.ok(!system.includes('呆萌心大'), 'patch 后不得残留种子性格');
});

test('reset 水位过滤：resetAt 之前的入站行与 bot 行同滤，之后的消息保留', { timeout: 10000 }, async () => {
  const { updateState } = await import('../src/store/session-state.js');
  const { writeFile } = await import('node:fs/promises');

  // 手工构造历史：resetAt 之前一条入站 + 一条 bot 行（水位同滤的两类对象），之后一条入站
  const rows = [
    { sessionKey: 'p-7101', time: 1000, message_id: -91001, message_type: 'private', user_id: 7101, raw_message: '水位前的旧话', sender: { nickname: '旧人' } },
    { sessionKey: 'p-7101', time: 2000, message_type: 'private', user_id: 7101, raw_message: '水位前的旧回复', bot: true },
    { sessionKey: 'p-7101', time: 3000, message_id: -91002, message_type: 'private', user_id: 7101, raw_message: '水位后的新话', sender: { nickname: '新人' } },
  ];
  await writeFile(join(MSG_DIR, 'p-7101.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  await updateState('p-7101', { resetAt: 2500 }); // 水位落在 2000 与 3000 之间

  const frameBaseline = onebotServer.frames.length;
  onebotServer.injectEvent(privateEvent('过水位的新消息', 7101));
  await waitNextFrame(
    frameBaseline,
    (f) => f.action === 'send_msg' && f.params?.user_id === 7101 && f.params?.message === 'MOCK_LLM_REPLY'
  );

  const messages = llmServer.requests.at(-1).body.messages;
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system', 'user', 'user'],
    '历史仅剩 resetAt 之后的入站行 + 当前消息'
  );
  assert.equal(messages[1].content, '水位后的新话');
  assert.equal(messages[2].content, '过水位的新消息');
  const all = messages.map((m) => m.content).join('\n');
  assert.ok(!all.includes('水位前的旧话'), 'resetAt 之前的入站行应被水位过滤');
  assert.ok(!all.includes('水位前的旧回复'), 'resetAt 之前的 bot 行应被水位过滤（bot 行同滤）');
});

test('usage 落盘：LLM 带 usage 记一行 kind:chat（token 数对应）；usage 为 null 不记账', { timeout: 10000 }, async () => {
  const { appendUsage } = await import('../src/store/usage-store.js');
  const { access } = await import('node:fs/promises');

  // 带 usage：新会话 p-7201，用量文件从无到有、恰一行、字段一一对应
  llmServer.setReply('USAGE_REPLY', { prompt_tokens: 101, completion_tokens: 202, total_tokens: 303, prompt_cache_hit_tokens: 404 });
  try {
    const frameBaseline = onebotServer.frames.length;
    onebotServer.injectEvent(privateEvent('用量记账', 7201));
    await waitNextFrame(
      frameBaseline,
      (f) => f.action === 'send_msg' && f.params?.user_id === 7201 && f.params?.message === 'USAGE_REPLY'
    );
    await waitUntil(async () => {
      try {
        return (await readFile(join(USAGE_DIR, 'p-7201.jsonl'), 'utf8')).trim() !== '';
      } catch {
        return false; // fire-and-forget 异步落盘，未到即未到
      }
    });
    const lines = (await readFile(join(USAGE_DIR, 'p-7201.jsonl'), 'utf8')).split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 1, '新会话应恰记一行');
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.kind, 'chat');
    assert.equal(rec.model, 'deepseek-chat');
    assert.equal(rec.prompt_tokens, 101);
    assert.equal(rec.completion_tokens, 202);
    assert.equal(rec.total_tokens, 303);
    assert.equal(rec.prompt_cache_hit_tokens, 404);
    assert.ok(Number.isFinite(rec.time), 'time 应为毫秒时间戳');

    // usage 为 null（响应整体缺 usage 字段）：不记账。直接调 handle 取确定性——handle
    // 返回即 usage 分支已同步执行完；回复出口已改为「加工链 → 存储合并 → 逐条发送」，
    // 出站走真实 sender 队列（mock OneBot 自然收帧，无需再 mock ctx.reply）；再往
    // 用量链尾塞 sentinel 并等其落盘，此前提交（若有）必已写完，此时断言文件不存在
    // 才是可靠否定。
    llmServer.setReply('NO_USAGE_REPLY', null);
    const event = privateEvent('免记账', 7202);
    await chat.handle({ event, sessionKey: 'p-7202' });
    appendUsage('sentinel-null-usage', { time: 1, kind: 'chat', model: 'probe' });
    await waitUntil(async () => {
      try {
        return (await readFile(join(USAGE_DIR, 'sentinel-null-usage.jsonl'), 'utf8')).trim() !== '';
      } catch {
        return false;
      }
    });
    await assert.rejects(
      () => access(join(USAGE_DIR, 'p-7202.jsonl')),
      (err) => err.code === 'ENOENT',
      'usage 为 null 不得落盘'
    );
  } finally {
    llmServer.setReply('MOCK_LLM_REPLY');
  }
});

test('延迟开启：LLM 回复经随机延迟后出站（耗时 ≥ minMs，spec「延迟生效」）', { timeout: 10000 }, async () => {
  const savedDelay = { ...config.behavior.reply.delay };
  // 收窄区间到 120–180ms：既能让「吃满下限」可断言，又不拖慢套件
  config.behavior.reply.delay.enabled = true;
  config.behavior.reply.delay.minMs = 120;
  config.behavior.reply.delay.maxMs = 180;
  try {
    const frameBaseline = onebotServer.frames.length;
    const t0 = Date.now();
    onebotServer.injectEvent(privateEvent('等等再回', 7301));
    await waitNextFrame(
      frameBaseline,
      (f) => f.action === 'send_msg' && f.params?.user_id === 7301 && f.params?.message === 'MOCK_LLM_REPLY'
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 120, `延迟开启时出站耗时 ${elapsed}ms 应 ≥ minMs 120ms`);
    assert.ok(elapsed < 2000, `延迟开启时出站耗时 ${elapsed}ms 异常超出区间`);
  } finally {
    Object.assign(config.behavior.reply.delay, savedDelay);
  }
});

test('延迟关闭：enabled=false 直发不 sleep（出站耗时远低于默认 minMs 2000）', { timeout: 10000 }, async () => {
  const frameBaseline = onebotServer.frames.length;
  const t0 = Date.now();
  onebotServer.injectEvent(privateEvent('秒回我', 7302));
  await waitNextFrame(
    frameBaseline,
    (f) => f.action === 'send_msg' && f.params?.user_id === 7302 && f.params?.message === 'MOCK_LLM_REPLY'
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, `延迟关闭时出站耗时 ${elapsed}ms 应 < 1500ms（误走默认延迟将 ≥ 2000ms）`);
});

test('存储合并：一次 LLM 回复恰落一条 bot 行，raw_message 为 LLM 原始输出全文', { timeout: 10000 }, async () => {
  const frameBaseline = onebotServer.frames.length;
  onebotServer.injectEvent(privateEvent('合并存储', 7303));
  await waitNextFrame(
    frameBaseline,
    (f) => f.action === 'send_msg' && f.params?.user_id === 7303 && f.params?.message === 'MOCK_LLM_REPLY'
  );
  await waitUntil(async () => {
    try {
      return (await readLines('p-7303')).length === 2; // 入站行 + bot 行
    } catch {
      return false; // 文件尚未创建（fire-and-forget 异步写）
    }
  });
  const botLines = (await readLines('p-7303'))
    .map((line) => JSON.parse(line))
    .filter((rec) => rec.bot === true);
  assert.equal(botLines.length, 1, '一次 LLM 调用只允许一条 bot 行（Task 4 分段也合并存储）');
  assert.equal(botLines[0].raw_message, 'MOCK_LLM_REPLY', 'bot 行存 LLM 原始输出，非分段合并值');
  assert.ok(!('message_id' in botLines[0]), 'bot 行不应有 message_id');
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

// ---- upgrade-chat-pipeline Task 4：|| 分段连发 ----

test('分段连发（换行分隔）：LLM 输出 \n\n 分段 → 两条消息逐条出站（0.9.3 修复：LLM 实际爱用换行不爱用 ||）', { timeout: 10000 }, async () => {
  llmServer.setReply('泡泡接住啦咕噜。\n\n主人要画图啦？本鱼只会啃啃鳍。');
  try {
    const frameBaseline = onebotServer.frames.length;
    onebotServer.injectEvent(privateEvent('换行连发试试', 7404));

    const first = await waitNextFrame(
      frameBaseline,
      (f) => f.action === 'send_msg' && f.params?.user_id === 7404 && f.params?.message === '泡泡接住啦咕噜。'
    );
    assert.ok(first, '第一行应先出站');
    const afterFirst = onebotServer.frames.length;
    const second = await waitNextFrame(
      afterFirst,
      (f) =>
        f.action === 'send_msg' && f.params?.user_id === 7404 && f.params?.message === '主人要画图啦？本鱼只会啃啃鳍。'
    );
    assert.ok(second, '第二行应随后逐条出站（不得合并成一个带换行的气泡）');
  } finally {
    llmServer.setReply('MOCK_LLM_REPLY');
  }
});

test('分段连发：LLM 输出含 || → 两条消息逐条出站，JSONL 恰一条 bot 行存原始输出', { timeout: 10000 }, async () => {
  llmServer.setReply('今天好冷||想吃火锅了咕噜');
  try {
    const frameBaseline = onebotServer.frames.length;
    onebotServer.injectEvent(privateEvent('连发试试', 7401));

    const first = await waitNextFrame(
      frameBaseline,
      (f) => f.action === 'send_msg' && f.params?.user_id === 7401 && f.params?.message === '今天好冷'
    );
    assert.ok(first, '第一段应先出站');
    const afterFirst = onebotServer.frames.length;
    const second = await waitNextFrame(
      afterFirst,
      (f) => f.action === 'send_msg' && f.params?.user_id === 7401 && f.params?.message === '想吃火锅了咕噜'
    );
    assert.ok(second, '第二段应随后逐条出站（spec「拆分发送」）');

    // 存储合并（spec「上下文不碎片化」的写入面）：两条出站但只落一条 bot 行，
    // raw_message 为 LLM 原始输出（含 ||），不是分段拼接值
    await waitUntil(async () => {
      try {
        return (await readLines('p-7401')).length === 2; // 入站行 + 合并 bot 行
      } catch {
        return false; // 文件尚未创建（fire-and-forget 异步写）
      }
    });
    const botLines = (await readLines('p-7401'))
      .map((line) => JSON.parse(line))
      .filter((rec) => rec.bot === true);
    assert.equal(botLines.length, 1, '分段连发只落一条 bot 行');
    assert.equal(botLines[0].raw_message, '今天好冷||想吃火锅了咕噜', 'raw_message 为 LLM 原始输出');
  } finally {
    llmServer.setReply('MOCK_LLM_REPLY');
  }
});

test('分段后上下文重建：含 || 的 bot 行呈现为单条 assistant（历史不碎片化）', { timeout: 10000 }, async () => {
  await delay(700); // 等会话冷却（600ms）过期
  const frameBaseline = onebotServer.frames.length;
  onebotServer.injectEvent(privateEvent('接着上一条聊', 7401));
  await waitNextFrame(
    frameBaseline,
    (f) => f.action === 'send_msg' && f.params?.user_id === 7401 && f.params?.message === 'MOCK_LLM_REPLY'
  );

  const messages = llmServer.requests
    .find((r) => r.body?.messages?.some((m) => m.content === '接着上一条聊'))
    .body.messages;
  const assistants = messages.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 1, '上一轮分段回复只占一条 assistant 消息');
  assert.equal(assistants[0].content, '今天好冷||想吃火锅了咕噜', '内容为含 || 的原始输出全文');
});

test('分段关闭：enabled=false 时含 || 的输出整段单条发送（不拆分）', { timeout: 10000 }, async () => {
  const savedEnabled = config.behavior.reply.split.enabled;
  config.behavior.reply.split.enabled = false;
  llmServer.setReply('一条||两条');
  try {
    const frameBaseline = onebotServer.frames.length;
    onebotServer.injectEvent(privateEvent('不拆了', 7402));
    await waitNextFrame(
      frameBaseline,
      (f) => f.action === 'send_msg' && f.params?.user_id === 7402 && f.params?.message === '一条||两条'
    );
    const framesFor = () => onebotServer.frames.filter((f) => f.action === 'send_msg' && f.params?.user_id === 7402);
    await delay(200); // 观察窗：若误拆分，第二段会在 sender 队列间隔（50ms）后出站
    assert.equal(framesFor().length, 1, '关闭分段时整段单条发送，不得拆开发送');
  } finally {
    config.behavior.reply.split.enabled = savedEnabled;
    llmServer.setReply('MOCK_LLM_REPLY');
  }
});

// ---- upgrade-chat-pipeline Task 5：system 动态尾部 ----

test('system 动态尾部（新会话私聊）：含 ## 当前场景、时间/私聊/「这是新对话的开始」', { timeout: 10000 }, async () => {
  const frameBaseline = onebotServer.frames.length;
  onebotServer.injectEvent(privateEvent('现在几点', 7501));
  await waitNextFrame(
    frameBaseline,
    (f) => f.action === 'send_msg' && f.params?.user_id === 7501 && f.params?.message === 'MOCK_LLM_REPLY'
  );

  const system = llmServer.requests
    .find((r) => r.body?.messages?.some((m) => m.content === '现在几点'))
    .body.messages[0].content;
  assert.ok(system.includes('## 当前场景'), '动态尾部标题应注入');
  assert.ok(
    /- 当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}（周[一二三四五六日]）/.test(system),
    '当前时间行应为 YYYY-MM-DD HH:mm（周X）'
  );
  assert.ok(system.includes('- 场景：私聊'), '私聊场景');
  assert.ok(system.includes('- 静默时长：这是新对话的开始'), '新会话（当前消息去重后无历史）应注明新对话');
});

test('system 动态尾部（群聊 + 静默 2 小时）：尾部含群聊与「距上一条消息约 2 小时」', { timeout: 10000 }, async () => {
  const { writeFile } = await import('node:fs/promises');
  // 手工预置一条 2 小时前的入站行作静默锚点：当前消息已被 dispatcher 落盘且按
  // message_id 去重——不会把静默算成「刚刚」（去重是 lastTimeSec 正确性的前提）
  const twoHoursAgoSec = Math.floor(Date.now() / 1000) - 7200;
  await writeFile(
    join(MSG_DIR, 'g-7502.jsonl'),
    JSON.stringify({
      sessionKey: 'g-7502', time: twoHoursAgoSec, message_id: -97502, message_type: 'group',
      group_id: 7502, user_id: 75021, raw_message: '两小时前的旧话', sender: { nickname: '旧人' },
    }) + '\n',
    'utf8'
  );

  const frameBaseline = onebotServer.frames.length;
  onebotServer.injectEvent(groupEvent('刚回来', 7502, 75022, '新人', SELF_ID));
  await waitNextFrame(frameBaseline, (f) => f.action === 'send_msg' && f.params?.group_id === 7502);

  const system = llmServer.requests
    .find((r) => r.body?.messages?.some((m) => m.content === '新人: 刚回来'))
    .body.messages[0].content;
  assert.ok(system.includes('- 场景：群聊'), '群聊场景');
  assert.ok(system.includes('- 静默时长：距上一条消息约 2 小时'), '静默 2 小时应出人性化文案（spec「尾部注入」场景）');
  // Task 10：群聊版规则 + 身份锚定段（群/私分流端到端的群聊侧）
  assert.ok(system.includes('不刷屏'), '群聊版规则应注入（克制不刷屏）');
  assert.ok(!system.includes('聊得更展开'), '群聊 system 不得混入私聊展开文案（分流不串台）');
  assert.ok(system.includes('## 身份与消息格式'), '身份锚定段应注入');
  assert.ok(system.includes('「昵称: 」开头的前缀是群友的名字'), '身份段应说明群聊昵称前缀语义');
});

test('缓存前缀稳定：同会话连续两轮，system 固定前缀逐字节一致、动态尾部随轮次变化', { timeout: 10000 }, async () => {
  const frameBaseline = onebotServer.frames.length;
  onebotServer.injectEvent(privateEvent('第一轮前缀', 7503));
  await waitNextFrame(
    frameBaseline,
    (f) => f.action === 'send_msg' && f.params?.user_id === 7503 && f.params?.message === 'MOCK_LLM_REPLY'
  );
  const sys1 = llmServer.requests
    .find((r) => r.body?.messages?.some((m) => m.content === '第一轮前缀'))
    .body.messages[0].content;

  await delay(700); // 冷却过期后同会话第二轮触发
  const baseline2 = onebotServer.frames.length;
  onebotServer.injectEvent(privateEvent('第二轮前缀', 7503));
  await waitNextFrame(
    baseline2,
    (f) => f.action === 'send_msg' && f.params?.user_id === 7503 && f.params?.message === 'MOCK_LLM_REPLY'
  );
  const sys2 = llmServer.requests
    .find((r) => r.body?.messages?.some((m) => m.content === '第二轮前缀'))
    .body.messages[0].content;

  const idx1 = sys1.indexOf('## 当前场景');
  const idx2 = sys2.indexOf('## 当前场景');
  assert.ok(idx1 > 0 && idx2 > 0, '两轮 system 都应含动态尾部');
  assert.equal(sys1.slice(0, idx1), sys2.slice(0, idx2), '固定前缀（character+记忆+规则）逐字节一致，命中缓存的前提');
  assert.notEqual(sys1, sys2, '动态尾部（静默：新对话 → 刚刚还在聊）应随轮次变化');
});

// ---- upgrade-chat-pipeline Task 7/8：新条件端到端 ----

test('名字呼唤端到端：群聊无 @ 喊「大肥鱼」→ chat 触发、LLM 收到、回复出站（spec「喊名字即应」）', { timeout: 10000 }, async () => {
  const frameBaseline = onebotServer.frames.length;
  const ev = groupEvent('大肥鱼今天吃什么', 7601, 76011, '喊名君');
  onebotServer.injectEvent(ev);
  await waitNextFrame(frameBaseline, (f) => f.action === 'send_msg' && f.params?.group_id === 7601);

  const messages = llmServer.requests.at(-1).body.messages;
  const last = messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content, '喊名君: 大肥鱼今天吃什么', '喊名正文进 prompt（无 at 段可剥离，原样携带）');
  // 回复出站到了同群；群聊首帧带引用（Task 9：reply 段指向触发消息 message_id）
  const frame = onebotServer.frames.slice(frameBaseline).find((f) => f.params?.group_id === 7601);
  assert.deepEqual(frame.params.message, [
    { type: 'reply', data: { id: String(ev.message_id) } },
    { type: 'text', data: { text: 'MOCK_LLM_REPLY' } },
  ], '名字呼唤触发的群聊回复首帧同样带引用');
});

test('引用回复端到端：reply bot 出站 id 触发（reply 段剥离）；reply 他人消息不触发', { timeout: 10000 }, async () => {
  const { recordBotMessageId } = await import('../src/sender/bot-msg-ids.js');
  // 预置 bot 出站 id（sender 发送确认后真实入集的链路见 sender.test.js；本用例聚焦
  // 集合 → replyQuote → 组合器 → chat 全链路）。数字入集 + reply 段字符串引用，
  // 顺带验证 id 两型归一
  recordBotMessageId(-888001);

  // reply bot 消息 + 文字：触发（spec「引用 bot 被应答」）
  const replyBotEvent = groupEvent('你刚说什么', 7602, 76021, '引用君', null);
  replyBotEvent.message.unshift({ type: 'reply', data: { id: '-888001' } });
  const frameBaseline = onebotServer.frames.length;
  onebotServer.injectEvent(replyBotEvent);
  await waitNextFrame(frameBaseline, (f) => f.action === 'send_msg' && f.params?.group_id === 7602);

  const last = llmServer.requests.at(-1).body.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content, '引用君: 你刚说什么', 'reply 段剥离，正文进 prompt');

  // reply 他人消息：不触发（spec「引用他人不触发」）。按会话归属断言：该群不得出现
  // 在任何 LLM 请求或出站帧中
  const replyOtherEvent = groupEvent('引用的是别人', 7603, 76031, '路人戊', null);
  replyOtherEvent.message.unshift({ type: 'reply', data: { id: -999001 } });
  onebotServer.injectEvent(replyOtherEvent);
  await delay(400); // 观察窗：若误触发，LLM 请求与出站帧此刻必已可见
  assert.ok(
    !llmServer.requests.some((r) => JSON.stringify(r.body).includes('引用的是别人')),
    'reply 他人消息不得调 LLM'
  );
  assert.ok(
    !onebotServer.frames.some((f) => f.params?.group_id === 7603),
    'reply 他人消息不得产生出站帧'
  );
});

// ---- upgrade-chat-pipeline Task 9：回复带引用端到端 ----

test('回复带引用端到端：群聊 LLM 输出 a||b → 首帧段数组（reply+text a）、次帧纯文本 b；JSONL 一条 bot 行原始输出', { timeout: 10000 }, async () => {
  llmServer.setReply('甲段||乙段');
  try {
    const frameBaseline = onebotServer.frames.length;
    const ev = groupEvent('带引用连发', 7701, 77011, '引用连发君', SELF_ID);
    onebotServer.injectEvent(ev);

    // 首帧：reply 段（id=触发消息 message_id）+ text 段（split 后的第一段）
    const first = await waitNextFrame(
      frameBaseline,
      (f) => f.action === 'send_msg' && f.params?.message_type === 'group' && f.params?.group_id === 7701
    );
    assert.deepEqual(first.params.message, [
      { type: 'reply', data: { id: String(ev.message_id) } },
      { type: 'text', data: { text: '甲段' } },
    ], '首帧应为 reply 段（指向触发消息）+ text 段（spec「群聊带引用」）');

    // 次帧：纯文本第二段（引用只挂首帧）
    const second = await waitNextFrame(
      frameBaseline,
      (f) => f.action === 'send_msg' && f.params?.group_id === 7701 && f.params.message === '乙段'
    );
    assert.equal(second.params.message, '乙段', '第二段为纯文本（严格等值不会误匹配段数组首帧）');

    // JSONL 合并：一次 LLM 调用恰一条 bot 行，raw_message 为原始输出（含 ||）
    await waitUntil(async () => {
      try {
        return (await readLines('g-7701')).length === 2; // 入站行 + 合并 bot 行
      } catch {
        return false; // 文件尚未创建（fire-and-forget 异步写）
      }
    });
    const botLines = (await readLines('g-7701'))
      .map((line) => JSON.parse(line))
      .filter((rec) => rec.bot === true);
    assert.equal(botLines.length, 1, '分段+引用连发只落一条 bot 行');
    assert.equal(botLines[0].raw_message, '甲段||乙段', 'bot 行存 LLM 原始输出（引用段不进存储）');
  } finally {
    llmServer.setReply('MOCK_LLM_REPLY');
  }
});

test('引用关闭：enabled=false 时群聊回复纯文本直发（无 reply 段）', { timeout: 10000 }, async () => {
  const savedEnabled = config.behavior.reply.quote.enabled;
  config.behavior.reply.quote.enabled = false;
  try {
    const frameBaseline = onebotServer.frames.length;
    onebotServer.injectEvent(groupEvent('关了引用', 7702, 77021, '关引用君', SELF_ID));
    const frame = await waitNextFrame(
      frameBaseline,
      (f) => f.action === 'send_msg' && f.params?.group_id === 7702 && f.params.message === 'MOCK_LLM_REPLY'
    );
    assert.equal(frame.params.message, 'MOCK_LLM_REPLY', '关闭引用后首帧应为纯文本字符串');
    // 观察窗：单条回复（MOCK_LLM_REPLY 无 ||），若误挂引用会出现段数组帧
    await delay(200);
    assert.ok(
      !onebotServer.frames.slice(frameBaseline).some((f) => Array.isArray(f.params?.message)),
      '关闭引用后不得出现段数组出站帧'
    );
  } finally {
    config.behavior.reply.quote.enabled = savedEnabled;
  }
});
