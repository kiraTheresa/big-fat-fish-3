// L3 触发器：AIChat（MVP 起源于 add-aichat-mvp spec，行为演进归 add-self-evolving-persona，
// 触发组合/回复加工归 upgrade-chat-pipeline）。
// bot-core-design §4 的落地：「LLM 调用塞进某个触发器的 handle 内部，架构不变」。
// 触发规则（match）：
//   - 未配置 DEEPSEEK_API_KEY → 恒不触发（不吞私聊消息）；
//   - 私聊 → 全量触发（ping 等更早注册的触发器靠「命中即停」优先）；
//   - 群聊 → 入口条件组合器（chat-conditions.js）：任一开关开启且命中的条件模块即触发。
// handle：提取 text 段为内容（空则忽略）→ 会话冷却检查 → 并行读 persona 与会话状态 →
//   读 JSONL 上下文（bot 行→assistant，入站→user，当前消息按 message_id 去重；/reset
//   水位 resetAt 之前的行入站与 bot 同滤）→ system 组装（chat-system.js：character →
//   ## 记忆 → memory → ## 行为规则 固定前缀 + ## 当前场景 动态尾部，前缀逐字节稳定
//   以吃 DeepSeek 上下文缓存）→ 预算裁剪（chat-context.js：budgetBytes 封顶
//   system+历史字节总量，超出的最旧历史先裁，与 20 条上限谁更紧听谁的）→ 调 LLM →
//   出口加工链（chat-reply-chain.js：随机延迟、
//   || 分段连发）→ 存储合并 + 逐条发送；
//   所有模型请求在统一 gateway 记录成功/失败及用量；
//   LLM 失败/超时 → 固定兜底文案 + WARN（兜底不走加工链，告警类消息无需拟人延迟）。
// 识图分流（upgrade-vision）：消息带图（或群聊同用户时间窗内近图）→「在看」提示 →
//   现拉 base64（不落盘）→ 最后一条 user content 换块数组、模型换 deepseek-flash；
//   任一步失败回退纯文本路径（看图是增强不是依赖）；DEEPSEEK_VISION_MODEL 空 = 关闭。
import { config } from '../config.js';
import { randomUUID } from 'node:crypto';
import { getPublishedPrompt } from '../prompt/store.js';
import { buildChatRequest } from '../prompt/builder.js';
import { POKE_SYSTEM_TEMPLATE } from '../prompt/defaults.js';
import { runToolConversation } from '../prompt/runner.js';
import { saveRun } from '../prompt/traces.js';
import { deliverGeneratedImage } from '../tools/deliver-image.js';
import { appendMessage, readRecentMessages } from '../store/message-store.js';
import { getPersona } from '../store/persona-store.js';
import { readState } from '../store/session-state.js';
import { extractText } from '../utils/extract-text.js';
import { matchAt } from '../utils/at.js';
import { extractImages } from '../utils/extract-images.js';
import { fetchImageAsB64, mimeOfB64 } from '../utils/fetch-image.js';
import { callApi } from '../connection/onebot.js';
import { logger } from '../utils/logger.js';
import { matchGroupChat } from './chat-conditions.js';
import { chatReplyChain } from './chat-reply-chain.js';
import { sendGroup, sendPrivate } from '../sender/sender.js';

const FALLBACK_REPLY = 'AI 开小差了，稍后再试～';
const LOOKING_IMAGE_REPLY = '本鱼凑近看看这张图哦，稍等～';

// 识图图源判定：@ 消息自带图优先（段内 URL 直接可用，取第一张——单次一张边界）；
// 无图时群聊查同用户时间窗内最新近图（get_group_msg_history，实测 NapCat
// params { group_id, count }、响应 data.messages[]；私聊历史查询暂不支持——
// get_friend_msg_history 未实测，列入已知行为）。只定 URL 不下载（下载在「在看」
// 提示之后）；无图源 → null。
async function resolveImageUrl(event) {
  const own = extractImages(event);
  if (own.length > 0) return own[0].data.url;
  if (event.message_type !== 'group') return null;
  let history;
  try {
    const data = await callApi('get_group_msg_history', { group_id: event.group_id, count: 20 });
    history = Array.isArray(data?.messages) ? data.messages : [];
  } catch (err) {
    logger.warn(`[chat] 周围图历史查询失败，跳过识图: ${err.message}`);
    return null;
  }
  // 从最新往旧找第一条：同 user_id（String 双侧归一兼容数字/字符串两型，同 matchAt
  // 纪律；bot 出站行天然排除）+ 秒级时间差在窗口内 + 非本条消息
  const windowSec = config.visionImageWindowMs / 1000;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.message_id === event.message_id) continue;
    if (String(msg.user_id) !== String(event.user_id)) continue;
    if (Math.abs(event.time - msg.time) > windowSec) continue;
    const seg = extractImages(msg)[0];
    if (seg !== undefined) return seg.data.url;
  }
  return null;
}

