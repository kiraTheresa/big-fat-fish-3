// Task 8 验证（add-self-evolving-persona spec「离线提炼」）：shouldDistill 双条件判定
// 直测、distillSession 全流程（patch 落盘 + 审计 + 水位推进 + usage 记账 + LLM 消息
// 形状）、三类失败路径（LLM 失败 / 非 JSON / 补丁超限被拒）水位与文件不动、同会话
// 防重入、startDistiller/stopDistiller 调度冒烟（50ms 快周期）。
// 模式（同 chat.test.js）：起 mock LLM → 设 env（必须 import config 之前）→ 动态
// import；DATA_DIR/PERSONA_DIR/USAGE_DIR 注入同一 tmp 根（pid 防并行污染），after 统一
// 清理；不依赖真实 OneBot/LLM。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startLlmServer } from './llm-server.js';

const ROOT = `tmp/test-distill-${process.pid}`;
const DATA_DIR = join(ROOT, 'data');
const PERSONA_DIR = join(ROOT, 'personas');
const USAGE_DIR = join(ROOT, 'usage');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(cond, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil 超时（${timeoutMs}ms 内条件未满足）`);
    await delay(stepMs);
  }
}

// ---- 文件级装配：mock LLM → env → 动态 import ----
const llmServer = await startLlmServer();
process.env.DATA_DIR = DATA_DIR;
process.env.PERSONA_DIR = PERSONA_DIR;
process.env.USAGE_DIR = USAGE_DIR;
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.DEEPSEEK_BASE_URL = llmServer.url;
process.env.CHAT_TIMEOUT_MS = '300'; // 防重入用例 setHang 后快速超时释放
process.env.DISTILL_INTERVAL_MS = '50'; // 调度冒烟：快周期触发

const { config } = await import('../src/config.js');
const { shouldDistill, distillSession, startDistiller, stopDistiller } = await import('../src/distill/distiller.js');
const { getPersona } = await import('../src/store/persona-store.js');

after(async () => {
  stopDistiller(); // 保险：冒烟用例异常退出时也别把 interval 带出进程
  await llmServer.close();
  await rm(ROOT, { recursive: true, force: true });
});

// ---- 工具：消息构造与文件读写（sessionKey / 文件布局同各 store 约定） ----
const msgFile = (key) => join(DATA_DIR, 'messages', `${key}.jsonl`);
const personaFile = (key, name) => join(PERSONA_DIR, key, name);
const stateFile = (key) => join(DATA_DIR, 'session-state', `${key}.json`);
const usageFile = (key) => join(USAGE_DIR, `${key}.jsonl`);

// 消息行：入站带 sender.nickname，bot 行 bot:true（time 秒级，与真实落盘同量纲）
function msg(key, time, raw, { bot = false, nickname = `用户${time}`, user_id = 8001 } = {}) {
  return bot
    ? { sessionKey: key, time, bot: true, raw_message: raw, user_id: 10000 }
    : { sessionKey: key, time, raw_message: raw, user_id, sender: { nickname } };
}

async function writeMessages(key, rows) {
  await mkdir(join(DATA_DIR, 'messages'), { recursive: true });
  await writeFile(msgFile(key), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

async function readJsonl(file) {
  const text = await readFile(file, 'utf8');
  return text.split('\n').filter((l) => l !== '');
}

const enoent = (err) => err.code === 'ENOENT';

// ---- shouldDistill 纯函数直测 ----
test('shouldDistill 纯函数：批量达标 / 静默达标 / 双不满足 / 无新消息', () => {
  const conf = { distillBatchSize: 3, distillSilenceMs: 600000 };
  const mk = (n, baseTime = 1760000000) => Array.from({ length: n }, (_, i) => ({ time: baseTime + i }));

  assert.equal(shouldDistill([], {}, Date.now(), conf), false, '无新消息：恒不触发');

  const batch = mk(3);
  assert.equal(
    shouldDistill(batch, {}, batch.at(-1).time * 1000, conf),
    true,
    '批量达标（3 >= 3）：即使刚说完话也触发'
  );

  const few = mk(2);
  const lastMs = few.at(-1).time * 1000;
  assert.equal(shouldDistill(few, {}, lastMs + conf.distillSilenceMs, conf), true, '静默达标（now - 末条 ≥ silenceMs）：触发');
  assert.equal(shouldDistill(few, {}, lastMs + conf.distillSilenceMs - 1, conf), false, '静默差 1ms：不触发');
  assert.equal(shouldDistill(few, {}, lastMs + 1000, conf), false, '批量与静默双不满足：不触发');
});

// ---- distillSession 全流程 ----
test('distillSession 全流程：patch 落盘 + 审计 + 水位推进 + usage 记账 + LLM 消息形状', async () => {
  const key = 'g-d100';
  const rows = [
    msg(key, 1760000100, '你们这群鱼真笨', { nickname: '阿甲' }),
    msg(key, 1760000101, '咕噜不许这么说大家啦', { bot: true }),
    msg(key, 1760000102, '今晚吃火锅吗', { nickname: '阿乙' }),
  ];
  await writeMessages(key, rows);

  const patch = {
    character: '# 大肥鱼\n\n演化后的性格：更爱火锅了。',
    memory: '- [2026-10-25 10:00] 阿乙: 今晚吃火锅吗',
  };
  // 回复带 ```json 围栏：顺带验证 strip 围栏后仍可解析
  llmServer.setReply('```json\n' + JSON.stringify(patch) + '\n```', {
    prompt_tokens: 501,
    completion_tokens: 602,
    total_tokens: 1103,
    prompt_cache_hit_tokens: 704,
  });

  await distillSession(key, rows);

  // persona 文件更新为 patch 内容
  assert.equal(await readFile(personaFile(key, 'character.md'), 'utf8'), patch.character, 'character.md 应为 patch 内容');
  assert.equal(await readFile(personaFile(key, 'memory.md'), 'utf8'), patch.memory, 'memory.md 应为 patch 内容');

  // 审计：history.jsonl 含 persona-patch 行
  const hist = await readJsonl(personaFile(key, 'history.jsonl'));
  assert.ok(hist.some((l) => JSON.parse(l).kind === 'persona-patch'), '审计应含 persona-patch');

  // 水位：distillMark = 本批最大 time（秒级）
  const state = JSON.parse(await readFile(stateFile(key), 'utf8'));
  assert.equal(state.distillMark, 1760000102, '水位应推进到本批最大 time');

  // usage：kind 'distill' 行、token 字段对应（fire-and-forget，等落盘）
  await waitUntil(async () => {
    try {
      return (await readJsonl(usageFile(key))).length >= 1;
    } catch {
      return false;
    }
  });
  const usageRec = JSON.parse((await readJsonl(usageFile(key)))[0]);
  assert.equal(usageRec.kind, 'distill');
  assert.equal(usageRec.model, config.deepseekModel);
  assert.equal(usageRec.prompt_tokens, 501);
  assert.equal(usageRec.completion_tokens, 602);
  assert.equal(usageRec.total_tokens, 1103);
  assert.equal(usageRec.prompt_cache_hit_tokens, 704);
  assert.ok(Number.isFinite(usageRec.time), 'time 应为毫秒时间戳');

  // LLM 消息形状：system 固定模板（规则要点 + personaMaxBytes）；user 含现有两份文件
  // 与对话行（`[time] 昵称: 内容`，bot 行昵称「大肥鱼」）
  const req = llmServer.requests.at(-1);
  assert.equal(req.body.messages.length, 2);
  const [sys, user] = req.body.messages;
  assert.equal(sys.role, 'system');
  assert.ok(sys.content.includes('人设文件的维护者'), 'system 应含角色定位');
  assert.ok(sys.content.includes('不许推翻'), 'system 应含核心设定不推翻规则');
  assert.ok(sys.content.includes(String(config.personaMaxBytes)), 'system 应含字节上限');
  assert.equal(user.role, 'user');
  assert.ok(user.content.includes('# 大肥鱼'), 'user 应含现有 character 底稿（种子）');
  assert.ok(user.content.includes('[1760000100] 阿甲: 你们这群鱼真笨'), '入站行格式：[time] 昵称: 内容');
  assert.ok(user.content.includes('[1760000101] 大肥鱼: 咕噜不许这么说大家啦'), 'bot 行昵称标「大肥鱼」');
  assert.ok(user.content.includes('[1760000102] 阿乙: 今晚吃火锅吗'));
});

