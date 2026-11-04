import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer } from './mock-onebot.js';

const root = await mkdtemp(join(tmpdir(), 'fish-usage-report-'));
const wire = await startMockServer();
const replies = [];
const requests = [];
const model = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  const next = replies.shift();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: typeof next === 'function' ? next(body) : next ?? { role: 'assistant', content: '完成' } }] }));
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, { DATA_DIR: root, USAGE_DIR: join(root, 'usage'), PERSONA_DIR: join(root, 'personas'),
  CONFIG_PATH: join(root, 'none.json'), CHAT_COOLDOWN_MS: '0', CHAT_STREAM: 'false', DEEPSEEK_API_KEY: 'mock-key',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}`, ONEBOT_WS_URL: wire.url, ONEBOT_ACCESS_TOKEN: '', SEND_INTERVAL_MS: '1', API_TIMEOUT_MS: '1000' });
const { config } = await import('../src/config.js');
const { appendUsage } = await import('../src/store/usage-store.js');
const { readUsageReport, renderUsageReport, sendUsageReport } = await import('../src/usage/report.js');
const { executeTool, parseToolArguments, toolDefinitions } = await import('../src/tools/registry.js');
const { defaultPromptConfig } = await import('../src/prompt/defaults.js');
const { setUser } = await import('../src/platform/permissions.js');
const { dispatch } = await import('../src/dispatch/dispatcher.js');
const { register } = await import('../src/dispatch/registry.js');
const { drainSender } = await import('../src/sender/sender.js');
const { startAdminServer } = await import('../src/admin/server.js');
const { readUsageDashboard } = await import('../src/usage/overview.js');
const onebot = await import('../src/connection/onebot.js');
register((await import('../src/triggers/command.js')).default);
register((await import('../src/triggers/chat.js')).default);
config.behavior.reply.delay.enabled = false;
config.behavior.reply.quote.enabled = false;
onebot.startConnection();
await wire.waitForConnectionCount(1);
for (;;) { try { await onebot.callApi('get_login_info', {}); break; } catch (e) { if (!e.message.includes('WS 未连接')) throw e; await new Promise(r => setTimeout(r,10)); } }
const TOKEN = 'isolated-usage-report-api-token';
const admin = await startAdminServer({ port: 0, token: TOKEN, services: { readUsageReport, readUsageDashboard } });
after(async () => { await admin.close(); await drainSender(); onebot.stopConnection(); await wire.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(root, { recursive: true, force: true }); });
beforeEach(async () => { await drainSender(); wire.frames.length=0; replies.length=0; requests.length=0; });
let seq = 1;
const event = (text, group = 900) => ({ post_type:'message', message_type:group ? 'group' : 'private', ...(group ? { group_id:group } : {}),
  user_id:42, self_id:10000, time:Math.floor(Date.now()/1000), message_id:seq++, sender:{nickname:'测试'},
  message:[...(group ? [{type:'at',data:{qq:'10000'}}] : []),{type:'text',data:{text}}] });
const tool = (args = { period:'today' }, id = 'report') => ({ role:'assistant', content:null, tool_calls:[{id,type:'function',function:{name:'send_usage_report',arguments:JSON.stringify(args)}}] });
const png = bytes => { assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a'); assert.equal(bytes.readUInt32BE(16),900);assert.equal(bytes.readUInt32BE(20),1140); };

test('report PNG uses only summary data, with no raw session identifiers or extra admin fields', async () => {
  const overview = await readUsageDashboard({ sessionKey:'g-900' });
  const a = await renderUsageReport(overview);
  png(a);
  const b = await renderUsageReport({ ...overview, range:{...overview.range,sessionKey:'g-999999'}, bySession:[{sessionKey:'private-secret'}], accountBalance:'DO_NOT_SHARE', items:[{error:'SECRET'}] });
  assert.deepEqual(a,b,'Changing unrelated IDs/admin details must not alter the public image');
});

test('PNG and dashboard APIs require authentication; time/session validation reaches the real services', async () => {
  const base=`http://127.0.0.1:${admin.port}`;
  for (const path of ['/api/usage/report','/api/usage/dashboard']) assert.equal((await fetch(base+path)).status,401);
  const headers={Authorization:`Bearer ${TOKEN}`};
  const response=await fetch(base+'/api/usage/report?sessionKey=g-900&period=today',{headers});
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('cache-control'),'no-store');
  png(Buffer.from(await response.arrayBuffer()));
  assert.equal((await fetch(base+'/api/usage/report?period=all',{headers})).status,400);
  assert.equal((await fetch(base+'/api/usage/report?sessionKey=..%2Fsecret',{headers})).status,400);
  assert.equal((await fetch(base+'/usage.css')).status,200);
});

