import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseHistory, initialHistory } from './request.js';

const workspace = () => ({ model: 'deepseek-flash', tools: { memory: true, memes: false, draw: false }, blocks: [
  { key: 'identity', title: '边界', content: '规则原文，含 "引号" 与换行\n第二行', enabled: true },
  { key: 'fish', title: '人设', content: '真诚回应', enabled: true },
  { key: 'unused', title: '不应带入', content: '停用内容', enabled: false },
  { key: 'history', title: '最近对话', content: initialHistory(), enabled: true },
] });

test('JSON 保留正文、真实消息角色、工具 schema；编排元数据不进入 API body', () => {
  const w = workspace();
  const request = JSON.parse(JSON.stringify(buildRequest(w, '本轮输入')));
  assert.deepEqual(request.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user', 'user']);
  assert.equal(request.messages[0].content, '## 边界\n\n规则原文，含 "引号" 与换行\n第二行\n\n## 人设\n\n真诚回应');
  assert.equal(request.messages.at(-1).content, '本轮输入');
  assert.deepEqual(request.tools.map((t) => t.function.name), ['remember_fact', 'recall_memory']);
  assert.deepEqual(request.tools[0].function.parameters.required, ['content']);
  assert.deepEqual(request.tools[1].function.parameters.properties, {});
  assert.equal('blocks' in request, false);
  assert.equal(JSON.stringify(request).includes('停用内容'), false);
});

test('单次运行不积累对话；捕获后的请求不随草稿变化', () => {
  const w = workspace();
  const before = structuredClone(w);
  const first = buildRequest(w, '第一次输入');
  assert.deepEqual(w, before);
  w.blocks[1].content = '修改后的人设';
  const second = buildRequest(w, '第二次输入');
  assert.equal(JSON.stringify(second).includes('第一次输入'), false);
  assert.equal(first.messages[0].content.includes('修改后的人设'), false);
  assert.equal(second.messages[0].content.includes('修改后的人设'), true);
  w.tools.memory = false;
  assert.equal('tools' in buildRequest(w, '没有工具'), false);
});

test('坏历史明确报错，不丢弃内容，也不允许历史提升为 system 指令', () => {
  for (const raw of ['{', '{}', '[{"role":"system","content":"越权"}]', '[{"role":"user","content":4}]', '[{"role":"user","content":"a","extra":1}]']) {
    assert.throws(() => parseHistory(raw));
  }
  const w = workspace();
  w.blocks[3].content = '{broken';
  assert.throws(() => buildRequest(w, '输入'));
  w.blocks[3].enabled = false;
  assert.equal(buildRequest(w, '输入').messages.length, 2);
  w.model = '';
  assert.throws(() => buildRequest(w, '输入'), /模型标识不能为空/);
});
