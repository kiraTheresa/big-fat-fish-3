import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLlmServer } from './llm-server.js';

const root = await mkdtemp(join(tmpdir(), 'fish-memory-activity-'));
const llm = await startLlmServer();
process.env.DATA_DIR = root;
process.env.PERSONA_DIR = join(root, 'personas');
process.env.USAGE_DIR = join(root, 'usage');
process.env.CONFIG_PATH = join(root, 'absent.json');
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.DEEPSEEK_BASE_URL = llm.url;
process.env.CHAT_TIMEOUT_MS = '150';
const { config } = await import('../src/config.js');
const { appendMessage } = await import('../src/store/message-store.js');
const { readState, updateState } = await import('../src/store/session-state.js');
const { scanOnce } = await import('../src/distill/distiller.js');
const { initializeMemoryActivity, activeMemoryGroups, markMemoryInvocation, readMemoryMessages, receiptProgress } = await import('../src/distill/activity.js');
const hour = 3600000;
const base = Date.now();
const message = (key, at, text) => appendMessage({ sessionKey: key, time: Math.floor(at / 1000), receivedAt: at, raw_message: text, user_id: 123 });
const reply = () => llm.setReply(JSON.stringify({ character: '# 大肥鱼', memory: '测试记忆' }));
after(async () => { await llm.close(); await rm(root, { recursive: true, force: true }); });

test('被动群不提炼；两小时边界收尾一次；休眠及重启不扫描；唤醒不补闲聊', async () => {
  reply();
  const key = 'g-lifecycle';
  await message(key, base - hour, '尚未呼唤时的闲聊');
  await scanOnce(base);
  assert.equal(llm.requests.length, 0);
  await markMemoryInvocation(key, base, base);
  await message(key, base, '大肥鱼你好');
  await message(key, base + 2 * hour - 1, '活跃末尾');
  // Even if the timer runs late, post-deadline messages cannot enter the batch.
  await message(key, base + 2 * hour, '休眠闲聊');
  await scanOnce(base + 2 * hour - 1);
  assert.equal(llm.requests.length, 0, '未满批量且未安静 10 分钟，不提炼');
  assert.ok((await activeMemoryGroups()).includes(key));
  await scanOnce(base + 2 * hour);
  assert.equal(llm.requests.length, 1, '临睡前忽略安静条件，收尾一次');
  const text = llm.requests[0].body.messages[1].content;
  assert.match(text, /大肥鱼你好/);
  assert.match(text, /活跃末尾/);
  assert.doesNotMatch(text, /尚未呼唤|休眠闲聊/);
  assert.equal((await readState(key)).memoryActivity.sleeping, true);
  assert.ok(!(await activeMemoryGroups()).includes(key));
  await initializeMemoryActivity();
  await scanOnce(base + 4 * hour);
  assert.equal(llm.requests.length, 1);
  await markMemoryInvocation(key, base + 4 * hour, base + 4 * hour);
  await message(key, base + 4 * hour, '再次呼唤');
  await scanOnce(base + 4 * hour + 600000);
  assert.equal(llm.requests.length, 2);
  assert.match(llm.requests[1].body.messages[1].content, /再次呼唤/);
  assert.doesNotMatch(llm.requests[1].body.messages[1].content, /休眠闲聊|活跃末尾/);
});

test('收尾失败仍休眠；重启不重试；唤醒后保留旧待处理内容并排除静默期间消息', async () => {
  const key = 'g-failure';
  await markMemoryInvocation(key, base, base);
  await message(key, base, '失败前的有效内容');
  llm.setFail();
  const before = llm.requests.length;
  await scanOnce(base + 2 * hour);
  assert.equal(llm.requests.length, before + 1);
  await initializeMemoryActivity();
  await message(key, base + 3 * hour, '不该补提炼');
  await scanOnce(base + 3 * hour);
  assert.equal(llm.requests.length, before + 1);
  await markMemoryInvocation(key, base + 4 * hour, base + 4 * hour);
  await message(key, base + 4 * hour, '新的有效呼唤');
  reply();
  await scanOnce(base + 4 * hour + 600000);
  assert.equal(llm.requests.length, before + 2);
  const text = llm.requests.at(-1).body.messages[1].content;
  assert.match(text, /失败前的有效内容/);
  assert.match(text, /新的有效呼唤/);
  assert.doesNotMatch(text, /不该补提炼/);
});

test('扫描之前已经再次呼唤：按两小时时限关闭旧窗口，不把中间闲聊当活跃', async () => {
  const key = 'g-late-scan';
  await markMemoryInvocation(key, base, base);
  await message(key, base, '旧窗口');
  await message(key, base + 3 * hour, '窗口之间');
  await markMemoryInvocation(key, base + 4 * hour, base + 4 * hour);
  await message(key, base + 4 * hour, '新窗口');
  const rows = await readMemoryMessages(key, await readState(key));
  assert.deepEqual(rows.map((r) => r.raw_message), ['旧窗口', '新窗口']);
});

test('活跃状态重启恢复；调用续期；同毫秒消息不丢失；旧提炼结果不覆盖新的唤醒状态', async () => {
  const key = 'g-concurrent';
  await markMemoryInvocation(key, base, base);
  await message(key, base, '第一条');
  const rows = await readMemoryMessages(key, await readState(key));
  await markMemoryInvocation(key, base + hour, base + hour);
  await initializeMemoryActivity();
  assert.ok((await activeMemoryGroups()).includes(key));
  assert.equal((await readState(key)).memoryActivity.lastInvokedAt, base + hour);
  await message(key, base, '同毫秒后到');
  await markMemoryInvocation(key, base + 4 * hour, base + 4 * hour);
  await updateState(key, (state) => receiptProgress(state, rows));
  const state = await readState(key);
  assert.equal(state.memoryActivity.sleeping, false);
  assert.equal(state.memoryActivity.lastInvokedAt, base + 4 * hour);
  assert.deepEqual((await readMemoryMessages(key, state)).map((r) => r.raw_message), ['同毫秒后到']);
});

test('大批量按最早未处理内容分批，休眠前失败的消息不被最新 100 条挤掉', async () => {
  const key = 'g-backlog';
  await markMemoryInvocation(key, base, base);
  for (let i = 0; i < 105; i++) await message(key, base + i, `记录${i}`);
  const first = await readMemoryMessages(key, await readState(key));
  assert.equal(first.length, 100);
  assert.equal(first[0].raw_message, '记录0');
  await updateState(key, (state) => receiptProgress(state, first));
  const remaining = await readMemoryMessages(key, await readState(key));
  assert.equal(remaining.length, 5);
  assert.equal(remaining[0].raw_message, '记录100');
});

test('私聊保持原来的提炼逻辑', async () => {
  const key = 'p-unchanged';
  await message(key, base - hour, '私聊内容');
  await markMemoryInvocation(key, base, base);
  assert.equal((await readState(key)).memoryActivity, undefined);
  assert.equal((await readMemoryMessages(key, await readState(key))).length, 1);
  assert.equal(config.distillIdleMs, 7200000);
});
