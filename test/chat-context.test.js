// upgrade-chat-pipeline Task 14 验证：上下文预算制。
// 纯函数面——fitHistoryToBudget：超预算裁最旧保最近（连续段）、预算充足全保留、恰好
// 装下与差一字节边界、最新一条也装不下、UTF-8 按字节计、system 巨大使可用 ≤ 0 历史
// 全裁（不抛）、入参不被篡改。
// 接线面——直调 chat.handle 端到端（沿袭 chat.test.js usage 用例的直调模式，不走
// dispatcher/OneBot mock）：超预算裁最旧保最近 + 静默锚点不受裁剪影响、条数上限与
// 预算双重生效（20 条内即超预算，恰好装下等号成立）、预算充足时条数上限仍生效
//（谁更紧听谁的）、system 超预算历史为空且 system 本体照发、默认预算充足全保留。
// 断言对象是 LLM 收到的 messages 形状；出站经 sender 队列在无 WS 环境仅 WARN，不影响断言。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startLlmServer } from './llm-server.js';

const DATA_DIR = `tmp/test-chat-context-${process.pid}`;
const MSG_DIR = join(DATA_DIR, 'messages');
const PERSONA_DIR = join(DATA_DIR, 'personas');
const USAGE_DIR = join(DATA_DIR, 'usage');

// ---- 装配：纯函数无需 mock，但接线用例需要 env 先于模块加载 → 顶部统一布置再动态 import ----
const llmServer = await startLlmServer();
process.env.SEND_INTERVAL_MS = '10'; // 无 WS：sender 出站失败仅 WARN，间隔只影响进程退出耗时
process.env.DATA_DIR = DATA_DIR;
process.env.PERSONA_DIR = PERSONA_DIR;
process.env.USAGE_DIR = USAGE_DIR;
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.DEEPSEEK_BASE_URL = llmServer.url;
process.env.CHAT_TIMEOUT_MS = '500';
process.env.CHAT_CONTEXT_LINES = '20';
process.env.CHAT_COOLDOWN_MS = '50';

const { config } = await import('../src/config.js');
const { fitHistoryToBudget } = await import('../src/triggers/chat-context.js');
const { buildSystemPrompt } = await import('../src/triggers/chat-system.js');
const { getPersona } = await import('../src/store/persona-store.js');
const chat = (await import('../src/triggers/chat.js')).default;

// 文件级基线（同 chat.test.js）：关随机延迟，端到端不被默认 2–8s 拖慢
config.behavior.reply.delay.enabled = false;

after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
  await llmServer.close();
});

// ---- 纯函数直测 ----

const msg = (content) => ({ role: 'user', content });

test('fitHistoryToBudget：超预算裁最旧保最近，保留最近的连续段且不篡改入参', () => {
  const history = [msg('aaaa'), msg('bbbb'), msg('cc')]; // 4 + 4 + 2 字节
  // system 'sys' 占 3 → 可用 5：最新 'cc'(2) 装下余 3，'bbbb'(4) 装不下即停——
  // 'bbbb' 连同更旧的 'aaaa' 整体被裁（连续段纪律：不从中段挖洞）
  assert.deepEqual(fitHistoryToBudget(history, 'sys', 8), [msg('cc')]);
  // 裁剪返回新数组，入参历史原样不动（调用方可继续他用）
  assert.deepEqual(history, [msg('aaaa'), msg('bbbb'), msg('cc')], '入参数组不得被篡改');
});

test('fitHistoryToBudget：预算充足全保留（顺序不变）；恰好等于总量也全保留', () => {
  const history = [msg('你好'), msg('在吗'), msg('咕噜')]; // 各 6 字节，共 18
  assert.deepEqual(fitHistoryToBudget(history, 'system', 100), history);
  // 可用 18 = 总量：三条恰好装下（等号成立），一条不裁
  assert.deepEqual(fitHistoryToBudget(history, '', 18), history);
});

test('fitHistoryToBudget：恰好边界——差 1 字节裁最旧；最新一条装不下则历史空', () => {
  const history = [msg('aaa'), msg('bb')]; // 3 + 2
  assert.deepEqual(fitHistoryToBudget(history, '', 5), history, '可用 5 = 3+2 恰好全装下');
  // 可用 4：'bb'(2) 装下余 2，'aaa'(3) 差 1 字节 → 最旧被裁
  assert.deepEqual(fitHistoryToBudget(history, '', 4), [msg('bb')]);
  // 可用 2：'bb' 恰好装下余 0，'aaa' 不再装得下（等号边界另一面）
  assert.deepEqual(fitHistoryToBudget(history, '', 2), [msg('bb')]);
  // 可用 1：最新一条也装不下 → 历史为空（当前消息仍由调用方拼入，不归预算管）
  assert.deepEqual(fitHistoryToBudget(history, '', 1), []);
  // UTF-8 按字节而非字符数计：'中中' 两字符 6 字节
  assert.deepEqual(fitHistoryToBudget([msg('中中')], '', 6), [msg('中中')]);
  assert.deepEqual(fitHistoryToBudget([msg('中中')], '', 5), []);
});

