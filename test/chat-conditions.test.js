// upgrade-chat-pipeline Task 2 验证：入口条件组合器——at 模块纯谓词 + 组合器开关语义。
// Task 7 增补：nameCall 名字呼唤（别名子串、大小写不敏感、空别名兜底、与 @ 任一命中）。
// Task 8 增补：replyQuote 引用回复（reply 段 + bot 出站 id 集合、id 两型归一）。
// chat.js 的群聊判定入口即 matchGroupChat；端到端触发链路（LLM 不调、无出站帧）另见 chat.test.js。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CONFIG_PATH 指向不存在路径：组合器测试跑在全默认开关上，不受本机 config.json 干扰
const tmp = mkdtempSync(join(tmpdir(), 'bff-chat-cond-'));
process.env.CONFIG_PATH = join(tmp, 'absent.json');

const { matchAt, matchNameCall, matchReplyQuote, matchGroupChat, chatConditions } = await import('../src/triggers/chat-conditions.js');
const { config } = await import('../src/config.js');
const { recordBotMessageId, clearBotMessageIds } = await import('../src/sender/bot-msg-ids.js');

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const SELF_ID = 10000;

// 群聊事件构造（组合器只管群聊层；message 可传任意形状以测容错分支）
function groupEvent(message) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: 3001,
    user_id: 3002,
    self_id: SELF_ID,
    time: 1760003000,
    message_id: -1,
    message,
    raw_message: '',
    sender: { nickname: '群友甲' },
  };
}

test('条件数组结构：at / nameCall / replyQuote 三模块，模块名即 config.behavior.trigger 开关键', () => {
  assert.deepEqual(chatConditions.map((c) => c.name), ['at', 'nameCall', 'replyQuote']);
  for (const cond of chatConditions) {
    assert.equal(typeof cond.match, 'function', `模块 ${cond.name} 契约 { name, match }`);
  }
});

test('at 等价回归：@self 命中（qq 数字/字符串两型），@他人 / @全体 / 非段数组不命中', () => {
  // 命中：qq 字符串型（OneBot 常见形态）
  assert.equal(
    matchAt(groupEvent([{ type: 'at', data: { qq: String(SELF_ID) } }, { type: 'text', data: { text: ' hi' } }])),
    true
  );
  // 命中：qq 数字型（String() 双侧归一，与现状严格等价）
  assert.equal(matchAt(groupEvent([{ type: 'at', data: { qq: SELF_ID } }])), true);
  // @他人不命中
  assert.equal(matchAt(groupEvent([{ type: 'at', data: { qq: '99999' } }])), false);
  // @全体 'all' 不命中
  assert.equal(matchAt(groupEvent([{ type: 'at', data: { qq: 'all' } }])), false);
  // message 非数组（字符串快照/容错场景）不命中
  assert.equal(matchAt(groupEvent('[@bot] hi')), false);
  assert.equal(matchAt(groupEvent(undefined)), false);
});

// ---- Task 7：nameCall 名字呼唤纯谓词 ----

test('nameCall 纯谓词：默认别名子串命中（"大肥鱼今天吃什么"），不含别名不命中', () => {
  // spec「喊名字即应」场景：无 @ 纯喊名
  assert.equal(
    matchNameCall(groupEvent([{ type: 'text', data: { text: '大肥鱼今天吃什么' } }]), ['大肥鱼', '肥鱼']),
    true,
    '"大肥鱼今天吃什么" 含 "大肥鱼" 应命中（includes 子串）'
  );
  // 第二别名子串同样命中
  assert.equal(
    matchNameCall(groupEvent([{ type: 'text', data: { text: '肥鱼在吗' } }]), ['大肥鱼', '肥鱼']),
    true,
    '含 "肥鱼" 也应命中'
  );
  assert.equal(
    matchNameCall(groupEvent([{ type: 'text', data: { text: '今天吃什么呢' } }]), ['大肥鱼', '肥鱼']),
    false,
    '不含任何别名不得命中'
  );
});

