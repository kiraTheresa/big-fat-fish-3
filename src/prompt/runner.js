import { randomUUID } from 'node:crypto';
import { logger, redactText } from '../utils/logger.js';
import { chatCompletion } from '../llm.js';
import { executeTool, parseToolArguments } from '../tools/registry.js';

// A single loop for production and test requests. No automatic replay after side effects.
export async function runToolConversation(request, settings, context, { trace = [], completion = chatCompletion, execute = executeTool } = {}) {
  context = { ...context, logContext: { traceId: randomUUID(), sessionKey: context.sessionKey, source: context.mode === 'live' ? 'live' : 'test', ...context.logContext }, memeTurn: context.memeTurn ?? {}, reportTurn: context.reportTurn ?? {} };
  const imageSent = () => context.memeTurn.sent === true || context.reportTurn.sent === true;
  const messages = structuredClone(request.messages);
  const allowed = new Set((request.tools ?? []).map((t) => t.function.name));
  const memo = new Map();
  const seenIds = new Set();
  let count = 0;
  let toolStarted = false;
  try {
    for (let round = 0; round <= settings.execution.maxToolRounds; round++) {
      const exhausted = round === settings.execution.maxToolRounds || count >= settings.execution.maxToolCalls;
      logger.event('model.tools.offered', { ...context.logContext, level: round === 0 ? 'INFO' : 'DEBUG',
        data: { names: [...allowed], round, toolChoice: exhausted ? 'none' : 'auto' } });
      const result = await completion(messages, { logContext: context.logContext, model: request.model, kind: context.kind ?? 'chat', sessionKey: context.sessionKey, tools: request.tools, toolChoice: exhausted ? 'none' : undefined, allowEmptyContent: imageSent(),
        onAttempt: (entry) => trace.push({ ...entry, round }) });
      const message = result.message ?? { role: 'assistant', content: result.content };
      const calls = message.tool_calls;
      if (!Array.isArray(calls) || !calls.length) {
        logger.event('model.response.received', { ...context.logContext, outcome: typeof message.content === 'string' && message.content.trim() ? 'text' : 'empty', data: { round } });
        if (imageSent() && (message.content == null || message.content.trim?.() === '')) return { content: '', trace, toolStarted };
        if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('模型未返回可发送的回复');
        return { content: message.content, trace, toolStarted };
      }
      if (exhausted) throw new Error('工具调用达到上限，模型仍未返回最终回复');
      // Validate the complete frame before any action; every accepted call must have one result.
      if (calls.length > 16 || calls.some((call) => !call || call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 200 || !call.function)) throw new Error('模型返回了无效的工具调用结构');
      const ids = calls.map((call) => call.id);
      if (new Set(ids).size !== ids.length || ids.some((id) => seenIds.has(id))) throw new Error('模型重复使用工具调用 ID，已停止以避免重复操作');
      ids.forEach((id) => seenIds.add(id));
      logger.event('model.response.received', { ...context.logContext, outcome: 'tools', data: { names: calls.map(call => call.function.name), round } });
      messages.push({ ...message, role: 'assistant', content: message.content ?? null });
      for (const call of calls) {
        const name = call.function.name;
        let output;
        let reused = false;
        const startedAt = Date.now();
        const operationId = randomUUID();
        logger.event('tool.started', { ...context.logContext, operationId, data: { name, round } });
        try {
          if (!allowed.has(name)) throw new Error('模型调用了未提供的工具');
          const args = parseToolArguments(name, call.function.arguments);
          const key = `${name}:${JSON.stringify(args)}`;
          if (name !== 'recall_memory' && memo.has(key)) { output = memo.get(key); reused = true; }
          else {
            if (count >= settings.execution.maxToolCalls) throw new Error('本轮工具次数已达上限');
            count++;
            toolStarted = true;
            try { output = await execute(name, args, { ...context, onImageAttempt: (entry) => {
              trace.push({ ...entry, round });
              context.onImageAttempt?.(entry);
            } }, settings); }
            catch (error) { output = { ok: false, error: redactText(error.message) }; }
            // Cache failures too: a timed-out side effect may already have completed upstream.
            if (name !== 'recall_memory') memo.set(key, output);
          }
        } catch (error) { output = { ok: false, error: redactText(error.message) }; }
        logger.event('tool.finished', { ...context.logContext, operationId, level: output?.ok === false ? 'WARN' : 'INFO', outcome: output?.ok === false ? 'failed' : 'success',
          elapsedMs: Math.max(0, Date.now() - startedAt), data: { name, round, reused, ok: output?.ok !== false, ...(output?.ok === false ? { error: output.error } : {}) } });
        trace.push({ phase: 'tool', name, id: call.id, arguments: call.function.arguments, result: output, reused, elapsedMs: Math.max(0, Date.now() - startedAt) });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
      }
    }
    throw new Error('工具调用未能结束');
  } catch (error) { error.toolStarted = toolStarted; throw error; }
}
