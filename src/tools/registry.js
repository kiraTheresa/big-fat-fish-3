import { config } from '../config.js';
import { getRole } from '../platform/permissions.js';
import { getUsagePolicy } from '../platform/usage-policy.js';
import { generateImage } from '../imagegen.js';
import { appendMemory, getPersona } from '../store/persona-store.js';

export const TOOL_PARAMETERS = { draw: 'prompt', remember_fact: 'content', recall_memory: null };
export function toolAvailability(settings, actorId) {
  return Object.entries(settings.tools).map(([name, tool]) => {
    const reason = !tool.enabled ? '已关闭' : actorId && getRole(actorId) === 'blocked' ? '用户已封禁'
      : name === 'draw' && !config.imageApiKey ? '未配置图片 API'
        : name === 'draw' && !getUsagePolicy().features.draw ? '绘图能力被停用' : '';
    return { name, enabled: tool.enabled, available: !reason, reason, effect: name === 'draw' ? '调用图片 API' : name === 'remember_fact' ? '写入当前会话记忆' : '读取当前会话记忆' };
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
export async function executeTool(name, args, { sessionKey, actorId, speaker, memory, mode = 'live', onImage, onImageAttempt, nowMs = Date.now() }, settings) {
  if (!toolAvailability(settings, actorId).find((t) => t.name === name)?.available) throw new Error('工具已停用或当前用户不可用');
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
