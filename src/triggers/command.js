// L3 触发器：指令（add-self-evolving-persona spec「指令触发器」）。
// '/' 前缀指令集（指令词小写化，/HELP 与 /help 等价）：
//   所有人：/help /status /persona /memory /remember
//   管 理：/persona reset /reset /history
// 权限矩阵：私聊全放行；群聊管理指令需 user_id ∈ config.adminQq 白名单，
//   未配置 ADMIN_QQ（空数组）时群聊管理指令一律拒绝（安全默认，includes 恒 false）。
// 注册顺序 ping → command → chat（index.js）：命中即停，指令消息不会落入 chat 调 LLM。
// 回复只经 ctx.reply() 交给发送层；所有存储操作走各 store 的既有串行化与容错。
import { config } from '../config.js';
import { extractText } from '../utils/extract-text.js';
import { appendMemory, getPersona, readHistory, resetPersona } from '../store/persona-store.js';
import { readState, updateState } from '../store/session-state.js';
import { readUsageStats } from '../store/usage-store.js';
import { readMessagesSince } from '../store/message-store.js';

// /persona /memory 展示上限（字符）：超长截断保留尾部并注明——人设经离线提炼演化后
// 变长，最新的设定/记忆追加在文件尾部，展示尾部信息量最大
const MAX_SHOW_CHARS = 1200;

const NO_PERMISSION_REPLY = '这条指令只有管理员可以用哦';
const UNKNOWN_REPLY = '本鱼不认识这个指令哦，发 /help 看看本鱼都会什么';

// 管理权限判断（内部函数）：私聊全放行；群聊要求发送者 QQ 在 adminQq 白名单内。
// config.adminQq 为空数组（未配置）时 includes 恒 false → 群聊管理指令一律拒绝。
function isAdmin(event) {
  if (event.message_type === 'private') return true;
  return config.adminQq.includes(String(event.user_id));
}

// 超长文本截断保留尾部并注明（label 用于注明被截的是人设还是记忆）
function tailClip(text, label) {
  if (text.length <= MAX_SHOW_CHARS) return text;
  return `（${label}太长了，只展示最近的部分）\n${text.slice(-MAX_SHOW_CHARS)}`;
}

