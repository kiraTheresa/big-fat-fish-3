// LLM 客户端（横切组件）：DeepSeek（OpenAI 兼容 chat/completions）——全项目唯一 LLM 出口。
// 零新增依赖：Node ≥22 全局 fetch；超时用 AbortSignal.timeout；任何失败（网络/超时/非 2xx/
// 响应形状异常）一律 reject，由调用方决定兜底策略。
import { config } from './config.js';

// messages: [{ role: 'system'|'user'|'assistant', content: string }, ...] → 回复文本
export async function chatCompletion(messages) {
  const res = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({ model: config.deepseekModel, messages }),
    signal: AbortSignal.timeout(config.chatTimeoutMs),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}`);

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('DeepSeek 响应缺少 choices[0].message.content');
  return content;
}
