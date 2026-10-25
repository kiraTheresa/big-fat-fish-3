// 出口加工链（upgrade-chat-pipeline「回复随机延迟」「分段连发」「回复带引用」）：LLM
// 回复产出后、发送前对 segments 数组依序加工。模块契约 { name, enabled(config),
// run(ctx, segments) -> segments }，数组顺序即处理顺序（delay → split → quote），消费端
// chat.js 只遍历数组，模块增删对它零改动。
// 加工链活在触发器层：延迟/分段是「拟人化节奏」的前置加工，不得触碰 sender 的 1s 全局节流
// （那是另一维度的出站限流，两者叠加生效）。
import { config } from '../config.js';

// 随机延迟取值（导出纯函数便于单测，random 可注入假随机源）：闭区间 [minMs, maxMs] 含两端；
// min > max 属配置写反，取 min 兜底——按更保守的短延迟直发，胜过抛错打断回复主链路。
export function pickDelayMs(minMs, maxMs, random = Math.random) {
  if (minMs > maxMs) return minMs;
  return minMs + Math.floor(random() * (maxMs - minMs + 1));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 分段拆分纯函数（导出便于单测）：segments 每条按 separator 与换行拆 → trim → 滤空 → flat。
// 换行为何也当分隔符（0.9.3 修复）：真机实测 LLM 几乎不用 ||（约定遵从度极低），却总用
// 换行表达「连发多条」——与其逼它学新符号，不如顺着习惯把换行视为同一种分段意图，
// 两种写法拆出来的效果一致。separator 先归一到换行再统一拆，\r\n 一并归一。
// 拆分结果全空（LLM 只吐分隔符/空白）时回退原 segments——宁可整段发出，不吞回复；
// separator 为空串时跳过 || 拆分（split('') 单字符事故），但换行拆分仍生效（内建行为，
// 不依赖配置）。
export function splitSegments(segments, separator) {
  const parts = segments
    .flatMap((seg) => {
      const text = String(seg).replace(/\r\n/g, '\n');
      const unified = separator === '' ? text : text.split(separator).join('\n');
      return unified.split('\n');
    })
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return parts.length > 0 ? parts : segments;
}

// 加工链数组：处理顺序即数组顺序（delay 先酝酿整条回复、split 再拆段——拆分不额外吃延迟，
// 分段间的发送节奏归 sender 的 1s 队列节流）
export const chatReplyChain = [
  {
    name: 'delay',
    // 开关在模块内读（而非组合器统一读）：加工模块的开关结构各异（delay 有 min/max、
    // split 有 separator），enabled(config) 把「是否参与本轮」留给模块自决
    enabled(cfg) {
      return cfg.behavior.reply.delay.enabled === true;
    },
    // 延迟只占用时间、不改内容：segments 原样透传（每条独立 sleep 一次还是整体一次？
    // 延迟语义是「酝酿这条回复」，一次 LLM 调用只 sleep 一次，分段间的节奏归 sender 节流）
    async run(ctx, segments) {
      const { minMs, maxMs } = config.behavior.reply.delay;
      await sleep(pickDelayMs(minMs, maxMs));
      return segments;
    },
  },
  {
    name: 'split',
    // 契约同 delay：enabled 读形参 cfg（开关自决），run 读全局 config 的 separator
    enabled(cfg) {
      return cfg.behavior.reply.split.enabled === true;
    },
    // 纯内容加工无异步等待，async 仅为对齐加工链 run 契约（chat.js 统一 await）
    async run(ctx, segments) {
      return splitSegments(segments, config.behavior.reply.split.separator);
    },
  },
  {
    name: 'quote',
    // 契约同 delay/split：enabled 读形参 cfg（开关自决）
    enabled(cfg) {
      return cfg.behavior.reply.quote.enabled === true;
    },
    // 回复带引用（spec「回复带引用」）：仅群聊把首条替换为消息段数组
    // [{type:'reply',data:{id}},{type:'text',...}]（napcat-protocol §3.4 形状），reply 段
    // 指向触发消息的 message_id。为什么必须排在 split 之后：引用挂的是「真正出站的
    // 第一帧」——挂早了会把引用错挂到 LLM 原始全文上，拆分后首段才是用户看到的第一条。
    // sender 对 message 字段纯透传，段数组无需发送端任何适配
    async run(ctx, segments) {
      // 防御：空 segments 无首条可挂（正常不会空——split 有全空回退），原样透传
      if (segments.length === 0) return segments;
      const { event } = ctx;
      // 仅群聊附加：私聊一对一没有「引用谁」的歧义，引用反而突兀
      if (event.message_type !== 'group') return segments;
      // 触发消息缺 message_id（异常事件）：无从构造引用，内容优先直发不加引用
      if (event.message_id == null) return segments;
      // 首条非 string（理论不会发生——上游 delay/split 产物恒 string）：不加工保底透传
      if (typeof segments[0] !== 'string') return segments;
      return [
        [
          { type: 'reply', data: { id: String(event.message_id) } },
          { type: 'text', data: { text: segments[0] } },
        ],
        ...segments.slice(1),
      ];
    },
  },
];
