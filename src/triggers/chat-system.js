// system prompt 组装（upgrade-chat-pipeline「system 动态尾部」「身份锚定与群/私双套
// 规则」）：固定前缀 + 动态尾部。前缀（character → ## 记忆 → memory → ## 行为规则
// （按 isGroup 二选一）→ ## 身份与消息格式）在同一会话内逐字节相同才能命中 DeepSeek
// 上下文缓存（prompt_cache_hit_tokens 可观测），一切随时间/场景变化的内容必须后置到
// 最尾部。纯函数模块：不 import config、不触碰存储——scene 由调用方（chat.js）注入，
// 测试可传固定时间，不依赖真实时钟。
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 本地时间 → 'YYYY-MM-DD HH:mm（周X）'。为什么不用 toLocaleString：其输出随运行环境
// locale/时区漂移，prompt 需要的是逐次可预期的固定形状
export function formatLocalTime(nowMs) {
  const d = new Date(nowMs);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${ymd} ${hm}（${WEEKDAYS[d.getDay()]}）`;
}

// 静默时长人性化文案。量纲陷阱：lastTimeSec 是 OneBot 秒级时间戳（入站 event.time 与
// bot 行回存 time 同量纲），nowMs 是 Date.now() 毫秒——必须先统一到秒再相减，直接
// 相减会差 1000 倍。负差值（时钟回拨）落入 <60 档报「刚刚还在聊」，语义可接受
export function describeSilence(lastTimeSec, nowMs) {
  if (lastTimeSec === null) return '这是新对话的开始';
  const diffSec = Math.floor(nowMs / 1000) - lastTimeSec;
  if (diffSec < 60) return '刚刚还在聊';
  if (diffSec < 3600) return `距上一条消息约 ${Math.floor(diffSec / 60)} 分钟`;
  if (diffSec < 86400) return `距上一条消息约 ${Math.floor(diffSec / 3600)} 小时`;
  return `距上一条消息约 ${Math.floor(diffSec / 86400)} 天`;
}

// 动态尾部：当前时间/场景/静默时长三行，永远位于 system 最尾（缓存前缀稳定原则）
export function buildSceneTail(scene) {
  const { isGroup, nowMs, lastTimeSec } = scene;
  return [
    '## 当前场景',
    '',
    `- 当前时间：${formatLocalTime(nowMs)}`,
    `- 场景：${isGroup ? '群聊' : '私聊'}`,
    `- 静默时长：${describeSilence(lastTimeSec, nowMs)}`,
  ].join('\n');
}

// 行为规则两套（spec「身份锚定与群/私双套规则」）：按 scene.isGroup 二选一硬编码在
// 组装层——提炼器只演化 character.md，碰不到这里，底线规则不会随 persona 演化漂移或
// 被删。两套共有的底线（简短口语化、无 Markdown、分段连发约定）保留既有语义；
// 差异在节奏姿态：群聊人多要克制不刷屏，私聊一对一可以放开了多聊几句。
// 分段约定与出口加工链的 split 模块（chat-reply-chain.js）同气连枝——LLM 用换行或
// || 表达「连发意愿」，出口对两种分隔符一视同仁地拆分落地（0.9.3 起换行为首选写法：
// 真机实测 LLM 对换行的遵从度远高于自造符号 ||）。prompt 里写死两种写法、不联动
// config.separator：约定与解析规则不因配置漂移互相脱钩
const GROUP_RULES = [
  '- 用简短口语化的中文回复，不要使用 Markdown 格式',
  '- 群聊人多，回复要克制、不刷屏，别把话都说完',
  '- 想连发几条短消息时用换行分隔（每行会作为一条独立消息发出），也可以用 ||；不需要拆就输出一条',
];

const PRIVATE_RULES = [
  '- 用简短口语化的中文回复，不要使用 Markdown 格式',
  '- 一对一私聊，可以聊得更展开、多接几句',
  '- 想连发几条短消息时用换行分隔（每行会作为一条独立消息发出），也可以用 ||；不需要拆就输出一条',
];

// 身份与消息格式（身份锚定段）：钉死「你是谁」与「如何解读历史消息格式」。群聊
// 历史的 user 内容由 chat.js 拼成「昵称: 正文」（私聊无前缀）——前缀语义必须在这里
// 讲清，否则 LLM 会把群友名字当成消息内容复读。本段内容不随 scene 变化：群/私两种
// 格式说明都写死在同一段里，保证各自的固定前缀逐字节稳定（缓存命中前提）
const IDENTITY_LINES = [
  '- 你是群里的吉祥物大肥鱼，自称「本鱼」',
  '- 群聊历史消息里「昵称: 」开头的前缀是群友的名字，不是消息内容的一部分；私聊没有这个前缀',
];

// 完整 system：固定前缀 + 空行衔接 + 动态尾部。前缀结构（spec MODIFIED「AIChat system
// 组装」明文顺序）：character → ## 记忆 → memory → ## 行为规则（场景二选一）→
// ## 身份与消息格式；同一会话内 isGroup 恒定 → 前缀逐字节稳定命中 DeepSeek 上下文缓存
export function buildSystemPrompt(persona, scene, prompts) {
  const prefix = [
    persona.character,
    '',
    '## 记忆',
    '',
    persona.memory,
    '',
    '## 行为规则',
    '',
    ...(prompts ? [scene.isGroup ? prompts.group : prompts.private] : scene.isGroup ? GROUP_RULES : PRIVATE_RULES),
    '',
    '## 身份与消息格式',
    '',
    ...(prompts ? [prompts.identity, '', '## 工具使用规则', '', prompts.toolRules] : IDENTITY_LINES),
  ].join('\n');
  const values = { time: formatLocalTime(scene.nowMs), scene: scene.isGroup ? '群聊' : '私聊', silence: describeSilence(scene.lastTimeSec, scene.nowMs) };
  const tail = prompts ? prompts.scene.replace(/\{\{(time|scene|silence)\}\}/g, (_, key) => values[key]) : buildSceneTail(scene);
  return `${prefix}\n\n${tail}`;
}
