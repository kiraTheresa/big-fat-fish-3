import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatStream } from '../src/utils/chat-stream.js';

const frame = (delta, finish_reason = null, usage) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\r\n\r\n`;
function body(text, width = 1) {
  const bytes = Buffer.from(text);
  return new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += width) controller.enqueue(bytes.subarray(i, i + width));
    controller.close();
  } });
}

test('流式按 UTF-8 字节拆包：中文、CRLF、注释、文本、reasoning 与独立 usage 帧', async () => {
  const usage = { total_tokens: 12 };
  const deltas = []; const usages = [];
  const result = await readChatStream(body(': keepalive\r\n\r\n' + frame({ role: 'assistant', reasoning_content: '想一想' }) + frame({ content: '鱼' }) + frame({ content: '你好' }, 'stop') + `data: ${JSON.stringify({ choices: [], usage })}\r\n\r\ndata: [DONE]`), {
    onDelta: (value) => deltas.push(value), onUsage: (value) => usages.push(value),
  });
  assert.deepEqual(result, { role: 'assistant', content: '鱼你好', reasoning_content: '想一想' });
  assert.equal(deltas.length, 3);
  assert.deepEqual(usages, [usage]);
});

test('交错的多工具增量按 index 合并，保留 ID、函数名、参数与末帧用量', async () => {
  let usage;
  const result = await readChatStream(body(
    frame({ tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'recall_', arguments: '' } }, { index: 0, id: 'a', type: 'function', function: { name: 'dr', arguments: '{"prompt":' } }] }) +
    frame({ tool_calls: [{ index: 0, function: { name: 'aw', arguments: '"猫"}' } }, { index: 1, function: { name: 'memory', arguments: '{}' } }] }) +
    frame({}, 'tool_calls', { total_tokens: 5 }) + 'data: [DONE]\n\n', 7), { onUsage: (value) => { usage = value; } });
  assert.deepEqual(result.tool_calls, [
    { id: 'a', type: 'function', function: { name: 'draw', arguments: '{"prompt":"猫"}' } },
    { id: 'b', type: 'function', function: { name: 'recall_memory', arguments: '{}' } },
  ]);
  assert.equal(usage.total_tokens, 5);
});

for (const [name, input, error] of [
  ['缺 DONE', frame({ content: '部分回复' }, 'stop'), /中断/],
  ['缺 finish_reason', frame({ content: '部分回复' }) + 'data: [DONE]\n\n', /中断/],
  ['截断', frame({ content: '部分回复' }, 'length') + 'data: [DONE]\n\n', /未正常完成/],
  ['无效 JSON', 'data: {bad}\n\n', /无效 JSON/],
  ['上游错误帧', 'data: {"error":{"message":"upstream failed"}}\n\n', /upstream failed/],
  ['异常工具索引', frame({ tool_calls: [{ index: 1000000 }] }), /索引/],
  ['工具未正常完成', frame({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'draw', arguments: '{}' } }] }, 'stop') + 'data: [DONE]\n\n', /未正常完成/],
]) test(name + ' 不接受为成功响应', async () => {
  await assert.rejects(readChatStream(body(input)), error);
});
