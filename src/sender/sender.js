// L4 发送层：全项目唯一出站口（bot-core-design §3）。
// 队列 + 固定间隔（config.sendIntervalMs）逐条出队，防风控限流；
// 统一走 callApi('send_msg')：群聊 message_type=group + group_id，私聊 message_type=private + user_id
// （不使用 send_group_msg / send_private_msg 直调）。
// 单条失败仅记 WARN 并继续下一条；本模块不暴露任何绕过队列的发送接口。
import { callApi } from '../connection/onebot.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const queue = []; // 待发送参数（send_msg 的 params），先进先出
let draining = false;

export function sendGroup(groupId, message) {
  enqueue({ message_type: 'group', group_id: groupId, message });
}

export function sendPrivate(userId, message) {
  enqueue({ message_type: 'private', user_id: userId, message });
}

function enqueue(params) {
  queue.push(params);
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const params = queue.shift();
      try {
        const data = await callApi('send_msg', params);
        logger.info(`发送确认: message_id=${data?.message_id}`);
      } catch (err) {
        logger.warn(`发送失败: ${err.message}`); // 单条失败不阻断队列
      }
      await delay(config.sendIntervalMs); // 固定间隔：两条出站帧之间至少间隔 sendIntervalMs
    }
  } finally {
    draining = false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