test('nameCall 大小写不敏感：别名 fish 命中 "FIsh 好"（text 与别名双侧小写化）', () => {
  assert.equal(matchNameCall(groupEvent([{ type: 'text', data: { text: 'FIsh 好' } }]), ['fish']), true);
  assert.equal(matchNameCall(groupEvent([{ type: 'text', data: { text: 'FISH 好耶' } }]), ['Fish']), true);
  assert.equal(matchNameCall(groupEvent([{ type: 'text', data: { text: 'fi sh 好耶' } }]), ['fish']), false, '子串匹配，空格打断不算');
});

test('nameCall 配置事故兜底：空数组 / 非数组 / 空串别名恒不命中', () => {
  const ev = groupEvent([{ type: 'text', data: { text: '随便聊聊' } }]);
  assert.equal(matchNameCall(ev, []), false, '空别名列表恒不命中（兜底）');
  assert.equal(matchNameCall(ev, undefined), false, 'aliases 缺失恒不命中');
  assert.equal(matchNameCall(ev, null), false, 'aliases 为 null 恒不命中');
  assert.equal(matchNameCall(ev, ['']), false, '空串别名不得让所有消息误命中');
});

test('nameCall 非文本段不算喊名：纯 @ / 纯 reply 消息（extractText 为空）不命中', () => {
  assert.equal(
    matchNameCall(groupEvent([{ type: 'at', data: { qq: String(SELF_ID) } }]), ['大肥鱼']),
    false,
    '纯 @ 无文本喊不出名'
  );
  assert.equal(
    matchNameCall(groupEvent([{ type: 'reply', data: { id: -1001 } }]), ['大肥鱼']),
    false,
    '纯 reply 无文本不命中'
  );
});

// ---- Task 8：replyQuote 引用回复纯谓词 ----

test('replyQuote 纯谓词：引用 bot 消息命中；他人 id / 无 reply 段 / 非段数组不命中', () => {
  clearBotMessageIds();
  recordBotMessageId(-1001); // 模拟 bot 出站确认过的 id（sender 真实记录链路见 sender.test.js）
  assert.equal(
    matchReplyQuote(groupEvent([{ type: 'reply', data: { id: -1001 } }, { type: 'text', data: { text: ' 你说' } }])),
    true,
    'reply 段指向 bot 出站 id 应命中'
  );
  assert.equal(
    matchReplyQuote(groupEvent([{ type: 'reply', data: { id: -2002 } }, { type: 'text', data: { text: ' 引用别人' } }])),
    false,
    '引用他人消息不命中'
  );
  assert.equal(
    matchReplyQuote(groupEvent([{ type: 'text', data: { text: '没有引用段' } }])),
    false,
    '无 reply 段不命中'
  );
  assert.equal(matchReplyQuote(groupEvent('字符串快照')), false, 'message 非数组不命中');
  assert.equal(matchReplyQuote(groupEvent(undefined)), false);
});

test('replyQuote id 两型归一：数字入集字符串引用、字符串入集数字引用都命中', () => {
  clearBotMessageIds();
  recordBotMessageId(3001); // 数字入集（send_msg 响应形态）
  assert.equal(matchReplyQuote(groupEvent([{ type: 'reply', data: { id: '3001' } }])), true, '字符串型 reply id 命中数字型记录');
  recordBotMessageId('3002'); // 字符串入集（reply 段常见形态）
  assert.equal(matchReplyQuote(groupEvent([{ type: 'reply', data: { id: 3002 } }])), true, '数字型 reply id 命中字符串型记录');
});

test('组合器开关语义：默认开时 @bot 触发；at.enabled=false 时 @bot 不触发（条件全关场景）', () => {
  const ev = groupEvent([{ type: 'at', data: { qq: String(SELF_ID) } }]);
  assert.equal(config.behavior.trigger.at.enabled, true, '默认开关应开启');
  assert.equal(matchGroupChat(ev), true, '默认配置下群聊 @bot 应触发');

  const saved = config.behavior.trigger.at.enabled;
  config.behavior.trigger.at.enabled = false;
  try {
    assert.equal(matchGroupChat(ev), false, 'at 关闭后群聊 @bot 不得触发');
    // 开关关了，@全体这种本就不命中的消息自然也不触发
    assert.equal(matchGroupChat(groupEvent([{ type: 'at', data: { qq: 'all' } }])), false);
  } finally {
    config.behavior.trigger.at.enabled = saved;
  }
});

