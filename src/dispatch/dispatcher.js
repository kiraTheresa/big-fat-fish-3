// 事件分发：事件 → 触发器链（按注册顺序匹配，命中即停）
// 本期只处理 message 事件，notice/request（戳一戳等）后续接入
import { getTriggers } from './registry.js';
import { sendGroup, sendPrivate } from '../sender/sender.js';
import { logger } from '../utils/logger.js';

export async function dispatch(event) {
  if (event.post_type !== 'message') return;

  // ctx：触发器可用的能力，禁止直接触碰连接层
  const ctx = {
    event,
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
      continue;
    }
    if (!matched) continue;

    logger.info(`触发器命中: ${trigger.name}`);
    try {
      await trigger.handle(ctx);
    } catch (err) {
      logger.error(`触发器 ${trigger.name} 处理异常: ${err.message}`);
    }
    return; // 命中即停
  }
}
