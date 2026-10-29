// AIChat MVP · Task 2 验证（spec G2）：LLM 客户端——成功/自定义回复/HTTP 500/超时，
// 以及请求形状（Bearer、model、messages 原样上送）。
// add-self-evolving-persona Task 5 增补：返回值 { content, usage }——usage 透传、
// 容忍缺字段、响应整体缺 usage → null。
// 模式：起 mock LLM → 设 env（必须在 import config 之前）→ 动态 import src/llm.js。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startLlmServer } from './llm-server.js';

const usageRoot = await mkdtemp(join(tmpdir(), 'fish-gateway-test-'));
process.env.USAGE_DIR = usageRoot;
const llm = await startLlmServer();
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.DEEPSEEK_BASE_URL = llm.url;
process.env.CHAT_TIMEOUT_MS = '1000'; // 成功用例本地往返 <50ms；超时用例挂起 1s 后中止

const { chatCompletion } = await import('../src/llm.js');

after(async () => {
  await rm(usageRoot, { recursive: true, force: true });
  await llm.close();
});

test('成功：resolve { content, usage }，usage 原样透传，请求携带 Bearer key、model、messages 原样上送', async () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '你好' },
  ];
  const { content, usage } = await chatCompletion(messages);
  assert.equal(content, 'MOCK_LLM_REPLY');
  // usage 为响应体对象原样透传（DeepSeek 形状，含缓存命中字段）
  assert.deepEqual(usage, {
    prompt_tokens: 11,
    completion_tokens: 22,
    total_tokens: 33,
    prompt_cache_hit_tokens: 44,
  });

  assert.equal(llm.requests.length, 1);
  const req = llm.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer test-key');
  assert.equal(req.body.model, 'deepseek-chat');
  assert.deepEqual(req.body.messages, messages);
});

test('自定义回复：setReply 的内容原样返回，usage 跟随设置（容忍缺字段）', async () => {
  llm.setReply('自定义内容', { prompt_tokens: 5 });
  const { content, usage } = await chatCompletion([{ role: 'user', content: '再来' }]);
  assert.equal(content, '自定义内容');
  assert.deepEqual(usage, { prompt_tokens: 5 }); // 部分字段也透传，不校验不补全
  llm.setReply('MOCK_LLM_REPLY'); // 恢复
});

test('缺 usage：响应整体无 usage 字段 → resolve 的 usage 为 null', async () => {
  llm.setReply('无用量响应', null);
  const { content, usage } = await chatCompletion([{ role: 'user', content: '没有用量' }]);
  assert.equal(content, '无用量响应');
  assert.equal(usage, null);
  llm.setReply('MOCK_LLM_REPLY'); // 恢复
});

test('失败：mock 返回 HTTP 500 → reject 且错误含状态码', async () => {
  llm.setFail();
  await assert.rejects(chatCompletion([{ role: 'user', content: 'x' }]), /HTTP 500/);
  llm.setReply('MOCK_LLM_REPLY'); // 恢复，避免影响后续用例
});

test('超时：mock 挂起不响应，超过 CHAT_TIMEOUT_MS → reject', async () => {
  llm.setHang();
  await assert.rejects(chatCompletion([{ role: 'user', content: 'x' }]));
  llm.setReply('MOCK_LLM_REPLY');
});

test('形状异常：响应缺 choices[0].message.content → reject', async () => {
  llm.setEmpty();
  await assert.rejects(chatCompletion([{ role: 'user', content: 'x' }]), /缺少 choices/);
  llm.setReply('MOCK_LLM_REPLY');
});

const sse = (delta, finish_reason = null, usage) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;

test('流式网关在 HTTP 结束前收到增量；收齐工具参数、reasoning、usage 后返回并记首包耗时', async () => {
  let release;
  let observed;
  const firstDelta = new Promise((resolve) => { observed = resolve; });
  llm.setStream((res) => {
    res.write(sse({ role: 'assistant', reasoning_content: '规划' }));
    res.write(sse({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'draw', arguments: '{"prompt":' } }] }));
    release = () => res.end(sse({ tool_calls: [{ index: 0, function: { arguments: '"猫"}' } }] }) + sse({}, 'tool_calls', { total_tokens: 8 }) + 'data: [DONE]\n\n');
  });
  const trace = [];
  let finished = false;
  const pending = chatCompletion([{ role: 'user', content: '画猫' }], { onAttempt: (entry) => trace.push(entry), onDelta: (delta) => { if (delta.tool_calls) observed(); } }).then((value) => { finished = true; return value; });
  try {
    await firstDelta;
    assert.equal(finished, false);
    release();
    const result = await pending;
    assert.equal(llm.requests.at(-1).body.stream, true);
    assert.deepEqual(llm.requests.at(-1).body.stream_options, { include_usage: true });
    assert.equal(result.message.reasoning_content, '规划');
    assert.equal(result.message.tool_calls[0].function.arguments, '{"prompt":"猫"}');
    assert.equal(result.usage.total_tokens, 8);
    assert.ok(trace.some((entry) => entry.event === 'first_tool_call' && entry.elapsedMs >= 0));
    assert.equal(trace.filter((entry) => entry.phase === 'response').length, 1);
  } finally { release?.(); await pending.catch(() => {}); llm.setReply('MOCK_LLM_REPLY'); }
});

test('关闭流式与记忆提炼保留原 JSON 请求', async () => {
  await chatCompletion([], { stream: false });
  assert.equal(llm.requests.at(-1).body.stream, undefined);
  await chatCompletion([], { kind: 'distill' });
  assert.equal(llm.requests.at(-1).body.stream, undefined);
});

test('流中断仍记一次失败和已收到的用量，不自动重试', async () => {
  const { readUsageOverview } = await import('../src/store/usage-store.js');
  const before = llm.requests.length;
  llm.setStream((res) => res.end(sse({ content: '半截' }, 'stop', { total_tokens: 9 })));
  try {
    await assert.rejects(chatCompletion([], { sessionKey: 'p-stream-cut' }), /中断/);
    assert.equal(llm.requests.length, before + 1);
    const usage = await readUsageOverview({ sessionKey: 'p-stream-cut' });
    assert.equal(usage.items.length, 1);
    assert.equal(usage.items[0].status, 'failure');
    assert.equal(usage.items[0].total_tokens, 9);
  } finally { llm.setReply('MOCK_LLM_REPLY'); }
});

test('收到部分 SSE 后仍受整体超时限制', async () => {
  llm.setStream((res) => res.write(sse({ content: '还没结束' })));
  try { await assert.rejects(chatCompletion([]), /timeout|aborted/i); }
  finally { llm.setReply('MOCK_LLM_REPLY'); }
});
