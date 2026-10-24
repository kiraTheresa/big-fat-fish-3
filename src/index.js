// 装配入口：注册触发器、接线、启动连接
import { config } from './config.js';
import { startConnection, onEvent } from './connection/onebot.js';
import { dispatch } from './dispatch/dispatcher.js';
import { register } from './dispatch/registry.js';
import { logger } from './utils/logger.js';

import ping from './triggers/ping.js';

register(ping);

onEvent((event) => {
  if (event.post_type === 'message') {
    const source = event.message_type === 'group' ? `群 ${event.group_id}` : '私聊';
    logger.info(`[消息] ${source} · ${event.sender?.nickname || event.user_id}: ${event.raw_message}`);
  }
  dispatch(event);
});

logger.info(`Bot 核心启动，目标: ${config.wsUrl}`);
startConnection();
