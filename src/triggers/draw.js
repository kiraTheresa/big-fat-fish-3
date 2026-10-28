// L3 触发器：/draw 文生图（首次图像生成能力，上游走老张中转，见 src/imagegen.js）。
// 注册顺序 ping → draw → command → chat（index.js）：command 的 match 是「'/' 开头就吃」，
// draw 必须排在它前面——否则 /draw 永远收到「本鱼不认识这个指令」；命中即停保证
// /draw 不会误入 chat 白白调一次 LLM。
// 群聊 @ 门控（同 command 的指令寻址制）：群聊 /draw 须 @ 本鱼，裸发一律静默（与
// 指令寻址规则一致）；私聊免 @。match 仍宽吞 /^\/draw(\s|$)/，@ 判定在 handle
// 开头（未 @ 的 '/draw' 也不落入 chat 白调 LLM）。绘图向所有用户开放。
// handle 主链：空 prompt 用法提示 → 先回「在画了」→ generateImage → 图片段出站
// + 占位回存 → 失败兜底文案。
// 出站不经 ctx.reply（它只发文本）：与 chat 的 persistAndSend 同模式直接用 sender +
// appendMessage。OneBot message 数组段原生支持 {type:'image'}，base64:// 前缀直接
// 透传 NapCat——bot 侧零下载零落盘（b64_json 由 imagegen 直接给出）。
// 回存占位：图不进对话上下文（JSONL 只存文本），raw_message 记「[图片] prompt」——
// 后续「刚才画的那张」类追问在 LLM 眼里 bot 曾发过一条与 prompt 相关的图，可接上。
import { config } from '../config.js';
import { matchAt } from '../utils/at.js';
import { extractText } from '../utils/extract-text.js';
import { deliverGeneratedImage } from '../tools/deliver-image.js';
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

    // 群聊未 @ 本鱼时静默；私聊直接使用。
    if (event.message_type === 'group' && !matchAt(event)) {
      logger.info(`[draw] ${sessionKey} 群聊 /draw 未 @ 本鱼，静默忽略`);
      return;
    }

    const prompt = extractText(event).replace(/^\/draw\s*/, '').trim();
    if (prompt === '') {
      await ctx.reply('用法：/draw 要本鱼画的内容');
      return;
    }

    // 出图要 20-70 秒：先回一句垫住体验（经 ctx.reply：回存 bot 行 + 队列出站）
    await ctx.activateMemory?.();
    const summary = prompt.length > SUMMARY_LIMIT ? `${prompt.slice(0, SUMMARY_LIMIT)}…` : prompt;
    await ctx.reply(`收到～本鱼在画「${summary}」啦，稍等哦`);

    try {
      const { b64 } = await generateImage(prompt, { sessionKey });

      deliverGeneratedImage(ctx, b64, prompt);
    } catch (err) {
      logger.warn(`[draw] 生成失败（${sessionKey}）: ${err.message}`);
      await ctx.reply(err.name === 'UsageLimitError' ? `本鱼暂时不能画图：${err.message}。` : DRAW_FAIL_REPLY);
    }
  },
};