// ---- 失败路径一：LLM HTTP 500 ----
test('失败路径一：LLM 失败 → persona 保持种子、水位不置、无 usage 行', async () => {
  const key = 'g-d200';
  const rows = [msg(key, 1760000200, '会失败的一次', { nickname: '阿丙' })];
  await writeMessages(key, rows);

  llmServer.setFail();
  try {
    await distillSession(key, rows); // 内部 catch → WARN，不抛出
  } finally {
    llmServer.setReply('MOCK_LLM_REPLY');
  }

  const persona = await getPersona(key); // distill 内 getPersona 已落种子
  assert.ok(persona.character.startsWith('# 大肥鱼'), '失败后 character 保持种子');
  await assert.rejects(() => readFile(stateFile(key)), enoent, '失败不得推进水位');
  await assert.rejects(() => readFile(usageFile(key)), enoent, '失败不得记 usage');
});

// ---- 失败路径二：LLM 返回纯文本（非 JSON） ----
test('失败路径二：LLM 返回非 JSON 纯文本 → 同样全不动', async () => {
  const key = 'g-d300';
  const rows = [msg(key, 1760000300, '非 JSON 输出', { nickname: '阿丁' })];
  await writeMessages(key, rows);

  llmServer.setReply('好的');
  await distillSession(key, rows);

  const persona = await getPersona(key);
  assert.ok(persona.character.startsWith('# 大肥鱼'), '非 JSON 后 character 保持种子');
  await assert.rejects(() => readFile(stateFile(key)), enoent, '非 JSON 不得推进水位');
  await assert.rejects(() => readFile(usageFile(key)), enoent, '非 JSON 不得记 usage');
});

