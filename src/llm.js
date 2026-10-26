// Common OpenAI-compatible chat/vision/distill gateway. Usage belongs to each
// actual API attempt, even when a caller later rejects its generated content.
import { config } from './config.js';
import { beginUsage, finishUsage } from './platform/usage-policy.js';
import { redactText } from './utils/logger.js';

export async function chatCompletion(messages, { model = config.deepseekModel, kind = 'chat', sessionKey = 'system' } = {}) {
  const attempt = await beginUsage({ kind, model, sessionKey });
  let usage = null;
  let httpStatus;
  let failure;
  try {
    const res = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.deepseekApiKey}` },
      body: JSON.stringify({ model, messages }),
      signal: AbortSignal.timeout(config.chatTimeoutMs),
    });
    httpStatus = res.status;
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        const message = body.error?.message ?? body.message;
        if (typeof message === 'string') detail = redactText(message, [config.deepseekApiKey]).slice(0, 500);
      } catch { /* The HTTP status remains useful when the body is not JSON. */ }
      throw new Error(`DeepSeek HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const data = await res.json();
    usage = data.usage ?? null;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('DeepSeek 响应缺少 choices[0].message.content');
    return { content, usage };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await finishUsage(attempt, { usage, error: failure, httpStatus });
  }
}
