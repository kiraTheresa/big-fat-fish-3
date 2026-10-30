// Common OpenAI-compatible chat/vision/distill gateway. Usage belongs to each
// actual API attempt, even when a caller later rejects its generated content.
import { config } from './config.js';
import { beginUsage, finishUsage } from './platform/usage-policy.js';
import { redactText } from './utils/logger.js';
import { chatStreamOptions, readChatStream } from './utils/chat-stream.js';

export async function chatCompletion(messages, { model = config.deepseekModel, kind = 'chat', sessionKey = 'system', tools, toolChoice, stream = config.chatStream && kind !== 'distill', onAttempt, onDelta, allowEmptyContent = false } = {}) {
  const attempt = await beginUsage({ kind, model, sessionKey });
  let usage = null;
  let httpStatus;
  let failure;
  const request = { model, messages, ...chatStreamOptions(stream), ...(tools?.length ? { tools, ...(toolChoice ? { tool_choice: toolChoice } : {}) } : {}) };
  const startedAt = Date.now();
  onAttempt?.({ phase: 'request', request: structuredClone(request), at: startedAt });
  try {
    const res = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.deepseekApiKey}` },
      body: JSON.stringify(request),
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
    let message;
    if (res.headers.get('content-type')?.includes('text/event-stream')) {
      const milestones = new Set();
      message = await readChatStream(res.body, {
        onUsage: (value) => { usage = value; },
        onDelta: (delta) => {
          for (const [event, present] of [['first_delta', Object.keys(delta).length > 0], ['first_content', !!delta.content], ['first_tool_call', !!delta.tool_calls?.length]]) {
            if (!present || milestones.has(event)) continue;
            milestones.add(event);
            onAttempt?.({ phase: 'stream', event, elapsedMs: Date.now() - startedAt });
          }
          onDelta?.(delta);
        },
      });
    } else {
      // Compatible gateways may ignore stream and return JSON. Consume that
      // same response; never retry a failed request automatically.
      const data = await res.json();
      usage = data.usage ?? null;
      message = data.choices?.[0]?.message;
    }
    const content = message?.content;
    const calls = message?.tool_calls;
    if (typeof content !== 'string' && !(Array.isArray(calls) && calls.length)
      && !(allowEmptyContent && message?.role === 'assistant' && content === null)) throw new Error('DeepSeek 响应缺少 choices[0].message.content / tool_calls');
    onAttempt?.({ phase: 'response', message: structuredClone(message), usage, httpStatus, elapsedMs: Date.now() - startedAt });
    return { content, usage, message };
  } catch (error) {
    failure = error;
    onAttempt?.({ phase: 'error', error: redactText(error.message, [config.deepseekApiKey]), httpStatus, elapsedMs: Date.now() - startedAt });
    throw error;
  } finally {
    await finishUsage(attempt, { usage, error: failure, httpStatus });
  }
}
