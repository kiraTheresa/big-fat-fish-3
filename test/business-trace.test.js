import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer } from './mock-onebot.js';
import { startLlmServer } from './llm-server.js';

const root = await mkdtemp(join(tmpdir(), 'fish-business-trace-'));
const onebot = await startMockServer({ token: 'trace-onebot-secret' });
const llm = await startLlmServer();
Object.assign(process.env, { DATA_DIR: root, PERSONA_DIR: join(root, 'personas'), USAGE_DIR: join(root, 'usage'), CONFIG_PATH: join(root, 'absent.json'),
  DEEPSEEK_API_KEY: 'trace-model-secret', DEEPSEEK_BASE_URL: llm.url, CHAT_TIMEOUT_MS: '1000', CHAT_COOLDOWN_MS: '0',
  ONEBOT_WS_URL: onebot.url, ONEBOT_ACCESS_TOKEN: 'trace-onebot-secret', SEND_INTERVAL_MS: '5', API_TIMEOUT_MS: '100', RECONNECT_DELAY_MS: '100' });
const { config } = await import('../src/config.js');
const { logger, configureLogger, readLogs, flushLogs } = await import('../src/utils/logger.js');
const connection = await import('../src/connection/onebot.js');
const { dispatch } = await import('../src/dispatch/dispatcher.js');
const { register } = await import('../src/dispatch/registry.js');
const chat = (await import('../src/triggers/chat.js')).default;
const { initializePrompts } = await import('../src/prompt/store.js');
const { readUsageOverview } = await import('../src/store/usage-store.js');
const { sendPrivate, drainSender } = await import('../src/sender/sender.js');
const { runToolConversation } = await import('../src/prompt/runner.js');
const { startAdminServer } = await import('../src/admin/server.js');
const { flushEventStore } = await import('../src/store/event-store.js');
const { flushMessageStore } = await import('../src/store/message-store.js');
config.behavior.reply.delay.enabled = false;
configureLogger({ dataDir: root, level: 'ERROR' });
await initializePrompts();
register(chat);
connection.startConnection();
await onebot.waitForConnectionCount(1);
for (let i = 0;; i++) {
  try { await connection.callApi('get_status'); break; }
  catch (error) { if (i > 100) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
}
let sequence = 0;
const message = user_id => ({ post_type: 'message', message_type: 'private', user_id, self_id: 10000,
  message_id: ++sequence, time: Math.floor(Date.now() / 1000), raw_message: 'DO_NOT_LOG_USER_TEXT',
  message: [{ type: 'text', data: { text: 'DO_NOT_LOG_USER_TEXT' } }], sender: { nickname: 'tester' } });
after(async () => {
  await drainSender(); connection.stopConnection();
  await onebot.close(); await llm.close();
  await flushEventStore(); await flushMessageStore(); await flushLogs();
  configureLogger({ dataDir: null });
  await rm(root, { recursive: true, force: true });
});

test('concurrent chat traces join ingress, model attempts and queued replies without crossing sessions', async () => {
  await Promise.all([dispatch(message(111)), dispatch(message(222))]);
  assert.equal(await drainSender(), true);
  const traces = [];
  for (const sessionKey of ['p-111', 'p-222']) {
    const rows = await readLogs({ sessionKey, limit: 100 });
    const started = rows.find(row => row.event === 'handler.started');
    assert.ok(started);
    traces.push(started.traceId);
    assert.ok(rows.every(row => row.traceId === started.traceId));
    for (const event of ['handler.finished', 'model.request.started', 'model.request.finished', 'reply.queued', 'reply.started', 'reply.finished']) assert.ok(rows.some(row => row.event === event), event);
    assert.equal(rows.find(row => row.event === 'reply.finished').outcome, 'confirmed');
    const usage = await readUsageOverview({ sessionKey });
    assert.equal(usage.items[0].traceId, started.traceId);
    assert.equal(rows.find(row => row.event === 'model.request.finished').operationId, usage.items[0].id);
    assert.equal(rows.find(row => row.event === 'model.request.finished').data.ledgerSaved, true);
    const incoming = (await readFile(join(root, 'messages', sessionKey + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).find(row => !row.bot);
    assert.equal(incoming.traceId, started.traceId);
    const text = JSON.stringify(rows);
    for (const secret of ['DO_NOT_LOG_USER_TEXT', 'trace-model-secret', 'trace-onebot-secret', 'MOCK_LLM_REPLY']) assert.ok(!text.includes(secret));
  }
  assert.notEqual(traces[0], traces[1]);
});

test('model failure, fallback and platform rejection remain distinct on the same trace', async () => {
  llm.setFail(); onebot.failNextCall();
  try { await dispatch(message(333)); await drainSender(); }
  finally { llm.setReply('MOCK_LLM_REPLY'); }
  const rows = await readLogs({ sessionKey: 'p-333' });
  assert.equal(new Set(rows.map(row => row.traceId)).size, 1);
  const model = rows.find(row => row.event === 'model.request.finished');
  assert.equal(model.outcome, 'failed'); assert.equal(model.reason, 'upstream_error');
  assert.ok(rows.some(row => row.event === 'chat.fallback.queued'));
  const reply = rows.find(row => row.event === 'reply.finished');
  assert.equal(reply.outcome, 'failed'); assert.equal(reply.reason, 'ONEBOT_REJECTED');
  assert.equal(rows.find(row => row.event === 'handler.finished').outcome, 'completed');
});

test('missing send confirmation is unknown, never confirmed or automatically replayed', async () => {
  onebot.setAutoRespond(false);
  try {
    const before = onebot.frames.length;
    const result = await sendPrivate(444, 'private reply body', { traceId: 'send-timeout', source: 'live' });
    assert.equal(result.ok, false);
    const row = (await readLogs({ traceId: 'send-timeout', event: 'reply.finished' }))[0];
    assert.equal(row.outcome, 'unknown'); assert.equal(row.reason, 'ONEBOT_TIMEOUT');
    assert.equal(onebot.frames.length, before + 1);
  } finally { onebot.setAutoRespond(true); await drainSender(); }
});

test('tool executions and reused results retain trace identity without logging arguments', async () => {
  let round = 0, executions = 0;
  const result = await runToolConversation({ messages: [], tools: [{ type: 'function', function: { name: 'remember_fact' } }] },
    { execution: { maxToolRounds: 3, maxToolCalls: 3 } }, { sessionKey: 'p-555', mode: 'simulate', logContext: { traceId: 'tool-trace', source: 'test' } }, {
      completion: async (_, options) => {
        assert.equal(options.logContext.traceId, 'tool-trace');
        return ++round < 3 ? { message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + round, type: 'function', function: { name: 'remember_fact', arguments: JSON.stringify({ content: 'DO_NOT_LOG_TOOL_ARGUMENT' }) } }] } } : { content: 'done' };
      },
      execute: async (_, args, context) => { executions++; assert.equal(context.logContext.traceId, 'tool-trace'); return { ok: true }; },
    });
  assert.equal(result.content, 'done'); assert.equal(executions, 1);
  const rows = await readLogs({ traceId: 'tool-trace', event: 'tool.finished' });
  assert.equal(rows.length, 2); assert.equal(rows.filter(row => row.data.reused).length, 1);
  assert.ok(rows.every(row => row.source === 'test'));
  assert.ok(!JSON.stringify(rows).includes('DO_NOT_LOG_TOOL_ARGUMENT'));
});