// ---- 失败路径三：补丁超 personaMaxBytes 被拒 ----
test('失败路径三：character 超 personaMaxBytes → applyPersonaPatch 拒绝 → 不更新水位', async () => {
  const key = 'g-d400';
  const rows = [msg(key, 1760000400, '超限的一次', { nickname: '阿戊' })];
  await writeMessages(key, rows);

  const savedMax = config.personaMaxBytes;
  config.personaMaxBytes = 200; // 临时调小（沿袭 chat.test.js 的 config 变更法），用毕恢复
  const bigPatch = { character: '# 大肥鱼\n\n' + '很长的性格描述。'.repeat(50), memory: '' };
  assert.ok(Buffer.byteLength(bigPatch.character, 'utf8') > 200, '前置：补丁确实超限');
  llmServer.setReply(JSON.stringify(bigPatch));
  try {
    await distillSession(key, rows);

    const persona = await getPersona(key);
    assert.ok(
      persona.character.startsWith('# 大肥鱼') && !persona.character.includes('很长的性格描述'),
      '超限补丁不得落盘（character 保持种子）'
    );
    await assert.rejects(() => readFile(stateFile(key)), enoent, '被拒不推进水位');
    // 被拒不记 persona-patch 审计（applyPatchOne 拒绝路径不落任何文件——审计文件
    // 本身不存在是更直接的证据，容忍 ENOENT）
    let histLines = [];
    try {
      histLines = await readJsonl(personaFile(key, 'history.jsonl'));
    } catch {
      // 无审计文件：从未有过成功的 persona 写操作
    }
    assert.ok(!histLines.some((l) => JSON.parse(l).kind === 'persona-patch'), '被拒不记 persona-patch 审计');
  } finally {
    config.personaMaxBytes = savedMax;
    llmServer.setReply('MOCK_LLM_REPLY');
  }
});

