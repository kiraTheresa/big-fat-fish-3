// L4 发送层：全项目唯一出站口（bot-core-design §3）。
// 队列 + 固定间隔（config.sendIntervalMs）逐条出队，防风控限流；
// 统一走 callApi('send_msg')：群聊 message_type=group + group_id，私聊 message_type=private + user_id
// （不使用 send_group_msg / send_private_msg 直调）。
// 单条失败仅记 WARN 并继续下一条；本模块不暴露任何绕过队列的发送接口。
// 发送确认成功后把出站 message_id 记入 bot-msg-ids（replyQuote 条件模块的数据源）。
import { callApi } from '../connection/onebot.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { recordBotMessageId } from './bot-msg-ids.js';

const queue = []; // 待发送参数（send_msg 的 params），先进先出
let draining = false;
let sent = 0;
let failed = 0;
export function getSenderStatus() { return { queued: queue.length, draining, sent, failed }; }

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
        // callApi resolve 即 retcode=0 路径：仅成功确认的出站 id 入集（replyQuote 的
        // 「引用 bot 消息」判定依据）；失败重发会拿到新 id，各按各的确认入集
        recordBotMessageId(data?.message_id);
        sent++;
      } catch (err) {
        failed++;
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

export async function drainSender(timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while ((draining || queue.length) && Date.now() < deadline) await delay(20);
  return !draining && queue.length === 0;
}
