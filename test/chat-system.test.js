// upgrade-chat-pipeline Task 5/10 验证：system 组装纯函数——formatLocalTime 固定形状、
// describeSilence 档位边界（59s/1min/59min/60min/23h/24h/跨天/新对话）、buildSceneTail
// 三行场景、buildSystemPrompt 固定前缀结构（character → 记忆 → 行为规则（群/私二选一）
// → 身份与消息格式）逐字节稳定（缓存前缀稳定）+ 动态尾部后置 + 群/私双套规则分流。
// chat-system.js 零依赖（不 import config/存储），无需 mock 装配，纯函数直测。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatLocalTime, describeSilence, buildSceneTail, buildSystemPrompt } = await import(
  '../src/triggers/chat-system.js'
);

test('formatLocalTime：本地时间 → YYYY-MM-DD HH:mm（周X），补零与星期正确', () => {
  // 用本地时区构造 Date（new Date(年,月,日,时,分) 按运行时区解释），期望串与构造参数
  // 逐字对应——测试不绑定任何特定时区；本地日历日期固定则星期固定（日期→星期全局一致）
  const ms = new Date(2026, 9, 25, 12, 30, 0).getTime();
  assert.equal(formatLocalTime(ms), '2026-10-25 12:30（周日）');
  const newYear = new Date(2026, 0, 1, 0, 5, 0).getTime();
  assert.equal(formatLocalTime(newYear), '2026-01-01 00:05（周四）');
  // 月/日/时/分个位数补零
  const single = new Date(2026, 2, 8, 9, 7, 0).getTime();
  assert.equal(formatLocalTime(single), '2026-03-08 09:07（周日）');
});

test('describeSilence 档位边界：新对话/59s/1min/59min/60min/23h/24h/跨天', () => {
  const NOW_MS = 2_000_000_000_000;
  const nowSec = Math.floor(NOW_MS / 1000);
  assert.equal(describeSilence(null, NOW_MS), '这是新对话的开始');
  assert.equal(describeSilence(nowSec - 59, NOW_MS), '刚刚还在聊');
  assert.equal(describeSilence(nowSec - 60, NOW_MS), '距上一条消息约 1 分钟');
  assert.equal(describeSilence(nowSec - 3540, NOW_MS), '距上一条消息约 59 分钟');
  assert.equal(describeSilence(nowSec - 3600, NOW_MS), '距上一条消息约 1 小时');
  assert.equal(describeSilence(nowSec - 82800, NOW_MS), '距上一条消息约 23 小时');
  assert.equal(describeSilence(nowSec - 86400, NOW_MS), '距上一条消息约 1 天');
  assert.equal(describeSilence(nowSec - 3 * 86400, NOW_MS), '距上一条消息约 3 天');
  // 毫秒尾数不改变档位：nowMs 的 <1s 部分被统一到秒量纲后再比较
  assert.equal(describeSilence(nowSec - 59, NOW_MS + 999), '刚刚还在聊');
});

test('buildSceneTail：标题 + 时间/场景/静默三行；群聊私聊与新对话分支', () => {
  const nowMs = new Date(2026, 9, 25, 12, 30, 0).getTime();
  const tail = buildSceneTail({
    isGroup: true,
    nowMs,
    lastTimeSec: Math.floor(nowMs / 1000) - 7200,
  });
  assert.ok(tail.startsWith('## 当前场景'), '尾部以场景标题开头');
  assert.ok(tail.includes('- 当前时间：2026-10-25 12:30（周日）'));
  assert.ok(tail.includes('- 场景：群聊'));
  assert.ok(tail.includes('- 静默时长：距上一条消息约 2 小时'), 'spec「尾部注入」场景文案');

  const fresh = buildSceneTail({ isGroup: false, nowMs, lastTimeSec: null });
  assert.ok(fresh.includes('- 场景：私聊'));
  assert.ok(fresh.includes('- 静默时长：这是新对话的开始'));
});

test('buildSystemPrompt 前缀结构：character → ## 记忆 → memory → ## 行为规则（场景化）→ ## 身份与消息格式 → ## 当前场景', () => {
  const persona = { character: '# 大肥鱼', memory: '- 某条记忆' };
  const scene = { isGroup: false, nowMs: 0, lastTimeSec: null };
  const s = buildSystemPrompt(persona, scene);
  // 私聊版前缀应逐字节拼接（spec MODIFIED 明文顺序；行为规则为私聊三条、身份段两行）
  assert.ok(
    s.startsWith(
      '# 大肥鱼\n\n## 记忆\n\n- 某条记忆\n\n## 行为规则\n\n' +
        '- 用简短口语化的中文回复，不要使用 Markdown 格式\n' +
        '- 一对一私聊，可以聊得更展开、多接几句\n' +
        '- 想连发几条短消息时用换行分隔（每行会作为一条独立消息发出），也可以用 ||；不需要拆就输出一条\n\n' +
        '## 身份与消息格式\n\n' +
        '- 你是群里的吉祥物大肥鱼，自称「本鱼」\n' +
        '- 群聊历史消息里「昵称: 」开头的前缀是群友的名字，不是消息内容的一部分；私聊没有这个前缀'
    ),
    '固定前缀应按 spec MODIFIED 顺序逐字节拼接各固定段'
  );
  // 身份段之后紧跟动态尾部（前缀到身份段为止，动态内容全部后置）
  assert.ok(s.includes('\n\n## 当前场景\n\n- 当前时间：'), '身份段之后应以空行衔接动态尾部');
  // 空记忆保留「## 记忆」标题与空行——结构稳定 > 内容紧凑（缓存友好，旧断言语义延续）
  const empty = buildSystemPrompt({ character: '# 鱼', memory: '' }, scene);
  assert.equal(empty.split('## 记忆')[1].split('## 行为规则')[0], '\n\n\n\n');
});