// ---- 防重入：同会话并发第二次调用直接跳过 ----
test('防重入：同会话提炼在途时第二次 distillSession 跳过（不重复调 LLM）', async () => {
  const key = 'g-d500';
  const rows = [msg(key, 1760000500, '挂起期间再来一次', { nickname: '阿己' })];
  await writeMessages(key, rows);

  llmServer.setHang(); // 第一次调用挂起（CHAT_TIMEOUT_MS=300 后超时失败）
  try {
    const before = llmServer.requests.length;
    const first = distillSession(key, rows); // 不 await：让它在后台挂起
    // 等 first 的 LLM 请求发出（hang 模式同样记录请求），此后 runningSet 持有该会话
    await waitUntil(() => llmServer.requests.length === before + 1, { timeoutMs: 2000 });
    await distillSession(key, rows); // 第二次同会话：立即被 runningSet 拦下
    await delay(150);
    assert.equal(llmServer.requests.length, before + 1, '第二次调用不得再调 LLM');
    await first; // 等第一次超时失败落定（catch → WARN → finally 释放）
    await assert.rejects(() => readFile(stateFile(key)), enoent, '挂起失败后水位不动');
  } finally {
    llmServer.setReply('MOCK_LLM_REPLY');
  }
});

// ---- startDistiller / stopDistiller 调度冒烟 ----
test('startDistiller/stopDistiller 冒烟：50ms 周期能触发 scanOnce；stop 后不再执行；重复 start 防重', async () => {
  const key = 'g-d600';
  // 隔离：清掉前面用例留下的会话文件——失败路径用例的水位未推进，scanOnce 会对它们
  // 反复重试（设计的重试语义），冒烟只观察本用例的 g-d600
  await rm(join(DATA_DIR, 'messages'), { recursive: true, force: true });
  // 满足静默条件：末条消息在一小时前（默认 distillSilenceMs=600000 远超）
  const oldTime = Math.floor(Date.now() / 1000) - 3600;
  const rows = [msg(key, oldTime, '等调度器来提炼', { nickname: '阿庚' })];
  await writeMessages(key, rows);

  const patch = { character: '# 大肥鱼\n\n调度器提炼的版本。', memory: '' };
  llmServer.setReply(JSON.stringify(patch));

  const reqBefore = llmServer.requests.length;
  startDistiller();
  startDistiller(); // 重复 start：防重，不得产生第二个 interval

  // 2-3 个周期（50ms × 3）内应完成一次提炼并推进水位
  await waitUntil(async () => {
    try {
      return (JSON.parse(await readFile(stateFile(key), 'utf8'))).distillMark === oldTime;
    } catch {
      return false;
    }
  }, { timeoutMs: 3000 });
  // 水位推进后再等 3 个周期：不得重复提炼（水位后无新增 → shouldDistill false）
  await delay(150);
  assert.equal(llmServer.requests.length, reqBefore + 1, '恰触发一次 LLM 调用，无重复提炼');

  stopDistiller();

  // stop 后不再执行：追加满足条件的新消息（time 更大且静默），等 5 个周期无新调用、水位不动
  const newRows = [...rows, msg(key, oldTime + 10, 'stop 之后的新话', { nickname: '阿辛' })];
  await writeMessages(key, newRows);
  const reqAfterStop = llmServer.requests.length;
  await delay(250);
  assert.equal(llmServer.requests.length, reqAfterStop, 'stop 后不得再调 LLM');
  assert.equal(
    (JSON.parse(await readFile(stateFile(key), 'utf8'))).distillMark,
    oldTime,
    'stop 后水位不再推进'
  );
});
