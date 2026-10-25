// 离线提炼调度器（add-self-evolving-persona spec「离线提炼」）：周期扫描 data/messages
// 下的会话，双条件判定（静默：末条消息距今 ≥ distillSilenceMs；批量：水位后新增 ≥
// distillBatchSize；先到先触发）；触发则以固定模板调 LLM 产出人设补丁
// { character, memory }，applyPersonaPatch 分文件落盘（character 超限单拒该文件、
// memory 超限程序化裁剪），至少一文件落盘即推进 distillMark 水位（消息已消化，
// 重试同批只会再烧一次 LLM——这是掐断「超限拒绝→60s 重试→再超限」死循环的关键：
// 水位推进优先于完美主义）+ 旁路记 usage（kind: 'distill'，fire-and-forget）。
// 全失败（LLM 异常/非 JSON/锁定校验失败/零文件落盘）仅 WARN 跳过、水位不动并计
// 失败；连续 ≥ 2 次全失败进入 1 小时退避（期内不再真调 LLM，到期自动恢复）。
// 提炼中的会话进程内防重入（runningSet）。量纲约定：消息 JSONL 的 time 是秒级，与
// distillSilenceMs（毫秒）比较需 ×1000，distillMark 水位存秒级（与消息 time 同量纲）。
// 由 index.js 在 config.deepseekApiKey !== '' 时启动，进程退出时清理。
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { chatCompletion } from '../llm.js';
import { readMessagesSince } from '../store/message-store.js';
import { applyPersonaPatch, getPersona, extractLockedLines, patchKeepsLockedLines } from '../store/persona-store.js';
import { readState, updateState } from '../store/session-state.js';
import { appendUsage } from '../store/usage-store.js';

// 锁定行判定/校验已搬家 persona-store（store 层，供 applyPersonaPatch 的 memory 兜底
// 裁剪复用同一谓词；依赖单向 distiller → store）。此处 re-export 保持 distiller 旧
// 导出路径可用——既有调用方与测试无需感知搬家。
export { extractLockedLines, patchKeepsLockedLines };