test('组合器 nameCall 接线：默认开时喊名触发（无 @）；enabled=false 时喊名不触发（spec「开关关闭」）', () => {
  const ev = groupEvent([{ type: 'text', data: { text: '大肥鱼今天吃什么' } }]);
  assert.equal(config.behavior.trigger.nameCall.enabled, true, '默认开关应开启');
  assert.equal(matchGroupChat(ev), true, '默认配置下喊名应触发（spec「喊名字即应」）');

  const saved = config.behavior.trigger.nameCall.enabled;
  config.behavior.trigger.nameCall.enabled = false;
  try {
    assert.equal(matchGroupChat(ev), false, 'nameCall 关闭后仅喊名（无 @）不得触发');
  } finally {
    config.behavior.trigger.nameCall.enabled = saved;
  }
});

test('组合器 replyQuote 接线：引用 bot 消息默认触发；enabled=false 时不触发', () => {
  clearBotMessageIds();
  recordBotMessageId(-1001);
  const ev = groupEvent([{ type: 'reply', data: { id: -1001 } }, { type: 'text', data: { text: ' 你说' } }]);
  assert.equal(matchGroupChat(ev), true, '默认配置下引用 bot 消息应触发');

  const saved = config.behavior.trigger.replyQuote.enabled;
  config.behavior.trigger.replyQuote.enabled = false;
  try {
    assert.equal(matchGroupChat(ev), false, 'replyQuote 关闭后引用 bot 消息不得触发');
  } finally {
    config.behavior.trigger.replyQuote.enabled = saved;
  }
});

test('组合器「任一命中」：at 关 + nameCall 开时喊名仍触发；@ 与喊名并存的消息也触发', () => {
  const savedAt = config.behavior.trigger.at.enabled;
  config.behavior.trigger.at.enabled = false;
  try {
    assert.equal(
      matchGroupChat(groupEvent([{ type: 'text', data: { text: '肥鱼救命' } }])),
      true,
      'at 关闭不得拦截 nameCall 命中（任一命中即触发，不要求全部）'
    );
    assert.equal(
      matchGroupChat(
        groupEvent([{ type: 'at', data: { qq: String(SELF_ID) } }, { type: 'text', data: { text: ' 大肥鱼在吗' } }])
      ),
      true,
      '@ 与喊名并存的单一消息同样触发'
    );
  } finally {
    config.behavior.trigger.at.enabled = savedAt;
  }
});

test('组合器「条件全关」：三开关齐关时 @ / 喊名 / 引用 bot 消息均不触发（spec 场景）', () => {
  const saved = {
    at: config.behavior.trigger.at.enabled,
    nameCall: config.behavior.trigger.nameCall.enabled,
    replyQuote: config.behavior.trigger.replyQuote.enabled,
  };
  clearBotMessageIds();
  recordBotMessageId(-1001);
  const evs = [
    groupEvent([{ type: 'at', data: { qq: String(SELF_ID) } }, { type: 'text', data: { text: ' 在吗' } }]),
    groupEvent([{ type: 'text', data: { text: '大肥鱼今天吃什么' } }]),
    groupEvent([{ type: 'reply', data: { id: -1001 } }, { type: 'text', data: { text: ' 你说' } }]),
  ];
  config.behavior.trigger.at.enabled = false;
  config.behavior.trigger.nameCall.enabled = false;
  config.behavior.trigger.replyQuote.enabled = false;
  try {
    for (const ev of evs) {
      assert.equal(matchGroupChat(ev), false, '条件全关时群聊消息不得触发');
    }
  } finally {
    config.behavior.trigger.at.enabled = saved.at;
    config.behavior.trigger.nameCall.enabled = saved.nameCall;
    config.behavior.trigger.replyQuote.enabled = saved.replyQuote;
  }
});

test('组合器边界：非群聊事件恒 false（私聊在 chat.js 顶层短路，不进组合器）', () => {
  assert.equal(
    matchGroupChat({ message_type: 'private', message: [{ type: 'at', data: { qq: String(SELF_ID) } }] }),
    false,
    '私聊事件不得经组合器触发'
  );
  assert.equal(matchGroupChat({ message_type: 'notice' }), false, '非 message 事件恒不触发');
});