test('authenticated log API exposes structured trace filters and rejects invalid time ranges', async () => {
  const token = 'strong-trace-admin-token-for-test';
  const admin = await startAdminServer({ token, port: 0, services: { readLogs: async query => ({ items: await readLogs(query) }) } });
  const base = `http://127.0.0.1:${admin.port}/api/logs`;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    assert.equal((await fetch(base + '?traceId=tool-trace')).status, 401);
    const response = await fetch(base + '?traceId=tool-trace&event=tool.finished&source=test', { headers });
    assert.equal(response.status, 200);
    const { items } = await response.json();
    assert.equal(items.length, 2); assert.ok(items.every(row => row.traceId === 'tool-trace'));
    assert.equal((await fetch(base + '?since=2027-01-01&until=2026-01-01', { headers })).status, 400);
  } finally { await admin.close(); }
});


test('disabled model admission is recorded without a network request', async () => {
  const { setUsagePolicy } = await import('../src/platform/usage-policy.js');
  const before = llm.requests.length;
  setUsagePolicy({ features: { chat: false } });
  try { await dispatch(message(777)); await drainSender(); }
  finally { setUsagePolicy(); }
  assert.equal(llm.requests.length, before);
  const rows = await readLogs({ sessionKey: 'p-777' });
  assert.equal(rows.find(row => row.event === 'model.request.rejected').reason, 'FEATURE_DISABLED');
  assert.ok(!rows.some(row => row.event === 'model.request.started'));
  assert.equal(new Set(rows.map(row => row.traceId)).size, 1);
});


test('successful model output can still fail business validation in the same scheduled trace', async () => {
  const { distillSession } = await import('../src/distill/distiller.js');
  await distillSession('p-888', [{ time: Math.floor(Date.now() / 1000), raw_message: 'local test', user_id: 888 }]);
  const rows = await readLogs({ sessionKey: 'p-888' });
  assert.equal(new Set(rows.map(row => row.traceId)).size, 1);
  assert.ok(rows.every(row => row.source === 'scheduled'));
  assert.equal(rows.find(row => row.event === 'model.request.finished').outcome, 'success');
  const result = rows.find(row => row.event === 'distill.finished');
  assert.equal(result.outcome, 'failed'); assert.equal(result.reason, 'invalid_patch');
});