// 毫秒时间戳 → YYYY-MM-DD HH:mm（本地时区，与 persona-store 审计行同风格）
function formatMs(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- /help：全部指令 + 一句话说明（管理指令标注权限） ----
async function replyHelp(ctx) {
  const lines = [
    '本鱼会的指令：',
    '/help - 看看本鱼都会什么',
    '/status - 人设记忆大小、用量与待提炼状态',
    '/persona - 查看当前人设（管理员可用 /persona reset 重置）',
    '/memory - 查看本鱼记住了什么',
    '/remember <内容> - 让本鱼记住一件事',
    '/reset - 清空上下文从头开始聊（管理员）',
    '/history - 最近的人设变动审计（管理员）',
  ];
  await ctx.reply(lines.join('\n'));
}

// ---- /status：人设/记忆字节数 + resetAt 是否生效 + 用量汇总 + 未提炼条数 ----
async function replyStatus(ctx) {
  const { sessionKey } = ctx;
  const persona = await getPersona(sessionKey);
  const state = await readState(sessionKey);
  const usage = await readUsageStats(sessionKey);
  // 未提炼条数：distillMark 水位之后的消息尾部最多 200 条（水位未置则全量统计）
  const undistilled = (await readMessagesSince(sessionKey, state.distillMark ?? 0, 200)).length;
  const lines = [
    `人设 ${Buffer.byteLength(persona.character, 'utf8')} 字节，记忆 ${Buffer.byteLength(persona.memory, 'utf8')} 字节`,
    // resetAt 为秒级（与消息 JSONL 的 time 同量纲），formatMs 收毫秒 → 展示时 ×1000
    state.resetAt ? `上下文重置于 ${formatMs(state.resetAt * 1000)} 生效中` : '上下文未重置',
    `LLM 用量：${usage.calls} 次调用，共 ${usage.totalTokens} tokens（缓存命中 ${usage.cacheHitTokens}）`,
    `待提炼消息 ${undistilled} 条`,
  ];
  await ctx.reply(lines.join('\n'));
}

// ---- /persona：无参数查看 character.md 全文；参数 reset（大小写不敏感）→ 管理指令 ----
async function replyPersona(ctx) {
  const { character } = await getPersona(ctx.sessionKey);
  await ctx.reply(tailClip(character, '人设'));
}

// ---- /persona reset（管理）：恢复种子人设 + 审计（appendMemory 后的临时记忆一并清空） ----
async function doPersonaReset(ctx) {
  if (!isAdmin(ctx.event)) {
    await ctx.reply(NO_PERMISSION_REPLY);
    return;
  }
  const ok = await resetPersona(ctx.sessionKey);
  await ctx.reply(ok ? '人设已经恢复成最初的大肥鱼啦' : '呜，重置失败了，再试一次？');
}

// ---- /memory：查看 memory.md；空则提示暂无 ----
async function replyMemory(ctx) {
  const { memory } = await getPersona(ctx.sessionKey);
  if (memory === '') {
    await ctx.reply('本鱼还没有记忆，用 /remember 教本鱼一件事吧');
    return;
  }
  await ctx.reply(tailClip(memory, '记忆'));
}

// ---- /remember <内容>：原话即时追加 memory.md（不经 LLM，零成本零延迟） ----
async function doRemember(ctx, content) {
  if (content === '') {
    await ctx.reply('用法：/remember 要本鱼记住的事情');
    return;
  }
  // 昵称缺省回退 user_id（与 chat.js 的说话人前缀同约定）
  const speaker = ctx.event.sender?.nickname ?? ctx.event.user_id;
  const ok = await appendMemory(ctx.sessionKey, speaker, content);
  await ctx.reply(ok ? '本鱼记住啦～' : '呜，没记住，再试一次？');
}

// ---- /reset（管理）：置 resetAt 水位，历史读取自此重新开始（不删 JSONL） ----
async function doReset(ctx) {
  if (!isAdmin(ctx.event)) {
    await ctx.reply(NO_PERMISSION_REPLY);
    return;
  }
  // 量纲约定：消息 JSONL 的 time 是秒级，resetAt 存同量纲秒级时间戳——chat.js 按
  // rec.time < resetAt 过滤，若误存毫秒（Date.now()）会把 reset 后的所有历史恒滤掉
  const ok = await updateState(ctx.sessionKey, { resetAt: Math.floor(Date.now() / 1000) });
  await ctx.reply(ok ? '上下文已清空，咱们从头开始聊～' : '呜，重置失败了，再试一次？');
}

// ---- /history（管理）：审计日志尾部 5 条（每条一行：时间 + kind + summary） ----
async function replyHistory(ctx) {
  if (!isAdmin(ctx.event)) {
    await ctx.reply(NO_PERMISSION_REPLY);
    return;
  }
  const records = await readHistory(ctx.sessionKey, 5);
  if (records.length === 0) {
    await ctx.reply('还没有任何审计记录');
    return;
  }
  const lines = records.map((rec) => `[${formatMs(rec.time)}] ${rec.kind} ${rec.summary ?? ''}`);
  await ctx.reply(`最近 ${records.length} 条审计：\n${lines.join('\n')}`);
}

export default {
  name: 'command',
  // 触发规则（spec）：extractText 后内容以 '/' 开头（'/' 单独一个字符同样命中——
  // 命中即停可避免它落入 chat 白白调一次 LLM，是否执行指令在 handle 内判定）
  match(event) {
    return extractText(event).startsWith('/');
  },

  async handle(ctx) {
    const text = extractText(ctx.event);
    const body = text.slice(1).trim();

    // '/' 单独一个字符（如群聊 @bot 后只发了条斜杠）→ 指令词为空：选择静默忽略不回复。
    // 若按未知指令回指引，@bot 的空内容消息反而会被骚扰式回应；宁可装没听见。
    if (body === '') return;

    // 指令词 = '/' 后第一段（小写化）；参数 = 剩余文本 trim（多空白段归一为单空格）
    const [rawWord, ...rest] = body.split(/\s+/);
    const word = rawWord.toLowerCase();
    const args = rest.join(' ').trim();

    switch (word) {
      case 'help':
        return replyHelp(ctx);
      case 'status':
        return replyStatus(ctx);
      case 'persona':
        // 参数 reset（大小写不敏感）→ 管理指令；无参数/其他参数 → 查看人设（多余参数忽略）
        return args.toLowerCase() === 'reset' ? doPersonaReset(ctx) : replyPersona(ctx);
      case 'memory':
        return replyMemory(ctx);
      case 'remember':
        return doRemember(ctx, args);
      case 'reset':
        return doReset(ctx);
      case 'history':
        return replyHistory(ctx);
      default:
        return ctx.reply(UNKNOWN_REPLY);
    }
  },
};
