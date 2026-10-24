// L3 触发器：AIChat（MVP，add-aichat-mvp spec）。
// bot-core-design §4 的落地：「LLM 调用塞进某个触发器的 handle 内部，架构不变」。
// 触发规则（match）：
//   - 未配置 DEEPSEEK_API_KEY → 恒不触发（不吞私聊消息）；
//   - 私聊 → 全量触发（ping 等更早注册的触发器靠「命中即停」优先）；
//   - 群聊 → 仅当消息段含 at 段且 qq === self_id（@全体 'all' 不算）。
// handle：提取 text 段为内容（空则忽略）→ 会话冷却检查 → 读 JSONL 上下文
//   （bot 行→assistant，入站→user，当前消息按 message_id 去重）→ 调 LLM → reply；
//   LLM 失败/超时 → 固定兜底文案 + WARN。
import { config } from '../config.js';
import { chatCompletion } from '../llm.js';
import { readRecentMessages } from '../store/message-store.js';
import { logger } from '../utils/logger.js';

const SYSTEM_PROMPT = '你是一个QQ群里的聊天机器人，用简短、口语化的中文回答，不要使用Markdown格式。';
const FALLBACK_REPLY = 'AI 开小差了，稍后再试～';

// 会话级冷却表：sessionKey → 上次开始响应的时刻（进程内 Map，重启即清）
const cooldowns = new Map();

// 从消息段数组提取纯文本（at/reply 等非 text 段剥离）。
// 仅当事件没有消息段数组（非标准/容错场景）才退回 raw_message；
// 段数组存在但无 text 段（如纯 @bot）视为空文本，避免 at 占位文本混入 prompt。
function extractText(event) {
  if (!Array.isArray(event.message)) return (event.raw_message ?? '').trim();
  return event.message
    .filter((seg) => seg?.type === 'text')
    .map((seg) => seg.data?.text ?? '')
    .join('')
    .trim();
}

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

    // 上下文：会话 JSONL 尾部 N 条；当前消息可能已先被入站落盘，按 message_id 去重
    const records = await readRecentMessages(sessionKey, config.chatContextLines);
    const isGroup = event.message_type === 'group';
    const history = records
      .filter((rec) => rec.message_id !== event.message_id)
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
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: isGroup ? `${speaker}: ${content}` : content },
    ];

    try {
      const reply = await chatCompletion(messages);
      await ctx.reply(reply);
    } catch (err) {
      logger.warn(`[chat] LLM 调用失败: ${err.message}`);
      await ctx.reply(FALLBACK_REPLY);
    }
  },
};
