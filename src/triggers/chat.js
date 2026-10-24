// L3 触发器：AIChat（MVP 起源于 add-aichat-mvp spec，行为演进归 add-self-evolving-persona）。
// bot-core-design §4 的落地：「LLM 调用塞进某个触发器的 handle 内部，架构不变」。
// 触发规则（match）：
//   - 未配置 DEEPSEEK_API_KEY → 恒不触发（不吞私聊消息）；
//   - 私聊 → 全量触发（ping 等更早注册的触发器靠「命中即停」优先）；
//   - 群聊 → 仅当消息段含 at 段且 qq === self_id（@全体 'all' 不算）。
// handle：提取 text 段为内容（空则忽略）→ 会话冷却检查 → 并行读 persona 与会话状态 →
//   system 组装（character → ## 记忆 → memory → ## 行为规则，固定顺序、结构稳定，前缀
//   逐字节稳定以吃 DeepSeek 上下文缓存）→ 读 JSONL 上下文（bot 行→assistant，入站→user，
//   当前消息按 message_id 去重；/reset 水位 resetAt 之前的行入站与 bot 同滤）→ 调 LLM
//   → reply；usage 旁路 appendUsage(kind: 'chat') fire-and-forget 落盘；
//   LLM 失败/超时 → 固定兜底文案 + WARN。
import { config } from '../config.js';
import { chatCompletion } from '../llm.js';
import { readRecentMessages } from '../store/message-store.js';
import { getPersona } from '../store/persona-store.js';
import { readState } from '../store/session-state.js';
import { appendUsage } from '../store/usage-store.js';
import { extractText } from '../utils/extract-text.js';
import { logger } from '../utils/logger.js';

const FALLBACK_REPLY = 'AI 开小差了，稍后再试～';

// 会话级冷却表：sessionKey → 上次开始响应的时刻（进程内 Map，重启即清）
const cooldowns = new Map();

export default {
  name: 'chat',
  match(event) {
    if (config.deepseekApiKey === '') return false; // 未配置 LLM：本触发器不生效
    if (event.message_type === 'private') return true;
    if (event.message_type !== 'group' || !Array.isArray(event.message)) return false;
    return event.message.some(
      (seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event.self_id)
    );
  },

  async handle(ctx) {
    const { event, sessionKey } = ctx;

    const content = extractText(event);
    if (content === '') {
      logger.info(`[chat] ${sessionKey} 消息无文本内容，忽略`);
      return;
    }

    // 冷却防刷：窗口内静默跳过（不调 LLM、不回复）
    const last = cooldowns.get(sessionKey) ?? 0;
    if (Date.now() - last < config.chatCooldownMs) {
      logger.info(`[chat] 会话 ${sessionKey} 冷却中，跳过`);
      return;
    }
    cooldowns.set(sessionKey, Date.now());

    // persona（character + memory）与会话状态（resetAt 水位）互不依赖，并行读
    const [persona, state] = await Promise.all([getPersona(sessionKey), readState(sessionKey)]);

    // system 组装（add-self-evolving-persona「人设注入与上下文水位」）：character →
    // ## 记忆 → memory → ## 行为规则，固定顺序、空行分隔。memory 为空也保留「## 记忆」
    // 标题与空行——结构稳定 > 内容紧凑：前缀逐字节稳定才能命中 DeepSeek 上下文缓存
    // （prompt_cache_hit_tokens 可观测），为省几个空行击穿缓存得不偿失。
    const systemPrompt = [
      persona.character,
      '',
      '## 记忆',
      '',
      persona.memory,
      '',
      '## 行为规则',
      '',
      '- 用简短口语化的中文回复，不要使用 Markdown 格式',
    ].join('\n');

    // 上下文：会话 JSONL 尾部 N 条；当前消息可能已先被入站落盘，按 message_id 去重
    const records = await readRecentMessages(sessionKey, config.chatContextLines);
    const isGroup = event.message_type === 'group';
    const history = records
      .filter((rec) => rec.message_id !== event.message_id)
      // /reset 水位：resetAt 之前的行（入站与 bot 行同滤）不再进入上下文——JSONL
      // 本体保留（append-only 纪律），只影响 LLM 可见范围；resetAt 不存在时不过滤
      .filter((rec) => state.resetAt === undefined || !(rec.time < state.resetAt))
      .map((rec) =>
        rec.bot
          ? { role: 'assistant', content: rec.raw_message }
          : {
              role: 'user',
              content: isGroup ? `${rec.sender?.nickname ?? rec.user_id}: ${rec.raw_message}` : rec.raw_message,
            }
      );

    const speaker = event.sender?.nickname ?? event.user_id;
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: isGroup ? `${speaker}: ${content}` : content },
    ];

    try {
      const { content: reply, usage } = await chatCompletion(messages);
      await ctx.reply(reply);
      // 用量旁路观测（spec「用量观测」）：fire-and-forget 不 await（appendUsage 内部
      // 全捕获、失败仅 WARN），不阻塞回复主链路；响应缺 usage 字段（null）不记账
      if (usage !== null) {
        appendUsage(sessionKey, {
          time: Date.now(),
          kind: 'chat',
          model: config.deepseekModel,
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
        });
      }
    } catch (err) {
      logger.warn(`[chat] LLM 调用失败: ${err.message}`);
      await ctx.reply(FALLBACK_REPLY);
    }
  },
};
