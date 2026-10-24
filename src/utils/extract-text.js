// 共享 util：OneBot 消息事件的纯文本提取（add-self-evolving-persona Task 2 自 chat.js 提出，
// chat/command 等触发器共用，零行为变化）。
// 从消息段数组提取纯文本（at/reply 等非 text 段剥离）。
// 仅当事件没有消息段数组（非标准/容错场景）才退回 raw_message；
// 段数组存在但无 text 段（如纯 @bot）视为空文本，避免 at 占位文本混入 prompt。
export function extractText(event) {
  if (!Array.isArray(event.message)) return (event.raw_message ?? '').trim();
  return event.message
    .filter((seg) => seg?.type === 'text')
    .map((seg) => seg.data?.text ?? '')
    .join('')
    .trim();
}
