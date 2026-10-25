// L3 触发器：/draw 文生图（首次图像生成能力，上游走老张中转，见 src/imagegen.js）。
// 注册顺序 ping → draw → command → chat（index.js）：command 的 match 是「'/' 开头就吃」，
// draw 必须排在它前面——否则 /draw 永远收到「本鱼不认识这个指令」；命中即停保证
// /draw 不会误入 chat 白白调一次 LLM。
// 群聊 @ 门控（同 command 的指令寻址制）：群聊 /draw 须 @ 本鱼，裸发一律静默（与
// 白名单未命中的静默同风格——不回引导、不暴露功能存在）；私聊免 @。match 仍宽吞
// /^\/draw(\s|$)/，@ 判定在 handle 开头（未 @ 的 '/draw' 也不落入 chat 白调 LLM）。
// 防滥用（白名单制）：DRAW_WHITELIST_QQ 白名单，群聊私聊一律校验（画图是真实成本，
// 私聊也要防刷）；空名单全拒（安全默认）；未命中静默忽略——不回任何话，不暴露
// 功能存在，防探测。名单内用户空 prompt 时回用法提示（对可信用户保持友好）。
// handle 主链：白名单校验 → 空 prompt 用法提示 → 先回「在画了」（出图实测 20-70s，
// 先给个回应垫住体验）→ generateImage → 图片段出站 + 占位回存 → 失败兜底文案。
// 出站不经 ctx.reply（它只发文本）：与 chat 的 persistAndSend 同模式直接用 sender +
// appendMessage。OneBot message 数组段原生支持 {type:'image'}，base64:// 前缀直接
// 透传 NapCat——bot 侧零下载零落盘（b64_json 由 imagegen 直接给出）。
// 回存占位：图不进对话上下文（JSONL 只存文本），raw_message 记「[图片] prompt」——
// 后续「刚才画的那张」类追问在 LLM 眼里 bot 曾发过一条与 prompt 相关的图，可接上。
import { config } from '../config.js';
import { matchAt } from '../utils/at.js';
import { extractText } from '../utils/extract-text.js';
import { appendMessage } from '../store/message-store.js';
import { sendGroup, sendPrivate } from '../sender/sender.js';
import { generateImage } from '../imagegen.js';
import { logger } from '../utils/logger.js';

const DRAW_FAIL_REPLY = '呜，本鱼把颜料打翻了，画失败了，再试一次？';

// 「在画了」提示里的 prompt 摘要上限（超长截断加省略号，展示够认出即可）
const SUMMARY_LIMIT = 20;

export default {
  name: 'draw',
  // 触发规则：配置了 key 才生效（同 chat 的 deepseekApiKey 模式，未配置恒不触发）；
  // '/draw' 独词或 '/draw + 空白 + 内容' 命中——'/drawxxx' 不命中（正则边界，防误触），
  // 它会落到 command 走「不认识」分支。群聊不判 @（同 command：match 宽吞防误入
  // chat，@ 门控在 handle 开头）
  match(event) {
    if (config.imageApiKey === '') return false;
    return /^\/draw(\s|$)/.test(extractText(event));
  },

  async handle(ctx) {
    const { event, sessionKey } = ctx;

    // 群聊 @ 门控（同 command）：未 @ 本鱼 → 静默。白名单内也不例外——寻址未明确
    // 不动笔画图，与白名单未命中的静默合流为同一种「装没听见」
    if (event.message_type === 'group' && !matchAt(event)) {
      logger.info(`[draw] ${sessionKey} 群聊 /draw 未 @ 本鱼，静默忽略`);
      return;
    }

    // 白名单：群聊私聊一律校验（画图是真实成本，私聊同样防刷）；未命中静默（防探测）
    if (!config.drawWhitelist.includes(String(event.user_id))) {
      logger.info(`[draw] ${sessionKey} 用户 ${event.user_id} 不在绘图白名单，静默忽略`);
      return;
    }

    const prompt = extractText(event).replace(/^\/draw\s*/, '').trim();
    if (prompt === '') {
      await ctx.reply('用法：/draw 要本鱼画的内容');
      return;
    }

    // 出图要 20-70 秒：先回一句垫住体验（经 ctx.reply：回存 bot 行 + 队列出站）
    const summary = prompt.length > SUMMARY_LIMIT ? `${prompt.slice(0, SUMMARY_LIMIT)}…` : prompt;
    await ctx.reply(`收到～本鱼在画「${summary}」啦，稍等哦`);

    try {
      const { b64 } = await generateImage(prompt);

      // 占位回存：图不进上下文，占位文本让后续追问可接上（行形状与 dispatcher 的
      // ctx.reply bot 行一致：秒级 time、bot:true、无 message_id）
      appendMessage({
        sessionKey,
        time: Math.floor(Date.now() / 1000),
        message_type: event.message_type,
        ...(event.group_id !== undefined ? { group_id: event.group_id } : {}),
        user_id: event.user_id,
        raw_message: `[图片] ${prompt}`,
        bot: true,
      });

      // 图片段出站：OneBot 数组消息段，base64:// 前缀直接透传 NapCat（每条独立过
      // sender 1s 队列节流）
      const segments = [{ type: 'image', data: { file: `base64://${b64}` } }];
      if (event.message_type === 'group') sendGroup(event.group_id, segments);
      else sendPrivate(event.user_id, segments);
    } catch (err) {
      logger.warn(`[draw] 生成失败（${sessionKey}）: ${err.message}`);
      await ctx.reply(DRAW_FAIL_REPLY);
    }
  },
};
