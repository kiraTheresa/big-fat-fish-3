// 入口条件组合器（upgrade-chat-pipeline「入口条件组合器」）：群聊触发判定拆成独立条件模块，
// 数组顺序即判定顺序，**任一开关开启且命中即触发**；私聊全量触发不在此层（chat.js 顶层先判）。
// 模块契约 { name, match(event) -> boolean }：match 是纯谓词（不含开关逻辑），开关由组合器按
// 约定读 config.behavior.trigger[name].enabled——模块名即开关键，后续 nameCall/replyQuote
// 模块直接 push 进数组即可，chat.js 消费端零改动。
import { config } from '../config.js';
import { extractText } from '../utils/extract-text.js';
import { isBotMessageId } from '../sender/bot-msg-ids.js';

// @命中条件（MVP 起唯一条件）：消息段含 at 段且 qq === self_id（'all' @全体不算，
// String() 双侧归一兼容数字/字符串两型 qq）；message 非数组（非标准/容错场景）不命中。
export function matchAt(event) {
  if (!Array.isArray(event.message)) return false;
  return event.message.some(
    (seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event.self_id)
  );
}

// 名字呼唤条件（upgrade-chat-pipeline「名字呼唤触发」）：消息纯文本包含任一别名即命中，
// 大小写不敏感（text 与别名双侧 toLowerCase——中文无大小写不受影响，英文别名可被
// 任意大小写写法喊中）；子串匹配用 includes（"大肥鱼今天吃什么" 含 "大肥鱼" 即算喊名）。
// 别名列表为空数组/非数组/含空串一律不命中：空别名属配置事故，恒真 includes('') 会让
// 所有消息误判成呼唤，宁可漏触发不可乱触发。
export function matchNameCall(event, aliases) {
  if (!Array.isArray(aliases) || aliases.length === 0) return false;
  const text = extractText(event).toLowerCase(); // extractText 已剥离 at/reply 段并 trim
  return aliases.some((alias) => {
    const name = String(alias).toLowerCase();
    return name !== '' && text.includes(name);
  });
}

// 引用回复条件（upgrade-chat-pipeline「引用回复触发」）：消息含 reply 段且被引用的
// data.id 属于 bot 出站 id 集合（sender 发送确认后记录，见 bot-msg-ids.js）即命中；
// 引用他人消息、无 reply 段、message 非数组均不命中。
export function matchReplyQuote(event) {
  if (!Array.isArray(event.message)) return false;
  return event.message.some(
    (seg) => seg?.type === 'reply' && isBotMessageId(seg.data?.id)
  );
}

// 条件数组：判定顺序即数组顺序（短路 some）。at → nameCall → replyQuote。
// nameCall 的 match 包装从 config 现取别名表（不缓存，config.json 热改后下一条消息
// 即生效）；纯谓词本体 matchNameCall(event, aliases) 单独导出便于直接单测。
export const chatConditions = [
  { name: 'at', match: matchAt },
  { name: 'nameCall', match: (event) => matchNameCall(event, config.behavior.trigger.nameCall?.aliases) },
  { name: 'replyQuote', match: matchReplyQuote },
];

// 群聊组合判定（chat.js 消费）：非群聊一律 false（组合器只负责群聊层）；
// 任一条件 enabled && 命中即触发——「条件全关」时恒 false，群聊消息静默。
export function matchGroupChat(event) {
  if (event.message_type !== 'group') return false;
  return chatConditions.some(
    (cond) => config.behavior.trigger[cond.name]?.enabled === true && cond.match(event)
  );
}
