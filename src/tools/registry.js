import { config } from '../config.js';
import { getRole } from '../platform/permissions.js';
import { getUsagePolicy } from '../platform/usage-policy.js';
import { generateImage } from '../imagegen.js';
import { appendMemory, getPersona } from '../store/persona-store.js';
import { collectFromEvent, sendStoredMeme } from '../memes/service.js';
import { searchMemes } from '../store/meme-library.js';

export const TOOL_PARAMETERS = { draw: 'prompt', remember_fact: 'content', recall_memory: null,
  save_meme: 'description', search_memes: 'query', send_meme: 'id' };
const EFFECTS = { draw: '调用图片 API', remember_fact: '写入当前会话记忆', recall_memory: '读取当前会话记忆',
  save_meme: '收藏当前或引用的表情', search_memes: '搜索当前会话表情库', send_meme: '发送已收藏表情' };
export function toolAvailability(settings, actorId) {
  return Object.entries(settings.tools).map(([name, tool]) => {
    const reason = !tool.enabled ? '已关闭' : actorId && getRole(actorId) === 'blocked' ? '用户已封禁'
      : name === 'draw' && !config.imageApiKey ? '未配置图片 API'
        : name === 'draw' && !getUsagePolicy().features.draw ? '绘图能力被停用' : '';
    return { name, enabled: tool.enabled, available: !reason, reason, effect: EFFECTS[name] ?? name };
  });
}
export function toolDefinitions(settings, actorId) {
  return toolAvailability(settings, actorId).filter((tool) => tool.available).map(({ name }) => {
    const parameter = TOOL_PARAMETERS[name];
    return { type: 'function', function: { name, description: settings.tools[name].description, parameters: {
      type: 'object', properties: parameter ? { [parameter]: { type: 'string', description: settings.tools[name].parameterDescription } } : {},
      required: parameter ? [parameter] : [], additionalProperties: false,
    } } };
  });
}
export function parseToolArguments(name, raw) {
  if (!Object.hasOwn(TOOL_PARAMETERS, name)) throw new Error('未知工具');
  if (typeof raw !== 'string' || raw.length > 20000) throw new Error('工具参数过长或格式不正确');
  let args;
  try { args = JSON.parse(raw); } catch { throw new Error('工具参数不是有效 JSON'); }
  const key = TOOL_PARAMETERS[name];
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== (key ? 1 : 0) || (key && (!Object.hasOwn(args, key) || typeof args[key] !== 'string' || !args[key].trim() || args[key].length > (name === 'draw' ? 4000 : 1000)))) throw new Error('工具参数不符合声明，不能指定其他会话或用户');
  return args;
}
// Both slash commands and natural-language tools use the same image / memory gateways.
export async function executeTool(name, args, { sessionKey, actorId, speaker, memory, mode = 'live', onImage, onImageAttempt, nowMs = Date.now(), event, memeTurn }, settings) {
  if (!toolAvailability(settings, actorId).find((t) => t.name === name)?.available) throw new Error('工具已停用或当前用户不可用');
  if (['save_meme', 'search_memes', 'send_meme'].includes(name)) {
    if (mode !== 'live') return { ok: true, simulated: true, items: [], message: '表情工具模拟完成，未收藏、未检索线上表情、未向 QQ 发送' };
    if (!event || !memeTurn) throw new Error('缺少当前会话表情上下文');
    if (name === 'save_meme') {
      if (memeTurn.saved) throw new Error('本轮已经尝试收藏表情，请勿重复收藏');
      memeTurn.saved = true;
      const result = await collectFromEvent({ event, sessionKey }, { name: args.description });
      return { ok: true, id: result.asset.id, name: result.asset.name, duplicate: result.duplicate, refreshed: result.refreshed === true,
        missingParameters: result.asset.missingParameters, message: result.refreshed ? '已更新此表情的原生参数' : result.duplicate ? '此表情已经收藏' : '表情已保存到当前会话' };
    }
    if (name === 'search_memes') {
      if (memeTurn.searched) throw new Error('本轮已搜索过表情，请从已有候选选择或使用文字');
      memeTurn.searched = true;
      const items = await searchMemes(sessionKey, args.query, { limit: 5 });
      memeTurn.candidates = new Set(items.map((item) => item.id));
      return { ok: true, items, message: items.length ? '仅可发送候选 ID；没有合适表情可以不用' : '没有匹配的可用表情，请正常文字回复' };
    }
    if (memeTurn.sendAttempted) throw new Error('本轮已经尝试发送一个表情，不能重复发送');
    if (!memeTurn.candidates?.has(args.id)) throw new Error('只能发送本轮 search_memes 返回的候选 ID');
    memeTurn.sendAttempted = true;
    const result = await sendStoredMeme({ event, sessionKey }, args.id);
    if (result.ok) memeTurn.sent = true;
    return result;
  }
  if (name === 'draw') {
    if (mode === 'simulate') return { ok: true, simulated: true, message: '模拟绘图成功，未调用图片 API' };
    const { b64 } = await generateImage(args.prompt, { sessionKey, onAttempt: onImageAttempt });
    if (onImage) await onImage(b64, args.prompt);
    return { ok: true, message: mode === 'live' ? '图片已生成并进入发送队列' : '图片已生成，可在测试结果中查看' };
  }
  if (name === 'recall_memory') {
    return { ok: true, memory: mode === 'live' ? (await getPersona(sessionKey)).memory : memory.value };
  }
  if (mode !== 'live') {
    memory.value += `\n- [测试 ${new Date(nowMs).toISOString()}] ${speaker}: ${args.content}`;
    return { ok: true, sandbox: true, message: '已保存到测试记忆，线上记忆未改变' };
  }
  const ok = await appendMemory(sessionKey, speaker, args.content);
  return { ok, message: ok ? '事实已保存到当前会话' : '记忆保存失败' };
}
