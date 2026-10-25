// LLM 客户端（横切组件）：DeepSeek（OpenAI 兼容 chat/completions）——全项目唯一 LLM 出口。
// 零新增依赖：Node ≥22 全局 fetch；超时用 AbortSignal.timeout；任何失败（网络/超时/非 2xx/
// 响应形状异常）一律 reject，由调用方决定兜底策略。
import { config } from './config.js';

// messages: [{ role: 'system'|'user'|'assistant', content: string | 块数组 }, ...]
// content 块数组是识图路径（DeepSeek 视觉款）：仅 user 消息可携带
// [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/...;base64,...' } }]，
// system/assistant 带图 400（实测）；纯文本路径 content 恒为 string，与既有行为零变化。
// → resolve { content, usage }（add-self-evolving-persona 契约）：
//   - content：回复文本（非 string 视为形状异常，reject）；
//   - usage：响应体 usage 对象原样透传（DeepSeek 含 prompt_tokens/completion_tokens/
//     total_tokens/prompt_cache_hit_tokens 等，容忍缺字段、不校验不补全），
//     响应整体缺 usage 字段时为 null。
export async function chatCompletion(messages, { model = config.deepseekModel } = {}) {
  const res = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({ model, messages }),
    signal: AbortSignal.timeout(config.chatTimeoutMs),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}`);

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('DeepSeek 响应缺少 choices[0].message.content');
  return { content, usage: data.usage ?? null };
}
