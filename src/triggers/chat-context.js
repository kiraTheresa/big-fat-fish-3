// 上下文预算裁剪（upgrade-chat-pipeline「上下文预算制」）：budgetBytes 封顶 system +
// 历史消息的字节总量，超出部分裁最旧的历史。为什么「从最新向最旧累加、装不下即停」
// 而不是从旧到新装填：保留集必须是最近的**连续**一段——从中段挖洞会把多轮对话剪成
// 前言不搭后语，且最近的上下文对本轮回复影响最大。为什么只按 content 字节计（不含
// role 等包装开销）：预算是防 prompt 失控的粗筛，不是 API 计费的精算，spec 即如此约定。
// 纯函数模块（同 chat-system.js 纪律）：不 import config、不触碰存储，systemPrompt 与
// budgetBytes 由调用方注入，测试无需 mock 装配即可直测边界。

// history：已映射好的 LLM 消息数组（[{role, content}]，时间线旧 → 新）。返回裁剪后的
// 新数组（时间线顺序保持旧 → 新），入参数组与元素均不被篡改。
export function fitHistoryToBudget(history, systemPrompt, budgetBytes) {
  // 历史可用字节 = 预算 − system 实占。system 自身超预算（可用 ≤ 0）时历史全裁——
  // 极端防御：宁可零历史也不让 prompt 总量失控，绝不抛错打断回复主链路
  //（system 本体照发，预算只管历史这一侧）
  let remaining = budgetBytes - Buffer.byteLength(systemPrompt, 'utf8');
  if (remaining <= 0) return [];
  // 从最新向最旧装填：单条装不下即停，它连同更旧的所有消息整体放弃（连续段纪律）
  const kept = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const bytes = Buffer.byteLength(history[i].content, 'utf8');
    if (bytes > remaining) break; // 恰好装下（=== remaining）算装得下，等号成立
    remaining -= bytes;
    kept.push(history[i]);
  }
  kept.reverse(); // kept 是从新到旧收集的，恢复时间线顺序（旧 → 新）
  return kept;
}
