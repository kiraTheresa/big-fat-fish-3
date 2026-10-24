// L2 分发层：筛选 → 打标 → 存储（旁听）→ 触发器链（bot-core-design §2、§6）。
// 职责：仅放行 post_type==='message'（第三道筛选，心跳/notice/request 全部拦下）；
// 打标 sessionKey（群 g-{group_id}、私 p-{user_id}）并构造 ctx；
// 把入站快照以 fire-and-forget 方式交给存储钩子（不 await，失败不影响主管道）；
// 按注册顺序匹配触发器，命中即停，全不中静默；match/handle 异常捕获记 ERROR。
// 本模块不含任何业务 if-else：触发器选择完全依赖注册表（§3「禁止事项」）。
import { getTriggers } from './registry.js';
import { sendGroup, sendPrivate } from '../sender/sender.js';
import { appendMessage } from '../store/message-store.js';
import { logger } from '../utils/logger.js';

export async function dispatch(event) {
  // 筛选③：MVP 只处理 message 事件
  if (event.post_type !== 'message') return;

  // 打标（§2.2）：同一会话的索引键——冷却计数、上下文记忆、消息存储都以它为索引
  const sessionKey = event.message_type === 'group' ? `g-${event.group_id}` : `p-${event.user_id}`;

  logger.info(`收到消息: [${sessionKey}] ${event.sender?.nickname ?? event.user_id}: ${event.raw_message}`);

  // 存储钩子（§6.3 旁听者）：打标后、进触发器链前，不 await，写失败只记 WARN
  const snapshot = {
    sessionKey,
    time: event.time,
    message_id: event.message_id,
    message_type: event.message_type,
    user_id: event.user_id,
    raw_message: event.raw_message,
    sender: event.sender,
  };
  if (event.group_id !== undefined) snapshot.group_id = event.group_id;
  appendMessage(snapshot);

  // ctx：触发器可用的全部能力——出站只经 reply() 走发送层，禁止直接触碰连接层
  const ctx = {
    event,
    sessionKey,
    reply(text) {
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
