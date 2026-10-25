// 共享谓词：消息是否 @ 了本机器人（指令 @ 门控 spec「寻址制」）。
// 自 chat-conditions.js 提出——chat 的 at 条件与 command/draw 的群聊指令 @ 门控
// 三处同源：一处定义，寻址语义永不漂移（chat 认的 @ 与指令认的 @ 必须是同一个）。
// 命中：消息段数组含 at 段且 qq === self_id（'all' @全体不算，String() 双侧归一
// 兼容数字/字符串两型 qq）；message 非数组（非标准/容错场景）不命中。
export function matchAt(event) {
  if (!Array.isArray(event.message)) return false;
  return event.message.some(
    (seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event.self_id)
  );
}