test('slash command sends exactly one real PNG to the bound group/private destination; unaddressed group commands are silent', async () => {
  const quiet=event('/usage');quiet.message.shift();await dispatch(quiet);await drainSender();assert.equal(wire.frames.length,0);
  await dispatch(event('/usage'));await drainSender();
  let frames=wire.frames.filter(f=>f.action==='send_msg');assert.equal(frames.length,1);assert.equal(frames[0].params.group_id,900);
  png(Buffer.from(frames[0].params.message[0].data.file.slice('base64://'.length),'base64'));
  wire.frames.length=0;await dispatch(event('/usage 7d',null));await drainSender();
  frames=wire.frames.filter(f=>f.action==='send_msg');assert.equal(frames.length,1);assert.equal(frames[0].params.user_id,42);
  assert.equal(frames[0].params.message_type,'private');
  assert.equal(requests.length,0,'Explicit usage command must not call the model');
});

test('natural-language model→tool→PNG path permits an empty final reply without extra messages', async () => {
  replies.push(tool(),{role:'assistant',content:null});
  await dispatch(event('今天吃了多少 token？'));await drainSender();
  const frames=wire.frames.filter(f=>f.action==='send_msg');assert.equal(frames.length,1);assert.equal(frames[0].params.message[0].type,'image');
  const definition=requests[0].tools.find(t=>t.function.name==='send_usage_report');
  assert.deepEqual(Object.keys(definition.function.parameters.properties),['period']);
  assert.deepEqual(definition.function.parameters.properties.period.enum,['today','7d','30d']);
  const output=JSON.parse(requests[1].messages.at(-1).content);assert.equal(output.ok,true);
  assert.ok(!JSON.stringify(output).includes('base64'));
});

test('tool simulation reads no ledger; live tools reject cross-session args, blocked callers and repeated attempts', async () => {
  const settings=defaultPromptConfig();
  for (const args of [{period:'today',sessionKey:'g-901'},{period:'all'},{period:'today',user_id:43}]) assert.throws(()=>parseToolArguments('send_usage_report',JSON.stringify(args)));
  assert.deepEqual(parseToolArguments('send_usage_report','{"period":"7d"}'),{period:'7d'});
  const ctx={event:event('统计'),sessionKey:'g-900',actorId:'42',reportTurn:{}};
  const simulated=await executeTool('send_usage_report',{period:'today'},{...ctx,mode:'simulate'},settings);assert.equal(simulated.simulated,true);assert.equal(wire.frames.length,0);
  await assert.rejects(sendUsageReport({...ctx,sessionKey:'g-901'}),/有效的当前会话/);
  wire.failNextCall();
  const failed=await executeTool('send_usage_report',{period:'today'},ctx,settings);assert.equal(failed.ok,false);
  await assert.rejects(executeTool('send_usage_report',{period:'7d'},ctx,settings),/重复发送/);
  await setUser('42',{role:'blocked'});
  try { assert.ok(!toolDefinitions(settings,'42').some(t=>t.function.name==='send_usage_report'));await assert.rejects(sendUsageReport(ctx),/有效的当前会话/); }
  finally { await setUser('42',{role:'user'}); }
});

test('scoped reports do not read other ledgers; a corrupt current ledger yields an error instead of a zero-cost image', async () => {
  await appendUsage('g-900',{time:Date.now(),total_tokens:12});
  await writeFile(join(config.usageDir,'g-999.jsonl'),'{broken');
  png(await readUsageReport({sessionKey:'g-900'}));
  await assert.rejects(readUsageReport(),{code:'USAGE_LEDGER_CORRUPT'});
  await writeFile(join(config.usageDir,'g-900.jsonl'),'{broken');
  await assert.rejects(readUsageReport({sessionKey:'g-900'}),{code:'USAGE_LEDGER_CORRUPT'});
});