// 会话级冷却表：sessionKey → 上次开始响应的时刻（进程内 Map，重启即清）
const cooldowns = new Map();

export default {
  name: 'chat',
  match(event) {
    if (event.post_type !== 'message') return false;
    if (config.deepseekApiKey === '') return false; // 未配置 LLM：本触发器不生效
    if (event.message_type === 'private') return true;
    // 群聊：条件组合器任一命中即触发（非群聊事件组合器内恒 false）
    return matchGroupChat(event);
  },

  async handle(ctx, { poke = false } = {}) {
    const { event, sessionKey } = ctx;

    const text = extractText(event);
    // @ 本身就是呼唤；保留纯文本提取语义，在对话入口补充动作描述。
    const content = poke ? '[戳一戳] 戳了戳你' : text ||
      (event.message_type === 'group' && matchAt(event) ? '（对方 @ 了你，没有附加文字，请简短回应。）' : '');
    if (content === '') {
      logger.info(`[chat] ${sessionKey} 消息无文本内容，忽略`);
      return;
    }

    // 冷却防刷：窗口内静默跳过（不调 LLM、不回复）。计时在 LLM 调用前 set：
    // 冷却管「开始响应」，出口加工链的随机延迟管「发出节奏」，两者互不干扰
    const last = cooldowns.get(sessionKey) ?? 0;
    if (Date.now() - last < config.behavior.chat.cooldownMs) {
      logger.info(`[chat] 会话 ${sessionKey} 冷却中，跳过`);
      return;
    }
    cooldowns.set(sessionKey, Date.now());
    await ctx.activateMemory?.();

    const version = getPublishedPrompt();
    const settings = version.config;
    const [persona, state, records] = await Promise.all([
      getPersona(sessionKey, settings.prompts.seed), readState(sessionKey), readRecentMessages(sessionKey, 1000),
    ]);
    const isGroup = event.message_type === 'group';
    const systemSuffix = poke ? '\n\n' + POKE_SYSTEM_TEMPLATE.replace('{{prompt}}', () => config.behavior.trigger.poke.prompt) : '';
    const built = buildChatRequest(settings, { persona, records, state, event, text: content, systemSuffix });
    if (poke) {
      delete built.request.tools;
      appendMessage({ sessionKey, time: event.time ?? Math.floor(Date.now() / 1000), message_type: event.message_type,
        ...(isGroup ? { group_id: event.group_id } : {}), user_id: event.user_id, sender: event.sender, raw_message: content });
    }
    const messages = built.request.messages;
    const trace = [];
    const run = { id: randomUUID(), createdAt: Date.now(), source: 'live', kind: 'chat', trigger: poke ? 'poke' : 'message', sessionKey, version: version.number, revision: version.id, trace, summary: built.summary };
    const toolContext = { sessionKey, actorId: String(event.user_id), speaker: String(event.sender?.nickname ?? event.user_id), mode: 'live',
      onImage: (b64, prompt) => deliverGeneratedImage(ctx, b64, prompt) };

    // ---- 识图分流：图源判定 →「在看」提示 → 现拉 base64（不落盘）----
    // 任一步失败（无图源/历史查询挂/下载挂）均 visionB64=null，messages 原样走纯文本——
    // 看图是增强不是依赖。入站 raw_message 本就含 [CQ:image] 痕迹（dispatcher 已落盘），
    // 后续上下文天然知道「发过图」；图本身不进上下文（边界纪律），追问靠首答文字自洽
    let visionB64 = null;
    if (!poke && settings.context.vision && config.deepseekVisionModel !== '') {
      const imageUrl = await resolveImageUrl(event);
      if (imageUrl !== null) {
        await ctx.reply(LOOKING_IMAGE_REPLY); // 过渡提示先出站，赶在拉图/视觉推理前
        try {
          visionB64 = await fetchImageAsB64(imageUrl, config.visionFetchTimeoutMs);
        } catch (err) {
          logger.warn(`[chat] 图片现拉失败，回退纯文本: ${err.message}`);
        }
      }
    }

    // 视觉路径：最后一条 user 的 content 换块数组（text + image_url data URL）。
    // 图只能放 user 消息（实测 system/assistant 带图 400）；历史保持纯文本。
    // plainContent 留作 flash 失败时的还原保底
    const lastUser = messages.at(-1);
    const plainContent = lastUser.content;
    let usedModel = config.deepseekModel;
    if (visionB64 !== null) {
      lastUser.content = [
        { type: 'text', text: plainContent },
        { type: 'image_url', image_url: { url: `data:${mimeOfB64(visionB64)};base64,${visionB64}` } },
      ];
      usedModel = config.deepseekVisionModel;
    }

    // 统一出口：存储职责 + 发送职责。与 dispatcher 的 ctx.reply 分道——ctx.reply 留给
    // ping/command，chat 的出口由加工链驱动，为分段连发（Task 4）预留职责切分：
    //   - 存储：一次 LLM 调用只 appendMessage **一条** bot 行，raw_message 取 LLM
    //     原始输出全文（非分段合并值）——上下文重建为单条 assistant 消息，不碎片化；
    //   - 发送：segments 逐条经 sender（每条独立过 1s 队列节流）；
    //   - 行形状与 dispatcher 的 bot 行回存一致：秒级 time、bot:true、无 message_id。
    const persistAndSend = (rawMessage, segments) => {
      appendMessage({
        sessionKey,
        time: Math.floor(Date.now() / 1000),
        message_type: event.message_type,
        ...(event.group_id !== undefined ? { group_id: event.group_id } : {}),
        user_id: event.user_id,
        raw_message: rawMessage,
        bot: true,
      });
      for (const seg of segments) {
        if (isGroup) sendGroup(event.group_id, seg);
        else sendPrivate(event.user_id, seg);
      }
    };

    try {
      let reply;
      if (visionB64 !== null) {
        try {
          ({ content: reply } = await runToolConversation({ ...built.request, model: usedModel, messages }, settings, { ...toolContext, kind: 'vision' }, { trace }));
        } catch (err) {
          if (err.toolStarted) throw err; // 已执行工具后不能回退重跑，否则可能重复副作用
          // flash 挂了不整个对话兜底：还原纯文本、换 deepseek-chat 重试一次（分流策略拍板）
          logger.warn(`[chat] 视觉模型调用失败，回退纯文本: ${err.message}`);
          usedModel = config.deepseekModel;
        }
      }
      if (reply === undefined) {
        lastUser.content = plainContent; // 还原 string（纯文本路径此赋值恒等，无害）
        ({ content: reply } = await runToolConversation({ ...built.request, messages }, settings, toolContext, { trace }));
      }

      // 出口加工链：LLM 原始输出装入 segments 数组（Task 4 的 split 从这里接管拆分），
      // 各模块按 enabled(config) 自决参与、依序 await 加工（delay 在此吃掉随机时长）
      if (poke) reply = reply.replaceAll('||', ' ').replace(/\s+/g, ' ').trim();
      let segments = [reply];
      for (const mod of chatReplyChain) {
        if (poke) continue; // 戳一戳立即发一条短回复，不引用不存在的消息。
        if (mod.enabled(config)) segments = await mod.run(ctx, segments);
      }
      persistAndSend(reply, segments);
      run.status = 'completed';
      run.content = reply;

    } catch (err) {
      run.status = 'failed';
      run.error = err.message;
      logger.warn(`[chat] LLM 调用失败: ${err.message}`);
      // 兜底文案不是 LLM 输出：不走加工链（不延迟，出错要立刻让人知道），但存储与
      // 发送仍走统一出口（与既有行为等价：回存一条 bot 行 + 发一条）
      const failureReply = err.name === 'UsageLimitError' ? `本鱼暂时不能调用模型：${err.message}。` : FALLBACK_REPLY;
      persistAndSend(failureReply, [failureReply]);
    } finally {
      await saveRun(run).catch((error) => logger.warn(`[prompt] 请求记录保存失败: ${error.code ?? 'storage error'}`));
    }
  },
};
