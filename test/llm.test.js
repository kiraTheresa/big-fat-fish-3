// AIChat MVP · Task 2 验证（spec G2）：LLM 客户端——成功/自定义回复/HTTP 500/超时，
// 以及请求形状（Bearer、model、messages 原样上送）。
// 模式：起 mock LLM → 设 env（必须在 import config 之前）→ 动态 import src/llm.js。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startLlmServer } from './llm-server.js';

const llm = await startLlmServer();
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.DEEPSEEK_BASE_URL = llm.url;
process.env.CHAT_TIMEOUT_MS = '1000'; // 成功用例本地往返 <50ms；超时用例挂起 1s 后中止

const { chatCompletion } = await import('../src/llm.js');

after(async () => {
  await llm.close();
});

test('成功：resolve content，请求携带 Bearer key、model、messages 原样上送', async () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '你好' },
  ];
  const reply = await chatCompletion(messages);
  assert.equal(reply, 'MOCK_LLM_REPLY');

  assert.equal(llm.requests.length, 1);
  const req = llm.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer test-key');
  assert.equal(req.body.model, 'deepseek-chat');
  assert.deepEqual(req.body.messages, messages);
});

test('自定义回复：setReply 的内容原样返回', async () => {
  llm.setReply('自定义内容');
  const reply = await chatCompletion([{ role: 'user', content: '再来' }]);
  assert.equal(reply, '自定义内容');
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
