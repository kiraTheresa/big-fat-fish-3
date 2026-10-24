// 离线提炼调度器（add-self-evolving-persona spec「离线提炼」）：周期扫描 data/messages
// 下的会话，双条件判定（静默：末条消息距今 ≥ distillSilenceMs；批量：水位后新增 ≥
// distillBatchSize；先到先触发）；触发则以固定模板调 LLM 产出人设补丁
// { character, memory }，成功后 applyPersonaPatch（含审计）+ 推进 distillMark 水位 +
// 旁路记 usage（kind: 'distill'，fire-and-forget）。任何失败（LLM 超时/网络/非 JSON/
// 补丁超限被拒）仅 WARN 跳过、水位与文件不动（下轮扫描重试）；提炼中的会话进程内
// 防重入（runningSet）。量纲约定：消息 JSONL 的 time 是秒级，与 distillSilenceMs
// （毫秒）比较需 ×1000，distillMark 水位存秒级（与消息 time 同量纲）。
// 由 index.js 在 config.deepseekApiKey !== '' 时启动，进程退出时清理。
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { chatCompletion } from '../llm.js';
import { readMessagesSince } from '../store/message-store.js';
import { applyPersonaPatch, getPersona } from '../store/persona-store.js';
import { readState, updateState } from '../store/session-state.js';
import { appendUsage } from '../store/usage-store.js';

// 提炼 system 模板（spec 设计决策：增量演化不推翻核心设定、memory 去粗取精、输出纯
// JSON、各自上限内）。{maxBytes} 占位符在调用时以 config.personaMaxBytes 替换——调用
// 时读取而非模块加载时固化，保证测试注入生效。
const DISTILL_SYSTEM_TEMPLATE = [
  '你是 QQ 机器人人设文件的维护者。规则：',
  '① character.md 在现有基础上增量演化——说话习惯、口头禅、梗、态度可以生长，但核心设定（呆萌大肥鱼、真诚、吉祥物定位）不许推翻；',
  '② memory.md 是事实记忆——保留仍然有效的，删除过时错误项，合并重复；',
  '③ 每个文件不超过 {maxBytes} 字节；',
  '④ 只输出 JSON，不要 markdown 围栏，格式 {"character": "完整文件内容", "memory": "完整文件内容"}',
].join('\n');

// 待消化对话里 bot 行的统一昵称（入站行用 sender.nickname ?? user_id，同 chat.js 约定）
const BOT_SPEAKER = '大肥鱼';

// 提炼中的会话集合（进程内防重入）：scanOnce 周期重叠或与其他异步流并发撞同一会话时，
// 后到者直接跳过，避免同一批对话触发两次 LLM 调用与两次 patch 写入。
const runningSet = new Set();

// 调度器 interval 句柄（null = 未启动；重复 start 忽略）
let timer = null;

// 消息行 → 对话行 `[{time}] 昵称: 内容`（bot 行昵称固定「大肥鱼」）
function speakerOf(rec) {
  return rec.bot ? BOT_SPEAKER : rec.sender?.nickname ?? rec.user_id;
}

// 组装提炼 LLM messages：system 固定模板 + user（现有两份文件全文 + 待消化对话逐行）
function buildMessages(persona, newMessages) {
  const dialogue = newMessages.map((rec) => `[${rec.time}] ${speakerOf(rec)}: ${rec.raw_message}`);
  const user = [
    '现有 character.md：',
    persona.character,
    '',
    '现有 memory.md：',
    persona.memory,
    '',
    '待消化对话：',
    ...dialogue,
  ].join('\n');
  return [
    {
      role: 'system',
      content: DISTILL_SYSTEM_TEMPLATE.replaceAll('{maxBytes}', String(config.personaMaxBytes)),
    },
    { role: 'user', content: user },
  ];
}

// 解析 LLM 输出为人设补丁：strip 可能的 ```json 围栏 → JSON.parse → 形状校验
// （对象且 character/memory 均为 string）。任何一步不符返回 null（调用方 WARN 跳过）。
function parsePatch(content) {
  let parsed;
  try {
    const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.character !== 'string' || typeof parsed.memory !== 'string') return null;
  return { character: parsed.character, memory: parsed.memory };
}

