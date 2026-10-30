import { config } from '../config.js';
import { buildSystemPrompt } from '../triggers/chat-system.js';
import { toolAvailability, toolDefinitions } from '../tools/registry.js';
import { chatStreamOptions } from '../utils/chat-stream.js';
import { historyText } from '../utils/history-text.js';
import { describeMemeSource } from '../memes/context.js';

export function buildChatRequest(settings, { persona, records = [], state = {}, event, text, nowMs = Date.now(), systemSuffix = '' }) {
  const isGroup = event.message_type === 'group';
  const context = settings.context;
  const previous = records.filter((rec) => event.message_id === undefined || rec.message_id !== event.message_id);
  const effectivePersona = { character: persona?.character ?? settings.prompts.seed, memory: context.injectMemory ? persona?.memory ?? '' : '' };
  const memeSource = settings.tools.save_meme?.enabled ? describeMemeSource(event, records) : '';
  const system = buildSystemPrompt(effectivePersona, { isGroup, nowMs, lastTimeSec: previous.at(-1)?.time ?? null }, settings.prompts) + systemSuffix
    + (memeSource ? `\n\n## 本轮表情来源\n${memeSource}\n这只是来源信息，不代表用户要求收藏。以当前用户的要求判断；教这个表情的用途或命名也属于收藏请求。` : '');
  const inspections = previous.map((rec, index) => {
    const raw = historyText(rec);
    const originalRaw = typeof rec.raw_message === 'string' ? rec.raw_message : '';
    const image = /\[CQ:image[\s,\]]|^\[图片\]/.test(originalRaw) || rec.message?.some?.((s) => s?.type === 'image');
    const reason = state.resetAt !== undefined && rec.time < state.resetAt ? '早于会话重置'
      : context.maxAgeMinutes && rec.time * 1000 < nowMs - context.maxAgeMinutes * 60000 ? '超出时间范围'
        : rec.bot && !context.assistant ? '未选择机器人回复'
          : !rec.bot && !context.users ? '未选择用户消息'
            : !rec.bot && context.onlySpeaker && String(rec.user_id) !== String(event.user_id) ? '其他发言者'
              : image && !context.image ? '未选择图片相关消息'
                : !image && !context.text ? '未选择文本消息'
                  : context.excludeCommands && /^\s*(?:\[CQ:at[^\]]*\]\s*)*\//.test(originalRaw) ? '命令消息' : '';
    return { index, role: rec.bot ? 'assistant' : 'user', type: image ? 'image-placeholder' : 'text', content: !rec.bot && isGroup ? `${rec.sender?.nickname ?? rec.user_id}: ${raw}` : raw, reason };
  });
  const eligible = inspections.filter((item) => !item.reason);
  const count = eligible.length;
  for (const item of eligible.slice(0, Math.max(0, count - context.historyLimit))) item.reason = '超过历史条数';
  const limited = eligible.filter((item) => !item.reason);
  let remaining = context.budgetBytes - Buffer.byteLength(system);
  let full = false;
  for (const item of [...limited].reverse()) {
    const bytes = Buffer.byteLength(item.content);
    if (full || bytes > remaining) { item.reason = '超过字节预算'; full = true; }
    else remaining -= bytes;
  }
  const kept = inspections.filter((item) => !item.reason).map(({ role, content }) => ({ role, content }));
  const speaker = event.sender?.nickname ?? event.user_id;
  const messages = [{ role: 'system', content: system }, ...kept, { role: 'user', content: isGroup ? `${speaker}: ${text}` : text }];
  const tools = toolDefinitions(settings, String(event.user_id));
  return {
    request: { model: config.deepseekModel, messages, ...chatStreamOptions(config.chatStream), ...(tools.length ? { tools } : {}) },
    inspections, summary: { candidates: inspections.length, filtered: count, limited: limited.length, sent: kept.length, systemBytes: Buffer.byteLength(system), historyBytes: kept.reduce((n, m) => n + Buffer.byteLength(m.content), 0), budgetBytes: context.budgetBytes, candidateLimit: 1000, budgetMeaning: 'system + 历史文字的字节粗算；不含本轮输入、图片、工具定义及协议开销，不是 token 上限' },
    availability: toolAvailability(settings, String(event.user_id)),
  };
}