// 提炼 system 模板（spec 设计决策：增量演化不推翻核心设定、分级标准去粗取精、
// memory 条目式、输出纯 JSON、各自上限内）。{maxBytes} 占位符在调用时以
// config.personaMaxBytes 替换——调用时读取而非模块加载时固化，保证测试注入生效。
const DISTILL_SYSTEM_TEMPLATE = [
  '你是 QQ 机器人人设文件的维护者。规则：',
  '① character.md 在现有基础上增量演化——只写说话风格、口头禅、梗、性格，不包含行为底线规则（简短回复、不刷屏、|| 分段等由系统层注入，写进会重复冲突）；核心设定（呆萌大肥鱼、真诚、吉祥物定位）不许推翻；文中以 "- [" 开头的行是用户 /character 钦定的设定，必须逐行原样保留；',
  '② 值得记进 memory.md 的只有三类：用户的偏好（爱吃什么、喜欢什么）、身份事实（名字、职业、重要关系）、约定（说过要做什么）；闲聊情绪、临时话题、客套话不值得记，一律不写入；',
  '③ memory.md 为条目式——每条一行、以 "- " 开头；保留仍然有效的，删除过时错误的，合并重复；',
  '④ 每个文件不超过 {maxBytes} 字节；',
  '⑤ 只输出 JSON，不要 markdown 围栏，格式 {"character": "完整文件内容", "memory": "完整文件内容"}',
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

// ---- 预算反馈（user 侧动态标注）----
// LLM 只看 system 模板时只知道抽象上限 {maxBytes}，不知道当前文件已经多满——群
// g-741883823 的 character.md 曾涨到 4060/4096（99%），每轮补丁稳定超限被拒、水位
// 卡死、调度器 60s 一次真调 LLM 烧钱死循环。故把「实际字节/上限」写进 user（预算
// 每会话动态、system 模板保持全局静态），任一文件 > 90% 上限时再追加「务必净减」
// 硬指令，让模型明确知道这次必须压到上限以下且比现有内容更短。
const BUDGET_WARN_RATIO = 0.9;

// 单文件标注行（+ 近上限压缩警示行）：警示紧跟标注、位于文件内容之前
function budgetHeader(name, bytes, maxBytes, slimmingHint) {
  const lines = [`现有 ${name}（${bytes}/${maxBytes} 字节）：`];
  if (bytes > maxBytes * BUDGET_WARN_RATIO) {
    const pct = Math.floor((bytes / maxBytes) * 100);
    lines.push(`⚠ 该文件已用 ${pct}%，接近上限：本次输出必须更精简——${slimmingHint}，务必净减字节，不要新增。`);
  }
  return lines;
}

// 组装提炼 LLM messages：system 固定模板 + user（现有两份文件全文（含预算标注）+
// 待消化对话逐行）。导出供直测（纯函数，同 shouldDistill 先例）。
export function buildMessages(persona, newMessages) {
  const dialogue = newMessages.map((rec) => `[${rec.time}] ${speakerOf(rec)}: ${rec.raw_message}`);
  const maxBytes = config.personaMaxBytes;
  const user = [
    ...budgetHeader('character.md', Buffer.byteLength(persona.character, 'utf8'), maxBytes, '压缩合并现有段落、删减次要细节'),
    persona.character,
    '',
    ...budgetHeader('memory.md', Buffer.byteLength(persona.memory, 'utf8'), maxBytes, '合并重复条目、删除过时条目'),
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

// ---- /remember 锁定条目校验：extractLockedLines / patchKeepsLockedLines 实现已
// 搬家 persona-store.js（见文件顶部 re-export），distillSession 经 re-export 调用 ----

// ---- 双条件判定（纯函数，供直测）：水位后有新增 且（批量达标 或 会话静默足够久）----
// newMessages 已由调用方按 state.distillMark 水位筛出（state 仅为签名完整性保留）；
// 量纲：消息 time 秒级，与毫秒 nowMs 比较需 ×1000。
export function shouldDistill(newMessages, state, nowMs, conf) {
  if (newMessages.length === 0) return false;
  if (newMessages.length >= conf.distillBatchSize) return true;
  return nowMs - newMessages.at(-1).time * 1000 >= conf.distillSilenceMs;
}

// ---- 失败退避参数：连续全失败 ≥ 2 次进入 1 小时冷却 ----
// 死循环根因之一是失败无退避：确定性失败（超限补丁被拒等）被 60s 调度器无限重试、
// 每次都真调 LLM 烧钱。放模块常量而非 config：运维无需调整，测试以 state 文件
// 时间戳模拟到期，不必 env 注入。
export const DISTILL_BACKOFF_FAILS = 2;
export const DISTILL_BACKOFF_MS = 3600000;

// 全失败计数：distillFails +1 并刷新 distillFailAt（updateState 任意键浅合并，退避
// 字段直接落 session-state，无需改 store）。readState/updateState 均自兜底不抛。
async function recordDistillFail(sessionKey) {
  const state = await readState(sessionKey);
  await updateState(sessionKey, { distillFails: (state.distillFails ?? 0) + 1, distillFailAt: Date.now() });
}

// ---- 单会话提炼：退避检查 → 读底稿 → 固定模板调 LLM → 校验补丁 → 分文件落盘 →
// 水位/退避/usage ----
export async function distillSession(sessionKey, newMessages) {
  if (runningSet.has(sessionKey)) return; // 防重入：同会话提炼在途，本轮跳过
  runningSet.add(sessionKey);
  try {
    // 失败退避检查（提炼三件套之三）：连续 ≥ 2 次全失败且冷却未过 → 本轮直接跳过、
    // 不再真调 LLM（确定性失败重试只会重复烧钱）；到期自动恢复尝试，无需人工干预
    const state = await readState(sessionKey);
    if ((state.distillFails ?? 0) >= DISTILL_BACKOFF_FAILS) {
      const sinceFail = Date.now() - (state.distillFailAt ?? 0);
      if (sinceFail < DISTILL_BACKOFF_MS) {
        const remainMin = Math.ceil((DISTILL_BACKOFF_MS - sinceFail) / 60000);
        logger.info(`[distill] 会话 ${sessionKey} 连续失败退避中，剩余约 ${remainMin} 分钟`);
        return;
      }
    }

    // 现有人设（首访自动落种子）：本次演化的底稿
    const persona = await getPersona(sessionKey);
    const { content, usage } = await chatCompletion(buildMessages(persona, newMessages));

    const patch = parsePatch(content);
    if (patch === null) {
      logger.warn(`[distill] 会话 ${sessionKey} 提炼输出非合法 JSON 补丁，跳过（水位不动）`);
      await recordDistillFail(sessionKey);
      return;
    }

    // 锁定条目校验（applyPersonaPatch 前）：/remember 写入 memory.md、/character 写入
    // character.md 的钦定行（`- [` 开头）都必须逐行原文保留；任一文件缺行即拒绝——
    // 与其他全失败同路径（水位不动 + 计失败退避）。character 侧：未用过 /character 时
    // 锁定行为空、恒通过（存量行为不变）；种子/演化散文无 `- [` 行，不误伤
    if (!patchKeepsLockedLines(persona.memory, patch.memory) || !patchKeepsLockedLines(persona.character, patch.character)) {
      logger.warn(`[distill] 会话 ${sessionKey} 补丁丢失锁定条目（/remember 或 /character 行），拒绝（水位不动）`);
      await recordDistillFail(sessionKey);
      return;
    }

    // 分文件落盘（提炼三件套之二）：applyPersonaPatch 返回各文件是否实际落盘——
    // character 超限仅拒该文件、memory 超限由 store 兜底裁剪，互不连坐
    const applied = await applyPersonaPatch(sessionKey, patch);
    if (!applied.character && !applied.memory) {
      logger.warn(`[distill] 会话 ${sessionKey} 人设补丁两文件均未落盘，跳过（水位不动）`);
      await recordDistillFail(sessionKey);
      return;
    }

    // 部分或全部成功：水位照常推进 + 失败计数清零。刻意不因「某文件没落盘」重试同批
    // 对话——这批消息已消化，重试只会把同一批再喂 LLM 一次；未落盘文件的遗留问题靠
    // 下轮新对话 + 预算反馈（user 侧字节数/净减警示）自然修复。水位推进优先于完美
    // 主义，这是掐断死循环的关键一环。
    if (!applied.character || !applied.memory) {
      logger.warn(
        `[distill] 会话 ${sessionKey} 补丁部分落盘（character=${applied.character}, memory=${applied.memory}），水位仍推进`
      );
    }
    // 推进水位到本批最大 time（秒级，与消息 JSONL 同量纲，严格大于不重复处理）
    const maxTime = newMessages.reduce((max, rec) => Math.max(max, rec.time ?? 0), 0);
    await updateState(sessionKey, { distillMark: maxTime, distillFails: 0 });

    // 用量旁路观测（spec「用量观测」）：fire-and-forget 不 await（appendUsage 内部全
    // 捕获、失败仅 WARN）；响应缺 usage 字段（null）不记账。部分成功同样是真实调用，
    // 照记。
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
    // 任何异常（LLM 超时/网络等）：水位与文件不动，下轮扫描重试（受退避保护）
    logger.warn(`[distill] 会话 ${sessionKey} 提炼失败: ${err.message}`);
    await recordDistillFail(sessionKey); // 异常同为全失败：计入退避
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