// ---- 双条件判定（纯函数，供直测）：水位后有新增 且（批量达标 或 会话静默足够久）----
// newMessages 已由调用方按 state.distillMark 水位筛出（state 仅为签名完整性保留）；
// 量纲：消息 time 秒级，与毫秒 nowMs 比较需 ×1000。
export function shouldDistill(newMessages, state, nowMs, conf) {
  if (newMessages.length === 0) return false;
  if (newMessages.length >= conf.distillBatchSize) return true;
  return nowMs - newMessages.at(-1).time * 1000 >= conf.distillSilenceMs;
}

// ---- 单会话提炼：读底稿 → 固定模板调 LLM → 校验补丁 → patch + 水位 + usage ----
export async function distillSession(sessionKey, newMessages) {
  if (runningSet.has(sessionKey)) return; // 防重入：同会话提炼在途，本轮跳过
  runningSet.add(sessionKey);
  try {
    // 现有人设（首访自动落种子）：本次演化的底稿
    const persona = await getPersona(sessionKey);
    const { content, usage } = await chatCompletion(buildMessages(persona, newMessages));

    const patch = parsePatch(content);
    if (patch === null) {
      logger.warn(`[distill] 会话 ${sessionKey} 提炼输出非合法 JSON 补丁，跳过（水位不动）`);
      return;
    }

    const ok = await applyPersonaPatch(sessionKey, patch);
    if (!ok) {
      // 超限被拒等（applyPersonaPatch 内部已 WARN）：不推进水位，下轮重试
      logger.warn(`[distill] 会话 ${sessionKey} 人设补丁未落盘（超限被拒），跳过（水位不动）`);
      return;
    }

    // 成功：推进水位到本批最大 time（秒级，与消息 JSONL 同量纲，严格大于不重复处理）
    const maxTime = newMessages.reduce((max, rec) => Math.max(max, rec.time ?? 0), 0);
    await updateState(sessionKey, { distillMark: maxTime });

    // 用量旁路观测（spec「用量观测」）：fire-and-forget 不 await（appendUsage 内部全
    // 捕获、失败仅 WARN）；响应缺 usage 字段（null）不记账
    if (usage !== null) {
      appendUsage(sessionKey, {
        time: Date.now(),
        kind: 'distill',
        model: config.deepseekModel,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
      });
    }
  } catch (err) {
    // 任何异常（LLM 超时/网络等）：水位与文件不动，下轮扫描重试
    logger.warn(`[distill] 会话 ${sessionKey} 提炼失败: ${err.message}`);
  } finally {
    runningSet.delete(sessionKey);
  }
}

// ---- 单轮扫描：枚举 data/messages 的 *.jsonl 得会话，顺序逐个判定与提炼 ----
export async function scanOnce() {
  let entries;
  try {
    entries = await readdir(join(config.dataDir, 'messages'));
  } catch (err) {
    if (err.code === 'ENOENT') return; // 尚无任何会话消息：无事可扫
    logger.warn(`[distill] 消息目录枚举失败: ${err.message}`);
    return;
  }
  const keys = entries.filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -'.jsonl'.length));
  // 顺序逐会话处理（for + await，不并发）：避免多会话同时提炼打爆 LLM 配额与本地 IO
  for (const sessionKey of keys) {
    const state = await readState(sessionKey);
    const newMessages = await readMessagesSince(sessionKey, state.distillMark ?? 0, 100);
    if (!shouldDistill(newMessages, state, Date.now(), config)) continue;
    await distillSession(sessionKey, newMessages);
  }
}

// ---- 启动调度器：interval 周期扫描（fire-and-forget，scanOnce/distillSession 全兜底不抛）----
export function startDistiller() {
  if (timer !== null) return; // 已启动：忽略重复 start
  timer = setInterval(() => {
    scanOnce();
  }, config.distillIntervalMs);
}

// ---- 停止调度器：清 interval（未启动时无操作）----
export function stopDistiller() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
