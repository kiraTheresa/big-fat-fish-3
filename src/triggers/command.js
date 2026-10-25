// L3 触发器：指令（add-self-evolving-persona spec「指令触发器」）。
// 指令注册表化：每个指令是一个 { name, adminOnly, summary, handle } 模块对象，
// 新增指令 = 往 COMMANDS 数组加一项，主流程与 /help 列表自动跟上。以此消除三个坏味道：
// ① /help 手工列表（注册表增删后易漂移）→ 自动生成；② isAdmin 在多个 handler 里
// 重复 → 集中到主流程一处判定；③ switch 随指令数线性增长 → 查表分发。
// 权限矩阵：私聊全放行；群聊 adminOnly 指令需 user_id ∈ config.adminQq 白名单，
// 未配置 ADMIN_QQ（空数组）时群聊管理指令一律拒绝（安全默认，includes 恒 false）。
// 唯一例外：/persona 对所有人开放查看，但其 reset 子操作是管理指令——该模块
// adminOnly: false，reset 分支在 handle 内部自行判管理员（保留原语义与文案）。
// 群聊 @ 门控（指令寻址制）：群聊指令必须 @ 本鱼——未 @ 的 '/' 消息一律静默返回，
// 不回指引不回权限错误（闲聊带 / 文本、多 bot 群裸指令齐响都属越界回应，宁可装
// 没听见）；私聊免 @（无寻址歧义）。match 仍宽吞 '/' 前缀（命中即停防其落入 chat
// 白调 LLM），@ 判定收敛在 handle 开头——与 '/' 空内容静默同一模式。
// 注册顺序 ping → command → chat（index.js）：命中即停，指令消息不会落入 chat 调 LLM。
// 回复只经 ctx.reply() 交给发送层；所有存储操作走各 store 的既有串行化与容错；
// handler 异常不在本模块捕获——dispatcher 对 trigger.handle 已有统一 try/catch 记 ERROR。
import { config } from '../config.js';
import { matchAt } from '../utils/at.js';
import { extractText } from '../utils/extract-text.js';
import { logger } from '../utils/logger.js';
import { appendMemory, getPersona, readHistory, resetPersona } from '../store/persona-store.js';
import { readState, updateState } from '../store/session-state.js';
import { readUsageStats } from '../store/usage-store.js';
import { readMessagesSince } from '../store/message-store.js';
import { getVersion } from '../version.js';

// /persona /memory 展示上限（字符）：超长截断保留尾部并注明——人设经离线提炼演化后
// 变长，最新的设定/记忆追加在文件尾部，展示尾部信息量最大
const MAX_SHOW_CHARS = 1200;

const NO_PERMISSION_REPLY = '这条指令只有管理员可以用哦';
const UNKNOWN_REPLY = '本鱼不认识这个指令哦，发 /help 看看本鱼都会什么';

// 管理权限判断（内部函数）：私聊全放行；群聊要求发送者 QQ 在 adminQq 白名单内。
// 只有两处调用：主流程的 adminOnly 集中判定、/persona reset 分支的内部判定
// （后者是该子操作的管理属性所致，属注册表契约外的唯一例外）。
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

