// L2 分发层：协议归一 → 完整事件收件箱 → 消息历史 → 既有触发器链。
// 新消息段、通知、请求、元事件只接收和保存，不执行新业务。
// 打标 sessionKey（群 g-{group_id}、私 p-{user_id}）并构造 ctx；
// 把入站快照以 fire-and-forget 方式交给存储钩子（不 await，失败不影响主管道）；
// 按注册顺序匹配触发器，命中即停，全不中静默；match/handle 异常捕获记 ERROR。
// 本模块不含任何业务 if-else：触发器选择完全依赖注册表（§3「禁止事项」）。
import { getTriggers } from './registry.js';
import { sendGroup, sendPrivate } from '../sender/sender.js';
import { appendMessage } from '../store/message-store.js';
import { appendEvent } from '../store/event-store.js';
import { normalizeOneBotEvent } from '../protocol/onebot.js';
import { logger } from '../utils/logger.js';
import { canUseBot, observeUser } from '../platform/permissions.js';

export async function dispatch(input) {
  const normalized = normalizeOneBotEvent(input);
  if (!normalized) return;
  const { event, sessionKey, segments, messageTypes, issues, postType, eventType, subType, handling } = normalized;
  const allowed = canUseBot(event);
  appendEvent({ postType, eventType, subType, sessionKey, messageTypes, handling: allowed ? handling : 'blocked', issues, event: input,
    ...(Array.isArray(event.message) ? { segments } : {}) });

  // Complete receipt is independent from business handling. In particular,
  // message_sent must never create an automatic reply loop or duplicate bot history.
  try { await observeUser(event); } catch (err) { logger.warn(`用户登记失败: ${err.code ?? 'storage error'}`); }
  if (!allowed || !normalized.processable || !sessionKey) return;

  logger.info(`收到消息: [${sessionKey}] id=${event.message_id ?? 'unknown'} types=${messageTypes.join(',')}`);

  // 存储钩子（§6.3 旁听者）：打标后、进触发器链前，不 await，写失败只记 WARN
  const snapshot = {
    sessionKey,
    time: event.time,
    message_id: event.message_id,
    message_type: event.message_type,
    user_id: event.user_id,
    raw_message: event.raw_message,
    message: event.message,
    sub_type: event.sub_type,
    sender: event.sender,
  };
  if (event.group_id !== undefined) snapshot.group_id = event.group_id;
  appendMessage(snapshot);

  // ctx：触发器可用的全部能力——出站只经 reply() 走发送层，禁止直接触碰连接层
  const ctx = {
    event,
    sessionKey,
    reply(text) {
      // 出站回复回存（add-aichat-mvp spec，bot-core-design §6.3 预留条款）：
      // 与入站同会话文件追加一行，bot:true 标记（无 message_id，发送前落盘）
      appendMessage({
        sessionKey,
        time: Math.floor(Date.now() / 1000),
        message_type: event.message_type,
        ...(event.group_id !== undefined ? { group_id: event.group_id } : {}),
        user_id: event.user_id,
        raw_message: text,
        bot: true,
      });
      if (event.message_type === 'group') return sendGroup(event.group_id, text);
      return sendPrivate(event.user_id, text);
    },
  };

  for (const trigger of getTriggers()) {
    let matched = false;
    try {
      matched = trigger.match(event);
    } catch (err) {
      logger.error(`触发器 ${trigger.name} match 异常: ${err.message}`);
      continue; // 本触发器作废，继续尝试下一个
    }
    if (!matched) continue;

    logger.info(`触发器命中: ${trigger.name}`);
    try {
      await trigger.handle(ctx);
    } catch (err) {
      logger.error(`触发器 ${trigger.name} 处理异常: ${err.message}`);
    }
    return; // 命中即停：一条消息只触发一个触发器
  }
  // 全不中：静默（不是所有消息都需要回复）
}