test('fitHistoryToBudget：system 巨大使可用 ≤ 0 → 历史全裁（防御极端配置，不抛）', () => {
  const history = [msg('aa'), msg('bb')];
  assert.deepEqual(fitHistoryToBudget(history, 'x'.repeat(10), 10), [], '可用恰为 0 → 空');
  assert.deepEqual(fitHistoryToBudget(history, 'x'.repeat(10), 9), [], '可用为负 → 空');
  assert.deepEqual(fitHistoryToBudget([], 'x'.repeat(10), 9), [], '空历史同样不抛');
  assert.deepEqual(fitHistoryToBudget(history, '', 0), [], '零预算 → 空');
});

// ---- 接线端到端：直调 chat.handle，断言 LLM 收到的 messages ----

let messageSeq = 0;
function privateEvent(raw, userId) {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: userId,
    self_id: 10000,
    time: 1760003000 + ++messageSeq,
    message_id: -600000 + messageSeq,
    message: [{ type: 'text', data: { text: raw } }],
    raw_message: raw,
    sender: { nickname: `私聊${userId}`, card: '', role: '' },
  };
}

async function writeHistory(sessionKey, rows) {
  // 本文件不走 dispatcher（无人先建目录），写历史前自建 messages 目录
  await mkdir(MSG_DIR, { recursive: true });
  await writeFile(join(MSG_DIR, `${sessionKey}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// 与 handle 内部同源预估 system 字节数：persona 取种子（getPersona 首访落种子，handle
// 二读同源）；场景三行里时间串数字宽度恒定、静默锚点距今几十秒恒落「刚刚还在聊」档——
// handle 实际组装的 system 与此处预估**字节数**相等（分内数字不同不影响字节数）
async function estimateSystemBytes(sessionKey, lastTimeSec) {
  const persona = await getPersona(sessionKey);
  return Buffer.byteLength(
    buildSystemPrompt(persona, { isGroup: false, nowMs: Date.now(), lastTimeSec }),
    'utf8'
  );
}

test('端到端：超预算裁最旧保最近——长历史只留最近的连续段，静默锚点不受裁剪影响', { timeout: 10000 }, async () => {
  const SK = 'p-8101';
  const nowSec = Math.floor(Date.now() / 1000);
  // 6 条超大历史（各 ~4KB）+ 2 条小历史（各 9 字节）：预算 = system + 两条小消息 +
  // 30 字节余量——任何一条大消息（>4KB）都装不下，最近两条必留
  const rows = [];
  for (let i = 1; i <= 6; i++) {
    rows.push({
      sessionKey: SK, time: nowSec - 400 + i, message_id: -810100 - i, message_type: 'private',
      user_id: 8101, raw_message: `旧话${i}` + '很长的旧内容。'.repeat(200), sender: { nickname: '旧人' },
    });
  }
  rows.push({ sessionKey: SK, time: nowSec - 30, message_id: -810107, message_type: 'private', user_id: 8101, raw_message: '新近一', sender: { nickname: '新人' } });
  rows.push({ sessionKey: SK, time: nowSec - 29, message_id: -810108, message_type: 'private', user_id: 8101, raw_message: '新近二', sender: { nickname: '新人' } });
  await writeHistory(SK, rows);

  const sysBytes = await estimateSystemBytes(SK, nowSec - 29);
  const savedBudget = config.behavior.context.budgetBytes;
  config.behavior.context.budgetBytes = sysBytes + 9 + 9 + 30;
  try {
    await chat.handle({ event: privateEvent('现在说话', 8101), sessionKey: SK });
    const messages = llmServer.requests.at(-1).body.messages;
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'user', 'user'], '只保留最近两条历史 + 当前消息');
    assert.equal(messages[1].content, '新近一');
    assert.equal(messages[2].content, '新近二');
    assert.equal(messages[3].content, '现在说话');
    assert.ok(!messages.some((m) => m.content.includes('旧话')), '装不下的大历史应从最旧端整体裁掉');
    // 静默锚点取裁剪前 prevRecords 尾部（新近二，距今约 30s）——裁剪只砍头部，不得影响静默计算
    assert.ok(messages[0].content.includes('静默时长：刚刚还在聊'), '裁剪不得影响静默时长锚点');
  } finally {
    config.behavior.context.budgetBytes = savedBudget;
  }
});

test('端到端：条数上限与预算双重生效——20 条内即超预算，恰好装下最近 3 条（等号成立）', { timeout: 10000 }, async () => {
  const SK = 'p-8102';
  const nowSec = Math.floor(Date.now() / 1000);
  // 10 条等长历史（< 20 条上限，条数不设限；每条 1505 字节，总 ~15KB 必超预算）
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push({
      sessionKey: SK, time: nowSec - 130 + i, message_id: -810200 - i, message_type: 'private',
      user_id: 8102, raw_message: `话${String(i).padStart(2, '0')}` + '中等长度。'.repeat(100), sender: { nickname: '话痨' },
    });
  }
  await writeHistory(SK, rows);

  const each = Buffer.byteLength(`话10` + '中等长度。'.repeat(100), 'utf8'); // 等长设计：条条 1505 字节
  const sysBytes = await estimateSystemBytes(SK, nowSec - 120);
  const savedBudget = config.behavior.context.budgetBytes;
  // 预算 = system + 3×1505：第 3 条装下后余 0，第 4 新的装不下即停——「恰好装下」端到端
  config.behavior.context.budgetBytes = sysBytes + each * 3;
  try {
    await chat.handle({ event: privateEvent('预算内说话', 8102), sessionKey: SK });
    const messages = llmServer.requests.at(-1).body.messages;
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'user', 'user', 'user']);
    // content 是长填充消息，取前 3 字符（'话NN'）比对身份，逐字验证保留的是最近 3 条
    assert.deepEqual(messages.slice(1, 4).map((m) => m.content.slice(0, 3)), ['话08', '话09', '话10'], '只保留装得下的最近 3 条');
    assert.equal(messages[4].content, '预算内说话');
    assert.ok(!messages.some((m) => m.content.includes('话07')), '20 条内就超预算：更旧历史应被预算裁掉');
  } finally {
    config.behavior.context.budgetBytes = savedBudget;
  }
});

test('端到端：预算充足时条数上限仍生效——25 条小历史只带最近 20 条（谁更紧听谁的）', { timeout: 10000 }, async () => {
  const SK = 'p-8103';
  const nowSec = Math.floor(Date.now() / 1000);
  // 25 条 5 字节小历史（总 125 字节 ≪ 默认预算 12000）：条数上限更紧 → 预算裁剪全保留、
  // 条数截取照常生效（两道闸门叠加，不互相吞掉）
  const rows = [];
  for (let i = 1; i <= 25; i++) {
    rows.push({
      sessionKey: SK, time: nowSec - 500 + i, message_id: -810300 - i, message_type: 'private',
      user_id: 8103, raw_message: `小${String(i).padStart(2, '0')}`, sender: { nickname: '小人' },
    });
  }
  await writeHistory(SK, rows);

  await chat.handle({ event: privateEvent('条数上限', 8103), sessionKey: SK });
  const messages = llmServer.requests.at(-1).body.messages;
  assert.equal(messages.length, 22, 'system + 20 条历史上限 + 当前消息');
  assert.equal(messages[1].content, '小06', '头部截到第 6 条（25 − 20，尾部 20 条）');
  assert.equal(messages[20].content, '小25');
  assert.equal(messages[21].content, '条数上限');
  assert.ok(!messages.some((m) => m.content.includes('小05')), '超出 20 条的最旧历史不得进入上下文');
});

test('端到端：system 巨大使可用 ≤ 0——历史全裁，system 本体照发不炸', { timeout: 10000 }, async () => {
  const SK = 'p-8104';
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = [];
  for (let i = 1; i <= 3; i++) {
    rows.push({
      sessionKey: SK, time: nowSec - 40 + i, message_id: -810400 - i, message_type: 'private',
      user_id: 8104, raw_message: `残余${i}`, sender: { nickname: '旧人' },
    });
  }
  await writeHistory(SK, rows);

  const savedBudget = config.behavior.context.budgetBytes;
  config.behavior.context.budgetBytes = 10; // 远小于 system 实际字节（数百级）→ 可用为负
  try {
    await chat.handle({ event: privateEvent('还剩什么', 8104), sessionKey: SK });
    const messages = llmServer.requests.at(-1).body.messages;
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user'], '可用 ≤ 0 时历史应全裁');
    assert.equal(messages[1].content, '还剩什么');
    assert.ok(!messages.some((m) => m.content.includes('残余')), '历史消息不得混入');
    // 防御目标：预算只管历史这一侧，system 自体不裁、照常发出（不因极端配置炸掉回复）
    assert.ok(Buffer.byteLength(messages[0].content, 'utf8') > 10, 'system 本体不受预算裁剪');
  } finally {
    config.behavior.context.budgetBytes = savedBudget;
  }
});

test('端到端：预算充足全保留——默认 12000 下多行历史（含 bot 行→assistant）原样进入上下文', { timeout: 10000 }, async () => {
  const SK = 'p-8105';
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = [
    { sessionKey: SK, time: nowSec - 50, message_id: -810501, message_type: 'private', user_id: 8105, raw_message: '早上好', sender: { nickname: '早起' } },
    { sessionKey: SK, time: nowSec - 49, message_type: 'private', user_id: 8105, raw_message: '早，本鱼刚醒', bot: true },
    { sessionKey: SK, time: nowSec - 30, message_id: -810502, message_type: 'private', user_id: 8105, raw_message: '吃火锅吗', sender: { nickname: '早起' } },
  ];
  await writeHistory(SK, rows);

  await chat.handle({ event: privateEvent('就走', 8105), sessionKey: SK });
  const messages = llmServer.requests.at(-1).body.messages;
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user', 'user']);
  assert.equal(messages[1].content, '早上好');
  assert.equal(messages[2].content, '早，本鱼刚醒');
  assert.equal(messages[3].content, '吃火锅吗');
  assert.equal(messages[4].content, '就走');
});
