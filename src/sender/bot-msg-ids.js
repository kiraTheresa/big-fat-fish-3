// 出站 message_id 进程内记录（upgrade-chat-pipeline「引用回复触发」）：sender 每次
// send_msg 成功确认（retcode=0）后把响应中的 message_id 记入本集合，replyQuote 条件
// 模块据此判定「群友引用的是不是 bot 自己刚发的消息」。放 sender 目录：它是发送层
// 的伴生记录、不落盘（store/ 下全部是 JSONL 持久层）。
// 已知限制（spec 接受）：集合仅进程内存，重启即清——重启后引用重启前 bot 发的消息不触发。
export const BOT_MSG_ID_LIMIT = 1000; // 容量上限：防长驻进程无界增长，超限先进先出淘汰最旧

const seen = new Set(); // String 归一后的 id 集合（OneBot id 数字/字符串两型，入集与查询双侧归一）
const order = []; // 入集顺序（队头即最旧），与 seen 同步维护以实现 FIFO 淘汰

export function recordBotMessageId(id) {
  // 发送确认残缺（retcode=0 但 data 无 message_id）不入集：String(undefined) 会造出
  // 幽灵 id "undefined"，让 reply 段恰好缺 id 的事件误命中
  if (id === undefined || id === null) return;
  const key = String(id);
  if (seen.has(key)) return; // 重复确认幂等：不重复入队占 FIFO 容量（淘汰只按首次入集顺序）
  seen.add(key);
  order.push(key);
  if (order.length > BOT_MSG_ID_LIMIT) {
    seen.delete(order.shift()); // 超限淘汰队头（最旧一条）
  }
}

export function isBotMessageId(id) {
  return seen.has(String(id));
}

// 测试辅助：清空集合，生产代码不得调用
export function clearBotMessageIds() {
  seen.clear();
  order.length = 0;
}