test('buildSystemPrompt：同参数两次组装结果完全一致（确定性）', () => {
  const persona = { character: '你是测试鱼', memory: '- m' };
  const scene = { isGroup: true, nowMs: 123, lastTimeSec: 100 };
  assert.equal(buildSystemPrompt(persona, scene), buildSystemPrompt(persona, scene));
});

test('群/私双套行为规则（Task 10）：规则段随 isGroup 二选一，各含 || 分段约定与底线两条', () => {
  const persona = { character: '# 大肥鱼', memory: '- m' };
  const group = buildSystemPrompt(persona, { isGroup: true, nowMs: 0, lastTimeSec: null });
  const private_ = buildSystemPrompt(persona, { isGroup: false, nowMs: 0, lastTimeSec: null });

  // 规则段 = 「## 行为规则」到「## 身份与消息格式」之间（分段锚定提取，避免全文误匹配）
  const rulesOf = (s) => s.split('## 行为规则')[1].split('## 身份与消息格式')[0];
  const g = rulesOf(group);
  const p = rulesOf(private_);
  assert.notEqual(g, p, '群/私规则段应不同（spec「场景分流」）');
  assert.ok(g.includes('不刷屏'), '群聊版应含克制不刷屏约束');
  assert.ok(p.includes('聊得更展开'), '私聊版应含可展开多聊约束');
  // 分流不串台：群聊版不得含私聊姿态文案，反之亦然
  assert.ok(!g.includes('聊得更展开'), '群聊版不得混入私聊展开文案');
  assert.ok(!p.includes('不刷屏'), '私聊版不得混入群聊刷屏文案');
  // 底线规则两套共有（保留 Task 3 既有两条语义）：简短口语化 + 无 Markdown + 分段约定
  for (const rules of [g, p]) {
    assert.ok(rules.includes('简短口语化'), '两套均保留简短口语化底线');
    assert.ok(rules.includes('不要使用 Markdown'), '两套均保留无 Markdown 底线');
    assert.ok(rules.includes('换行分隔'), '两套均含换行分段约定（0.9.3：换行为首选写法）');
    assert.ok(rules.includes('||'), '两套均保留 || 备选写法');
  }
});

test('身份与消息格式段（Task 10）：大肥鱼身份锚定 + 群聊昵称前缀说明，群/私同文（固定段）', () => {
  const persona = { character: '# 大肥鱼', memory: '' };
  for (const isGroup of [true, false]) {
    const s = buildSystemPrompt(persona, { isGroup, nowMs: 0, lastTimeSec: null });
    const identity = s.split('## 身份与消息格式')[1].split('## 当前场景')[0];
    assert.ok(identity.includes('大肥鱼'), '身份段应含大肥鱼身份锚定');
    assert.ok(identity.includes('昵称: '), '身份段应说明「昵称: 」前缀');
    assert.ok(identity.includes('不是消息内容的一部分'), '身份段应讲清前缀不是消息内容');
    assert.ok(identity.includes('私聊没有这个前缀'), '身份段应说明私聊无前缀');
  }
});

test('buildSystemPrompt 缓存前缀稳定（Task 10）：isGroup 恒定的会话内时间/静默变化不影响固定前缀', () => {
  const persona = { character: '# 大肥鱼\n呆萌心大', memory: '- 记一条' };
  // 群/私各自验证：同一会话 isGroup 恒定，只有时间/静默（动态尾部内容）在变
  for (const isGroup of [true, false]) {
    const sceneA = { isGroup, nowMs: new Date(2026, 9, 25, 8, 0, 0).getTime(), lastTimeSec: null };
    const sceneB = {
      isGroup,
      nowMs: new Date(2026, 9, 26, 9, 30, 0).getTime(),
      lastTimeSec: Math.floor(sceneA.nowMs / 1000) - 7200,
    };
    const sA = buildSystemPrompt(persona, sceneA);
    const sB = buildSystemPrompt(persona, sceneB);
    const tailA = buildSceneTail(sceneA);
    const tailB = buildSceneTail(sceneB);
    // 各自以自己的动态尾部收尾（尾部在最尾，动态内容不侵入前缀）
    assert.ok(sA.endsWith(tailA));
    assert.ok(sB.endsWith(tailB));
    // 全长减尾长 = 固定前缀（含衔接空行）：同 isGroup 下应逐字节一致
    assert.equal(
      sA.slice(0, sA.length - tailA.length),
      sB.slice(0, sB.length - tailB.length),
      `isGroup=${isGroup} 的会话内固定前缀应逐字节一致（缓存命中前提）`
    );
  }
  // 群/私之间前缀确实不同（规则段分流）——缓存按会话生效，跨场景前缀差异是预期行为
  const g = buildSystemPrompt(persona, { isGroup: true, nowMs: 1, lastTimeSec: null });
  const p = buildSystemPrompt(persona, { isGroup: false, nowMs: 1, lastTimeSec: null });
  assert.notEqual(
    g.slice(0, g.indexOf('## 当前场景')),
    p.slice(0, p.indexOf('## 当前场景')),
    '群/私前缀应因规则段分流而不同'
  );
});
