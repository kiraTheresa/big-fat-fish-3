// L3 触发器：AIChat（MVP 起源于 add-aichat-mvp spec，行为演进归 add-self-evolving-persona，
// 触发组合/回复加工归 upgrade-chat-pipeline）。
// bot-core-design §4 的落地：「LLM 调用塞进某个触发器的 handle 内部，架构不变」。
// 触发规则（match）：
//   - 未配置 DEEPSEEK_API_KEY → 恒不触发（不吞私聊消息）；
//   - 私聊 → 全量触发（ping 等更早注册的触发器靠「命中即停」优先）；
//   - 群聊 → 入口条件组合器（chat-conditions.js）：任一开关开启且命中的条件模块即触发。
// handle：提取 text 段为内容（空则忽略）→ 会话冷却检查 → 并行读 persona 与会话状态 →
//   读 JSONL 上下文（bot 行→assistant，入站→user，当前消息按 message_id 去重；/reset
//   水位 resetAt 之前的行入站与 bot 同滤）→ system 组装（chat-system.js：character →
//   ## 记忆 → memory → ## 行为规则 固定前缀 + ## 当前场景 动态尾部，前缀逐字节稳定
//   以吃 DeepSeek 上下文缓存）→ 预算裁剪（chat-context.js：budgetBytes 封顶
//   system+历史字节总量，超出的最旧历史先裁，与 20 条上限谁更紧听谁的）→ 调 LLM →
//   出口加工链（chat-reply-chain.js：随机延迟、
//   || 分段连发）→ 存储合并 + 逐条发送；
//   usage 旁路 appendUsage(kind: 'chat') fire-and-forget 落盘；
//   LLM 失败/超时 → 固定兜底文案 + WARN（兜底不走加工链，告警类消息无需拟人延迟）。
import { config } from '../config.js';
import { chatCompletion } from '../llm.js';
import { appendMessage, readRecentMessages } from '../store/message-store.js';
import { getPersona } from '../store/persona-store.js';
import { readState } from '../store/session-state.js';
import { appendUsage } from '../store/usage-store.js';
import { extractText } from '../utils/extract-text.js';
import { logger } from '../utils/logger.js';
import { matchGroupChat } from './chat-conditions.js';
import { fitHistoryToBudget } from './chat-context.js';
import { buildSystemPrompt } from './chat-system.js';
import { chatReplyChain } from './chat-reply-chain.js';
import { sendGroup, sendPrivate } from '../sender/sender.js';

const FALLBACK_REPLY = 'AI 开小差了，稍后再试～';

// 会话级冷却表：sessionKey → 上次开始响应的时刻（进程内 Map，重启即清）
const cooldowns = new Map();

