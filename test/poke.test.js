import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer } from './mock-onebot.js';
import { startLlmServer } from './llm-server.js';

const dir = await mkdtemp(join(tmpdir(), 'fish-poke-'));
const wire = await startMockServer({ token: 'poke-test' });
const llm = await startLlmServer();
Object.assign(process.env, {
  DATA_DIR: dir, CONFIG_PATH: join(dir, 'absent.json'), ONEBOT_WS_URL: wire.url,
  ONEBOT_ACCESS_TOKEN: 'poke-test', DEEPSEEK_API_KEY: 'mock-key', DEEPSEEK_BASE_URL: llm.url,
  SEND_INTERVAL_MS: '1', CHAT_COOLDOWN_MS: '2000',
});
const { config } = await import('../src/config.js');
const { dispatch } = await import('../src/dispatch/dispatcher.js');
const { register } = await import('../src/dispatch/registry.js');
const poke = (await import('../src/triggers/poke.js')).default;
const chat = (await import('../src/triggers/chat.js')).default;
const onebot = await import('../src/connection/onebot.js');
const { drainSender } = await import('../src/sender/sender.js');
const { flushMessageStore, readRecentMessages } = await import('../src/store/message-store.js');
const { flushEventStore, readEvents } = await import('../src/store/event-store.js');
const { flushPersistence } = await import('../src/platform/persistence.js');
const { setUser } = await import('../src/platform/permissions.js');
const { setUsagePolicy } = await import('../src/platform/usage-policy.js');
register(poke);
register(chat);
onebot.startConnection();
await wire.waitForConnectionCount(1);
for (let tries = 0; ; tries++) {
  try { await onebot.callApi('get_status'); break; }
  catch (error) {
    if (tries >= 100 || !error.message.includes('WS 未连接')) throw error;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
after(async () => {
  await drainSender();
  onebot.stopConnection();
  await wire.close();
  await llm.close();
  await flushMessageStore();
  await flushEventStore();
  await flushPersistence();
  await rm(dir, { recursive: true, force: true });
});
const event = (overrides = {}) => ({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
  self_id: 10000, target_id: '10000', user_id: 20001, group_id: 30001, time: Math.floor(Date.now() / 1000), ...overrides });
const sends = () => wire.frames.filter((f) => f.action === 'send_msg');

test('群戳一戳：单条短回复、无人造引用/工具/识图；保留原通知及对话历史', async () => {
  llm.setReply('咕噜！\n谁在戳本鱼||啵');
  config.behavior.trigger.poke.prompt = '只用鱼的口吻简短回应';
  // 默认延迟 2–8 秒和识图都开启，戳一戳应跳过。
  const raw = event();
  await dispatch(raw);
  await drainSender();
  assert.equal(sends().length, 1);
  assert.equal(sends()[0].params.message_type, 'group');
  assert.equal(sends()[0].params.group_id, 30001);
  assert.equal(sends()[0].params.message, '咕噜！ 谁在戳本鱼 啵');
  const request = llm.requests.at(-1).body;
  assert.equal(request.tools, undefined);
  assert.match(request.messages[0].content, /# 大肥鱼/);
  assert.match(request.messages[0].content, /只用鱼的口吻简短回应/);
  assert.equal(request.messages.at(-1).content, '20001: [戳一戳] 戳了戳你');
  assert.equal(request.messages.length, 2, '当前戳一戳不重复进入历史');
  assert.equal(wire.frames.some((f) => f.action === 'get_group_msg_history'), false);
  await flushMessageStore();
  const history = await readRecentMessages('g-30001', 10);
  assert.equal(history.length, 2);
  assert.match(history[0].raw_message, /戳一戳/);
  assert.equal(history[1].bot, true);
  assert.equal(history[1].raw_message, sends()[0].params.message);
  const inbox = await readEvents({ sessionKey: 'g-30001' });
  assert.deepEqual(inbox.items[0].event, raw);
  assert.equal(inbox.items[0].eventType, 'notify');
});

test('私聊戳一戳发给操作者，并沿用会话上下文', async () => {
  llm.setReply('本鱼在呢');
  await dispatch(event({ group_id: undefined, user_id: 20002 }));
  await drainSender();
  assert.equal(sends().at(-1).params.message_type, 'private');
  assert.equal(sends().at(-1).params.user_id, 20002);
  config.behavior.chat.cooldownMs = 0;
  await dispatch(event({ group_id: undefined, user_id: 20002 }));
  assert.ok(llm.requests.at(-1).body.messages.some((m) => m.role === 'assistant' && m.content === '本鱼在呢'));
  config.behavior.chat.cooldownMs = 2000;
});

test('冷却：两秒内聊天与戳一戳共用窗口，两秒后恢复', async () => {
  await dispatch(event({ group_id: 30003 }));
  const before = llm.requests.length;
  const message = { post_type: 'message', message_type: 'group', group_id: 30003, user_id: 20003,
    self_id: 10000, message_id: 123, message: '[CQ:at,qq=10000]你好', time: Math.floor(Date.now() / 1000) };
  await dispatch(event({ group_id: 30003, user_id: 20004 }));
  await dispatch(message);
  assert.equal(llm.requests.length, before);
  await new Promise((resolve) => setTimeout(resolve, 2050));
  config.behavior.reply.delay.enabled = false;
  await dispatch(message);
  assert.equal(llm.requests.length, before + 1);
  await dispatch(event({ group_id: 30003 }));
  assert.equal(llm.requests.length, before + 1, '聊天也会阻止窗口内的戳一戳');
});

test('关闭开关、无密钥、封禁和非目标通知均不调用模型', async () => {
  const before = llm.requests.length;
  config.behavior.trigger.poke.enabled = false;
  await dispatch(event({ group_id: 30004 }));
  config.behavior.trigger.poke.enabled = true;
  config.deepseekApiKey = '';
  await dispatch(event({ group_id: 30004 }));
  config.deepseekApiKey = 'mock-key';
  await setUser('20005', { role: 'blocked' });
  await dispatch(event({ group_id: 30004, user_id: 20005 }));
  for (const overrides of [{ target_id: 99999 }, { user_id: 10000 }, { user_id: undefined },
    { self_id: undefined }, { group_id: '../bad' }, { sub_type: 'honor' }, { post_type: 'message_sent' }]) {
    await dispatch(event({ group_id: 30004, ...overrides }));
  }
  assert.equal(llm.requests.length, before);
});

test('模型错误与关闭文字能力沿用兜底，不绕过额度开关', async () => {
  llm.setFail();
  await dispatch(event({ group_id: 30005 }));
  await drainSender();
  assert.equal(sends().at(-1).params.message, 'AI 开小差了，稍后再试～');
  const before = llm.requests.length;
  setUsagePolicy({ features: { chat: false } });
  await dispatch(event({ group_id: 30006 }));
  await drainSender();
  assert.equal(llm.requests.length, before);
  assert.match(sends().at(-1).params.message, /暂时不能调用模型/);
  setUsagePolicy();
});
