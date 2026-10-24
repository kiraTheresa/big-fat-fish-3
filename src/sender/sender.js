// 发送层：出站消息唯一收口。队列 + 固定间隔限流（防风控）。
// 触发器禁止绕过本层直接调用 connection.callApi 发消息。
import { callApi } from '../connection/onebot.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const queue = []; // 存放待发送任务（函数），统一在此排队
let draining = false;

export function sendPrivate(userId, message) {
  queue.push(() => callApi('send_private_msg', { user_id: userId, message }));
  drain();
}

export function sendGroup(groupId, message) {
  queue.push(() => callApi('send_group_msg', { group_id: groupId, message }));
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length > 0) {
    const send = queue.shift();
    try {
      await send();
    } catch (err) {
      logger.warn(`发送失败: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, config.sendIntervalMs));
  }
  draining = false;
}