export default {
  name: 'chat',
  match(event) {
    if (config.deepseekApiKey === '') return false; // 未配置 LLM：本触发器不生效
    if (event.message_type === 'private') return true;
    // 群聊：条件组合器任一命中即触发（非群聊事件组合器内恒 false）
    return matchGroupChat(event);
  },

  async handle(ctx) {
    const { event, sessionKey } = ctx;

    const content = extractText(event);
    if (content === '') {
      logger.info(`[chat] ${sessionKey} 消息无文本内容，忽略`);
      return;
    }

    // 冷却防刷：窗口内静默跳过（不调 LLM、不回复）。计时在 LLM 调用前 set：
    // 冷却管「开始响应」，出口加工链的随机延迟管「发出节奏」，两者互不干扰
    const last = cooldowns.get(sessionKey) ?? 0;
    if (Date.now() - last < config.chatCooldownMs) {
      logger.info(`[chat] 会话 ${sessionKey} 冷却中，跳过`);
      return;
    }
    cooldowns.set(sessionKey, Date.now());

    // persona（character + memory）与会话状态（resetAt 水位）互不依赖，并行读
    const [persona, state] = await Promise.all([getPersona(sessionKey), readState(sessionKey)]);

    const isGroup = event.message_type === 'group';

    // 上下文：会话 JSONL 尾部 N 条。入站消息在触发器之前已被 dispatcher 落盘，records
    // 尾部通常就是当前消息——先按 message_id 滤出 prevRecords（上一条及更早），供两处
    // 消费：LLM history（再滤 /reset 水位）与动态尾部的静默时长锚点
    const records = await readRecentMessages(sessionKey, config.chatContextLines);
    const prevRecords = records.filter((rec) => rec.message_id !== event.message_id);
    // 上一条消息的秒级时间戳（OneBot 量纲，bot 行回存 time 同量纲）；无历史或异常行
    // 缺 time 时兜底 null（新对话语义），不让 undefined 算出 NaN 静默文案
    const lastTimeSec = prevRecords.at(-1)?.time ?? null;

    // system 组装（add-self-evolving-persona「人设注入」+ upgrade-chat-pipeline「动态
    // 尾部」）：固定前缀（character → ## 记忆 → memory → ## 行为规则）逐字节稳定才能
    // 命中 DeepSeek 上下文缓存（为省几个空行击穿缓存得不偿失），时间/场景/静默时长是
    // 动态尾部、全部后置；静默锚点取 prevRecords 尾部（JSONL 真实最后一条，不受 /reset
    // 水位过滤影响——水位只约束 LLM 可见历史，静默时长描述的是会话本身）
    const systemPrompt = buildSystemPrompt(persona, { isGroup, nowMs: Date.now(), lastTimeSec });

    const history = prevRecords
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

    // 预算裁剪（spec「上下文预算制」）：budgetBytes 封顶 system+历史的字节总量，从最新
    // 向最旧装填、装不下即停——最旧先裁、保留最近的连续段。放在条数上限
    //（readRecentMessages 的 chatContextLines 截取）之后，两者同时生效、谁更紧听谁的。
    // lastTimeSec 静默锚点取 prevRecords 尾部（裁剪前的完整过滤集），且裁剪只砍头部
    // 不碰尾部——静默计算不受影响
    const fittedHistory = fitHistoryToBudget(history, systemPrompt, config.behavior.context.budgetBytes);

    const speaker = event.sender?.nickname ?? event.user_id;
    const messages = [
      { role: 'system', content: systemPrompt },
      ...fittedHistory,
      { role: 'user', content: isGroup ? `${speaker}: ${content}` : content },
    ];

    // 统一出口：存储职责 + 发送职责。与 dispatcher 的 ctx.reply 分道——ctx.reply 留给
    // ping/command，chat 的出口由加工链驱动，为分段连发（Task 4）预留职责切分：
    //   - 存储：一次 LLM 调用只 appendMessage **一条** bot 行，raw_message 取 LLM
    //     原始输出全文（非分段合并值）——上下文重建为单条 assistant 消息，不碎片化；
    //   - 发送：segments 逐条经 sender（每条独立过 1s 队列节流）；
    //   - 行形状与 dispatcher 的 bot 行回存一致：秒级 time、bot:true、无 message_id。
    const persistAndSend = (rawMessage, segments) => {
      appendMessage({
        sessionKey,
        time: Math.floor(Date.now() / 1000),
        message_type: event.message_type,
        ...(event.group_id !== undefined ? { group_id: event.group_id } : {}),
        user_id: event.user_id,
        raw_message: rawMessage,
        bot: true,
      });
      for (const seg of segments) {
        if (isGroup) sendGroup(event.group_id, seg);
        else sendPrivate(event.user_id, seg);
      }
    };

    try {
      const { content: reply, usage } = await chatCompletion(messages);

      // 出口加工链：LLM 原始输出装入 segments 数组（Task 4 的 split 从这里接管拆分），
      // 各模块按 enabled(config) 自决参与、依序 await 加工（delay 在此吃掉随机时长）
      let segments = [reply];
      for (const mod of chatReplyChain) {
        if (mod.enabled(config)) segments = await mod.run(ctx, segments);
      }
      persistAndSend(reply, segments);

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
      // 兜底文案不是 LLM 输出：不走加工链（不延迟，出错要立刻让人知道），但存储与
      // 发送仍走统一出口（与既有行为等价：回存一条 bot 行 + 发一条）
      persistAndSend(FALLBACK_REPLY, [FALLBACK_REPLY]);
    }
  },
};
