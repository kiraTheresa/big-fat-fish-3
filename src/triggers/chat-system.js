// system prompt 组装（upgrade-chat-pipeline「system 动态尾部」「身份锚定与群/私双套
// 规则」）：固定前缀 + 动态尾部。前缀（character → ## 记忆 → memory → ## 行为规则
// （按 isGroup 二选一）→ ## 身份与消息格式）在同一会话内逐字节相同才能命中 DeepSeek
// 上下文缓存（prompt_cache_hit_tokens 可观测），一切随时间/场景变化的内容必须后置到
// 最尾部。纯函数模块：只共享默认模板，不 import config、不触碰存储——scene 由调用方（chat.js）注入，
// 测试可传固定时间，不依赖真实时钟。
import { GROUP_RULES, PRIVATE_RULES, IDENTITY_LINES, TOOL_RULES, SCENE_TEMPLATE, SYSTEM_TEMPLATE } from '../prompt/defaults.js';

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
  return renderScene(SCENE_TEMPLATE, scene);
}

// 未传发布配置时也使用同一份默认规则，避免两套提示词随迭代漂移。
// 完整 system：固定前缀 + 空行衔接 + 动态尾部。前缀结构（spec MODIFIED「AIChat system
// 组装」明文顺序）：character → ## 记忆 → memory → ## 行为规则（场景二选一）→
// ## 身份与消息格式；同一会话内 isGroup 恒定 → 前缀逐字节稳定命中 DeepSeek 上下文缓存
export function buildSystemPrompt(persona, scene, prompts) {
  const sections = {
    character: persona.character,
    memory: persona.memory,
    behavior: prompts ? (scene.isGroup ? prompts.group : prompts.private) : (scene.isGroup ? GROUP_RULES : PRIVATE_RULES).join('\n'),
    identity: prompts ? prompts.identity : IDENTITY_LINES.join('\n'),
    toolRules: prompts ? prompts.toolRules : TOOL_RULES,
  };
  // One replacement pass: template-like text inside persona/memory remains literal data.
  const prefix = SYSTEM_TEMPLATE.replace(/\{\{(character|memory|behavior|identity|toolRules)\}\}/g, (_, key) => sections[key]);
  const tail = renderScene(prompts ? prompts.scene : SCENE_TEMPLATE, scene);
  return `${prefix}\n\n${tail}`;
}

function renderScene(template, scene) {
  const values = { time: formatLocalTime(scene.nowMs), scene: scene.isGroup ? '群聊' : '私聊', silence: describeSilence(scene.lastTimeSec, scene.nowMs) };
  return template.replace(/\{\{(time|scene|silence)\}\}/g, (_, key) => values[key]);
}