// ---- 指令注册表：/help 按此顺序自动生成条目，数组顺序即展示顺序 ----
// 模块契约：name 指令词（小写、查表精确匹配）/ adminOnly 群聊是否需要管理员 /
// summary 一句话说明（/help 自动生成用，须非空）/ handle(ctx, args) 具体执行
// （args 为指令词之后的参数文本，已 trim；无参指令忽略之）。
export const COMMANDS = [
  {
    name: 'help',
    adminOnly: false,
    summary: '看看本鱼都会什么',
    // 列表自动生成：遍历注册表拼条目、adminOnly 追加权限标注——
    // 注册表增删指令后 /help 无需手动同步，永不漂移
    async handle(ctx) {
      const lines = ['本鱼会的指令：'];
      for (const cmd of COMMANDS) {
        lines.push(`/${cmd.name} - ${cmd.summary}${cmd.adminOnly ? '（管理员）' : ''}`);
      }
      await ctx.reply(lines.join('\n'));
    },
  },
  {
    name: 'status',
    adminOnly: false,
    summary: '人设记忆大小、用量与待提炼状态',
    // 人设/记忆字节数 + resetAt 是否生效 + 用量汇总 + 未提炼条数
    async handle(ctx) {
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
    },
  },
  {
    name: 'persona',
    adminOnly: false,
    summary: '查看当前人设（管理员可用 /persona reset 重置）',
    // 特殊指令：无参数/其他参数 → 查看人设（所有人，多余参数忽略）；参数 reset
    // （大小写不敏感）→ 管理操作。因查看对所有人开放，模块 adminOnly: false，
    // reset 分支在内部自行判管理员（保留原 NO_PERMISSION_REPLY 文案）
    async handle(ctx, args) {
      if (args.toLowerCase() !== 'reset') {
        const { character } = await getPersona(ctx.sessionKey);
        await ctx.reply(tailClip(character, '人设'));
        return;
      }
      if (!isAdmin(ctx.event)) {
        await ctx.reply(NO_PERMISSION_REPLY);
        return;
      }
      // 恢复种子人设 + 审计（appendMemory 后的临时记忆一并清空）
      const ok = await resetPersona(ctx.sessionKey);
      await ctx.reply(ok ? '人设已经恢复成最初的大肥鱼啦' : '呜，重置失败了，再试一次？');
    },
  },
  {
    name: 'memory',
    adminOnly: false,
    summary: '查看本鱼记住了什么',
    // 查看 memory.md；空则提示暂无
    async handle(ctx) {
      const { memory } = await getPersona(ctx.sessionKey);
      if (memory === '') {
        await ctx.reply('本鱼还没有记忆，用 /remember 教本鱼一件事吧');
        return;
      }
      await ctx.reply(tailClip(memory, '记忆'));
    },
  },
  {
    name: 'remember',
    adminOnly: false,
    summary: '让本鱼记住一件事',
    // 原话即时追加 memory.md（不经 LLM，零成本零延迟）
    async handle(ctx, content) {
      if (content === '') {
        await ctx.reply('用法：/remember 要本鱼记住的事情');
        return;
      }
      // 昵称缺省回退 user_id（与 chat.js 的说话人前缀同约定）
      const speaker = ctx.event.sender?.nickname ?? ctx.event.user_id;
      const ok = await appendMemory(ctx.sessionKey, speaker, content);
      await ctx.reply(ok ? '本鱼记住啦～' : '呜，没记住，再试一次？');
    },
  },
  {
    name: 'reset',
    adminOnly: true,
    summary: '清空上下文从头开始聊',
    // 置 resetAt 水位，历史读取自此重新开始（不删 JSONL）
    async handle(ctx) {
      // 量纲约定：消息 JSONL 的 time 是秒级，resetAt 存同量纲秒级时间戳——chat.js 按
      // rec.time < resetAt 过滤，若误存毫秒（Date.now()）会把 reset 后的所有历史恒滤掉
      const ok = await updateState(ctx.sessionKey, { resetAt: Math.floor(Date.now() / 1000) });
      await ctx.reply(ok ? '上下文已清空，咱们从头开始聊～' : '呜，重置失败了，再试一次？');
    },
  },
  {
    name: 'history',
    adminOnly: true,
    summary: '最近的人设变动审计',
    // 审计日志尾部 5 条（每条一行：时间 + kind + summary）
    async handle(ctx) {
      const records = await readHistory(ctx.sessionKey, 5);
      if (records.length === 0) {
        await ctx.reply('还没有任何审计记录');
        return;
      }
      const lines = records.map((rec) => `[${formatMs(rec.time)}] ${rec.kind} ${rec.summary ?? ''}`);
      await ctx.reply(`最近 ${records.length} 条审计：\n${lines.join('\n')}`);
    },
  },
  {
    name: 'version',
    adminOnly: false,
    summary: '看看本鱼的版本',
    // 版本号读 CHANGELOG.md 顶部（见 src/version.js）；读取失败时 getVersion
    // 返回 'unknown'，直接拼进回复即天然兜底，无需额外分支
    async handle(ctx) {
      await ctx.reply(`本鱼版本：${await getVersion()}`);
    },
  },
];

export default {
  name: 'command',
  // 触发规则（spec）：extractText 后内容以 '/' 开头（'/' 单独一个字符同样命中——
  // 命中即停可避免它落入 chat 白白调一次 LLM）。群聊不判 @：match 刻意宽吞（未 @
  // 的 '/xxx 喊名' 也不得经 nameCall 误入 LLM），@ 门控与「是否回应」统一在 handle
  // 开头判定（见下）
  match(event) {
    return extractText(event).startsWith('/');
  },

  async handle(ctx) {
    // 群聊 @ 门控：未 @ 本鱼 → 静默返回。已知/未知/无权限一律不回——越界回应
    // （闲聊里的 / 文本被回「不认识」、多 bot 群裸指令齐响、非管理员试探被回
    // 权限错误）在此统一掐掉；管理员未 @ 同样不执行（寻址未明确，宁可漏响应
    // 不乱响应）
    if (ctx.event.message_type === 'group' && !matchAt(ctx.event)) {
      logger.info(`[command] ${ctx.sessionKey} 群聊指令未 @ 本鱼，静默忽略`);
      return;
    }

    const text = extractText(ctx.event);
    const body = text.slice(1).trim();

    // '/' 单独一个字符（如群聊 @bot 后只发了条斜杠）→ 指令词为空：选择静默忽略不回复。
    // 若按未知指令回指引，@bot 的空内容消息反而会被骚扰式回应；宁可装没听见。
    if (body === '') return;

    // 指令词 = '/' 后第一段（小写化）；参数 = 剩余文本 trim（多空白段归一为单空格）
    const [rawWord, ...rest] = body.split(/\s+/);
    const word = rawWord.toLowerCase();
    const args = rest.join(' ').trim();

    // 查注册表：未命中回指引
    const cmd = COMMANDS.find((c) => c.name === word);
    if (cmd === undefined) {
      await ctx.reply(UNKNOWN_REPLY);
      return;
    }

    // 权限集中判定（全模块唯一一处，/persona reset 内部判定除外）：
    // adminOnly 指令群聊要求管理员，私聊全放行
    if (cmd.adminOnly && !isAdmin(ctx.event)) {
      await ctx.reply(NO_PERMISSION_REPLY);
      return;
    }

    await cmd.handle(ctx, args);
  },
};
