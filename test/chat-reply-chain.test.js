// upgrade-chat-pipeline Task 3/4/9 验证：出口加工链——delay 模块三件套（pickDelayMs
// 纯函数区间/兜底、enabled 开关、run 透传 segments）+ split 模块（splitSegments 拆分/
// trim/滤空/全空回退、enabled 开关、run 按 config separator 拆分、置于 delay 之后）+
// quote 模块（群聊首条变消息段数组、私聊/关闭/边界透传、置于 split 之后）。
// 端到端链路（延迟出站、|| 分段连发逐条发送、引用首帧段数组、关闭透传）另见 chat.test.js。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CONFIG_PATH 指向不存在路径：加工链测试跑在全默认开关上，不受本机 config.json 干扰
const tmp = mkdtempSync(join(tmpdir(), 'bff-chat-chain-'));
process.env.CONFIG_PATH = join(tmp, 'absent.json');

const { chatReplyChain, pickDelayMs, splitSegments } = await import('../src/triggers/chat-reply-chain.js');
const { config } = await import('../src/config.js');

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const delayModule = chatReplyChain.find((m) => m.name === 'delay');
const splitModule = chatReplyChain.find((m) => m.name === 'split');
const quoteModule = chatReplyChain.find((m) => m.name === 'quote');

test('加工链结构：delay → split → quote，契约 { name, enabled(config), run }', () => {
  // spec 处理顺序：delay 先酝酿整条回复、split 再拆段（分段间发送节奏归 sender 1s 节流）、
  // quote 最后挂引用（挂的必须是拆分后真正出站的第一帧，挂早了引用会错挂到原始全文上）
  assert.deepEqual(chatReplyChain.map((m) => m.name), ['delay', 'split', 'quote']);
  for (const mod of chatReplyChain) {
    assert.equal(typeof mod.enabled, 'function');
    assert.equal(typeof mod.run, 'function');
  }
});

test('pickDelayMs 闭区间含端点：假随机源 0→min、趋近 1→max、0.5→中值', () => {
  assert.equal(pickDelayMs(2000, 8000, () => 0), 2000, 'random()=0 应取下端点');
  assert.equal(pickDelayMs(2000, 8000, () => 0.999999999), 8000, 'random()→1 应达上端点（含）');
  assert.equal(pickDelayMs(2000, 8000, () => 0.5), 5000, 'random()=0.5 应取中值');
  // 单点区间退化为定值（min===max 时恒 min）
  assert.equal(pickDelayMs(3000, 3000, () => 0.7), 3000);
});

test('pickDelayMs 真随机源采样：默认区间 2000–8000 内 200 次取样全部落界内', () => {
  for (let i = 0; i < 200; i++) {
    const v = pickDelayMs(2000, 8000);
    assert.ok(v >= 2000 && v <= 8000, `取值 ${v} 越界 [2000, 8000]`);
    assert.ok(Number.isInteger(v), '取值应为整数毫秒');
  }
});

test('pickDelayMs min>max 兜底：区间写反时取 min，不受随机源影响', () => {
  assert.equal(pickDelayMs(8000, 2000), 8000, 'min>max 应取 min 兜底');
  assert.equal(pickDelayMs(8000, 2000, () => 0), 8000);
  assert.equal(pickDelayMs(8000, 2000, () => 0.99), 8000);
});

test('enabled(config)：读传入 config 实参的 behavior.reply.delay.enabled（契约面）', () => {
  // 直接传桩 config：验证 enabled 读的是形参而非闭包全局（后续 split/quote 模块同契约）
  assert.equal(delayModule.enabled({ behavior: { reply: { delay: { enabled: true } } } }), true);
  assert.equal(delayModule.enabled({ behavior: { reply: { delay: { enabled: false } } } }), false);
  // 对全局默认配置：延迟默认开启
  assert.equal(delayModule.enabled(config), true);
});

test('run：sleep 区间后原样透传 segments（延迟不改内容，分段节奏归 sender 节流）', async () => {
  const saved = { ...config.behavior.reply.delay };
  Object.assign(config.behavior.reply.delay, { minMs: 5, maxMs: 10 }); // 收窄区间保套件速度
  try {
    const t0 = Date.now();
    const out = await delayModule.run({}, ['甲段', '乙段']);
    const elapsed = Date.now() - t0;
    assert.deepEqual(out, ['甲段', '乙段'], 'segments 应原样透传');
    assert.ok(elapsed >= 5, `应至少 sleep minMs=5ms（实际 ${elapsed}ms）`);
    assert.ok(elapsed < 500, `sleep 不应远超区间（实际 ${elapsed}ms）`);
  } finally {
    Object.assign(config.behavior.reply.delay, saved);
  }
});

test('run：min>max 取 min 兜底（配置写反不炸、不睡出错误时长）', async () => {
  const saved = { ...config.behavior.reply.delay };
  Object.assign(config.behavior.reply.delay, { minMs: 30, maxMs: 5 }); // 写反
  try {
    const t0 = Date.now();
    await delayModule.run({}, ['x']);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 30, `min>max 应按 minMs=30 兜底（实际 ${elapsed}ms）`);
    assert.ok(elapsed < 1000, `兜底不应睡出异常长（实际 ${elapsed}ms）`);
  } finally {
    Object.assign(config.behavior.reply.delay, saved);
  }
});

// ---- Task 4：split 模块 ----

