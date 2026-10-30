export const chatStreamOptions = (enabled) => enabled ? { stream: true, stream_options: { include_usage: true } } : {};

// SSE frames and UTF-8 characters can both straddle network chunks. Assemble
// the entire assistant turn before exposing executable tool calls to the runner.
export async function readChatStream(body, { onDelta, onUsage } = {}) {
  if (!body) throw new Error('DeepSeek 流式响应缺少 body');
  const decoder = new TextDecoder();
  const message = { role: 'assistant', content: null };
  const calls = new Map();
  let buffer = '';
  let dataLines = [];
  let done = false;
  let finishReason;
  let bytes = 0;
  const append = (object, key, value) => {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string') throw new Error('DeepSeek 流式字段格式不正确');
    object[key] = (object[key] ?? '') + value;
  };
  const frame = () => {
    if (!dataLines.length || done) return;
    const raw = dataLines.join('\n');
    dataLines = [];
    if (raw.trim() === '[DONE]') { done = true; return; }
    let chunk;
    try { chunk = JSON.parse(raw); } catch { throw new Error('DeepSeek 流式响应包含无效 JSON'); }
    if (chunk.error) throw new Error(`DeepSeek stream: ${chunk.error.message ?? '上游返回错误'}`);
    if (chunk.usage) onUsage?.(chunk.usage);
    const choice = chunk.choices?.find((item) => item.index === 0 || item.index === undefined);
    if (!choice) return; // Some compatible providers send usage in a separate frame.
    const delta = choice.delta ?? {};
    append(message, 'content', delta.content);
    append(message, 'reasoning_content', delta.reasoning_content);
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) throw new Error('DeepSeek 流式工具调用格式不正确');
      for (const part of delta.tool_calls) {
        if (!Number.isInteger(part?.index) || part.index < 0 || part.index >= 16) throw new Error('DeepSeek 流式工具索引不正确');
        const call = calls.get(part.index) ?? { function: { name: '', arguments: '' } };
        append(call, 'id', part.id);
        if (part.type != null) {
          if (part.type !== 'function') throw new Error('DeepSeek 流式工具类型不正确');
          call.type = part.type;
        }
        append(call.function, 'name', part.function?.name);
        append(call.function, 'arguments', part.function?.arguments);
        if ((call.id?.length ?? 0) > 200 || call.function.name.length > 128 || call.function.arguments.length > 20000) throw new Error('DeepSeek 流式工具参数过长');
        calls.set(part.index, call);
      }
    }
    onDelta?.(delta);
    if (choice.finish_reason != null) finishReason = choice.finish_reason;
  };
  const line = (value) => {
    if (value === '') frame();
    else if (value.startsWith('data:')) dataLines.push(value.slice(5).replace(/^ /, ''));
  };
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > 4 * 1024 * 1024) throw new Error('DeepSeek 流式响应超过大小上限');
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r\n|\r|\n/.exec(buffer))) {
      // A trailing CR may be the first half of CRLF in the next network chunk.
      if (match[0] === '\r' && match.index === buffer.length - 1) break;
      line(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (done) break;
    }
    if (done) break;
  }
  buffer += decoder.decode();
  if (!done) {
    for (const value of buffer.split(/\r\n|\r|\n/)) line(value);
    frame();
  }
  if (!done || !finishReason) throw new Error('DeepSeek 流式响应中断，未收到完整结束标记');
  if (finishReason !== (calls.size ? 'tool_calls' : 'stop')) throw new Error(`DeepSeek 流式响应未正常完成：${finishReason}`);
  if (calls.size) {
    const entries = [...calls.entries()].sort(([a], [b]) => a - b);
    if (entries.some(([index], position) => index !== position)) throw new Error('DeepSeek 流式工具索引不连续');
    message.tool_calls = entries.map(([, call]) => call);
  }
  return message;
}