test('splitSegments：每条按 separator 拆分 → trim → 滤空 → flat', () => {
  assert.deepEqual(splitSegments(['今天好冷||想吃火锅了咕噜'], '||'), ['今天好冷', '想吃火锅了咕噜']);
  // 多条 segments 各自拆分后扁平化；边界空白与空段被 trim+滤空清理
  assert.deepEqual(splitSegments([' 甲 ||  乙 ||', '丙||丁'], '||'), ['甲', '乙', '丙', '丁']);
  // 无分隔符的段原样保留（trim 仍生效：分段是「可选连发」，不是必拆）
  assert.deepEqual(splitSegments(['没有分隔符', ' 正常段 '], '||'), ['没有分隔符', '正常段']);
});

test('splitSegments：拆分结果全空时回退原 segments（LLM 全吐分隔符的容错，不吞回复）', () => {
  assert.deepEqual(splitSegments(['||||'], '||'), ['||||']);
  assert.deepEqual(splitSegments([' || ', '||'], '||'), [' || ', '||']);
  assert.deepEqual(splitSegments([], '||'), []); // 空 segments 无内容可回退，原样透传
});

test('splitSegments：separator 为空串直接透传（split("") 单字符拆分属配置事故，兜底）', () => {
  assert.deepEqual(splitSegments(['a||b', 'c'], ''), ['a||b', 'c']);
});

test('split.enabled(config)：读传入 config 实参的 behavior.reply.split.enabled（契约面）', () => {
  // 直接传桩 config：验证 enabled 读的是形参而非闭包全局（quote 模块同契约）
  assert.equal(splitModule.enabled({ behavior: { reply: { split: { enabled: true } } } }), true);
  assert.equal(splitModule.enabled({ behavior: { reply: { split: { enabled: false } } } }), false);
  // 对全局默认配置：分段默认开启
  assert.equal(splitModule.enabled(config), true);
});

test('split.run：按全局 config 的 separator（默认 ||）拆分，纯内容加工不引入 sleep', async () => {
  const t0 = Date.now();
  const out = await splitModule.run({}, ['今天好冷||想吃火锅了咕噜']);
  assert.deepEqual(out, ['今天好冷', '想吃火锅了咕噜']);
  assert.ok(Date.now() - t0 < 100, 'split 是纯内容加工，不应引入异步等待');
});

// ---- Task 9：quote 模块 ----

test('quote.enabled(config)：读传入 config 实参的 behavior.reply.quote.enabled（契约面）', () => {
  // 直接传桩 config：验证 enabled 读的是形参而非闭包全局（与 delay/split 同契约）
  assert.equal(quoteModule.enabled({ behavior: { reply: { quote: { enabled: true } } } }), true);
  assert.equal(quoteModule.enabled({ behavior: { reply: { quote: { enabled: false } } } }), false);
  // 对全局默认配置：引用默认开启（config.js DEFAULT_BEHAVIOR）
  assert.equal(quoteModule.enabled(config), true);
});

test('quote.run 群聊：首条替换为 [reply 段（id=触发 message_id 字符串化）, text 段（原文）]，其后纯文本不动', async () => {
  const ctx = { event: { message_type: 'group', message_id: -456049 } };
  const out = await quoteModule.run(ctx, ['第一段', '第二段', '第三段']);
  // napcat-protocol §3.4 消息段数组形状：reply 段在前、text 段随后
  assert.deepEqual(out[0], [
    { type: 'reply', data: { id: '-456049' } },
    { type: 'text', data: { text: '第一段' } },
  ], '首条应为 reply+text 段数组（id 字符串化，text 保留原文）');
  assert.deepEqual(out.slice(1), ['第二段', '第三段'], '第二条起保持纯文本（引用只挂首帧）');
  // message_id 数字型同样字符串化（协议示例 id 为字符串，两型入参归一）
  const out2 = await quoteModule.run({ event: { message_type: 'group', message_id: 456050 } }, ['甲']);
  assert.deepEqual(out2[0][0], { type: 'reply', data: { id: '456050' } });
});

test('quote.run 私聊：原样透传（一对一没有引用谁的问题，spec 明文私聊不附加）', async () => {
  const out = await quoteModule.run({ event: { message_type: 'private', message_id: -1 } }, ['私聊回复', '第二条']);
  assert.deepEqual(out, ['私聊回复', '第二条']);
});

test('quote.run 防御：空 segments / message_id 缺失 / 首条非 string → 原样透传', async () => {
  const groupCtx = (event) => ({ event });
  // 空 segments：无首条可挂（正常不会空——split 有全空回退）
  assert.deepEqual(await quoteModule.run(groupCtx({ message_type: 'group', message_id: 1 }), []), []);
  // message_id 缺失（undefined）与 null：异常事件无从构造引用，内容优先直发
  assert.deepEqual(await quoteModule.run(groupCtx({ message_type: 'group' }), ['回复']), ['回复']);
  assert.deepEqual(await quoteModule.run(groupCtx({ message_type: 'group', message_id: null }), ['回复']), ['回复']);
  // 首条非 string（理论不会发生——上游 delay/split 产物恒 string）：原对象透传不加工
  const weird = [{ type: 'text', data: { text: '已是段数组' } }, 'b'];
  assert.equal(await quoteModule.run(groupCtx({ message_type: 'group', message_id: 1 }), weird), weird);
});

test('quote.run：纯内容加工不引入 sleep（节奏归 delay 模块与 sender 节流）', async () => {
  const t0 = Date.now();
  await quoteModule.run({ event: { message_type: 'group', message_id: 1 } }, ['a', 'b']);
  assert.ok(Date.now() - t0 < 100, 'quote 不应引入异步等待');
});
