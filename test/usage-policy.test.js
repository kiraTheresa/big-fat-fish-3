import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = await mkdtemp(join(tmpdir(), 'fish-usage-policy-'));
process.env.DATA_DIR = root;
process.env.USAGE_DIR = join(root, 'initial');
process.env.CONFIG_PATH = join(root, 'absent.json');
process.env.DEEPSEEK_API_KEY = 'usage-secret-key';
process.env.IMAGE_API_KEY = 'image-secret-key';
const { config } = await import('../src/config.js');
const { beginUsage, finishUsage, setUsagePolicy, getUsagePolicy, usageDayStart, readUsageMonitor } = await import('../src/platform/usage-policy.js');
const { readUsageOverview, appendUsage } = await import('../src/store/usage-store.js');
const { chatCompletion } = await import('../src/llm.js');
const { generateImage } = await import('../src/imagegen.js');
const nativeFetch = globalThis.fetch;
let index = 0;
beforeEach(() => { config.usageDir = join(root, String(index++)); setUsagePolicy({}); globalThis.fetch = nativeFetch; });
after(async () => { globalThis.fetch = nativeFetch; await rm(root, { recursive: true, force: true }); });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('concurrent API attempts reserve the call budget before fetch; rejected calls are never charged', async () => {
  setUsagePolicy({ features: { chat: true }, limits: { maxCallsPerDay: 2 } });
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; await new Promise((resolve) => setTimeout(resolve, 25)); return response({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 10 } }); };
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => chatCompletion([], { sessionKey: 'g-1' })));
  assert.equal(fetches, 2);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 2);
  assert.ok(results.filter((item) => item.status === 'rejected').every((item) => item.reason.code === 'USAGE_LIMIT'));
  const overview = await readUsageOverview();
  assert.deepEqual(overview.totals, { calls: 2, successes: 2, failures: 0, unknownUsageCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 20, images: 0 });
  assert.equal(new Set(overview.items.map((item) => item.id)).size, 2);
  assert.deepEqual(JSON.parse(await readFile(join(config.usageDir, '.pending.json'), 'utf8')), []);
});

test('all feature gates stop at the shared gateways, before any fetch', async () => {
  setUsagePolicy({ features: { chat: false, vision: false, draw: false, distill: false }, limits: { maxCallsPerDay: 9 } });
  globalThis.fetch = () => { assert.fail('disabled feature must never fetch'); };
  for (const kind of ['chat', 'vision', 'distill']) await assert.rejects(chatCompletion([], { kind }), { code: 'FEATURE_DISABLED' });
  await assert.rejects(generateImage('anything'), { code: 'FEATURE_DISABLED' });
  assert.equal((await readUsageOverview()).totals.calls, 0);
  assert.deepEqual(getUsagePolicy(), { features: { chat: false, vision: false, draw: false, distill: false }, limits: { maxCallsPerDay: 9, maxTokensPerDay: 0 } });
});

test('gateway records failures, missing usage, known vision tokens and generated image count without payloads', async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    if (fetches === 1) return response({ error: { message: 'failed usage-secret-key https://cdn.example/a?token=hidden' } }, 400);
    if (fetches === 2) return response({ choices: [{ message: { content: 'no usage' } }] });
    if (fetches === 3) return response({ choices: [{ message: { content: 'vision ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    return response({ data: [{ b64_json: 'DO_NOT_LOG_IMAGE_BYTES' }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } });
  };
  await assert.rejects(chatCompletion([], { kind: 'vision', sessionKey: 'g-2' }), /HTTP 400/);
  await chatCompletion([], { sessionKey: 'g-2' });
  await chatCompletion([], { kind: 'vision', sessionKey: 'g-2' });
  await generateImage('DO_NOT_LOG_PROMPT', { sessionKey: 'p-3' });
  const overview = await readUsageOverview({ limit: 1 });
  assert.deepEqual(overview.totals, { calls: 4, successes: 3, failures: 1, unknownUsageCalls: 2, promptTokens: 30, completionTokens: 15, totalTokens: 45, images: 1 });
  assert.equal(overview.items.length, 1, 'item limit does not truncate aggregates');
  assert.equal(overview.byKind.find((entry) => entry.kind === 'vision').calls, 2);
  assert.equal(overview.bySession.find((entry) => entry.sessionKey === 'g-2').calls, 3);
  const all = await readUsageOverview({ limit: 100 });
  const serialized = JSON.stringify(all);
  for (const secret of ['usage-secret-key', 'hidden', 'DO_NOT_LOG_IMAGE_BYTES', 'DO_NOT_LOG_PROMPT']) assert.ok(!serialized.includes(secret));
  assert.ok(all.items.every((entry) => Number.isFinite(entry.elapsedMs) && entry.elapsedMs >= 0));
  assert.equal((await readUsageOverview({ sessionKey: 'g-2', kind: 'vision' })).totals.calls, 2);
});

test('reported token budget stops later requests, preserving unknown usage as unknown', async () => {
  setUsagePolicy({ limits: { maxTokensPerDay: 10 } });
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return response({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 11 } }); };
  await chatCompletion([]);
  await assert.rejects(chatCompletion([]), { code: 'USAGE_LIMIT' });
  assert.equal(fetches, 1);
  const monitor = await readUsageMonitor();
  assert.equal(monitor.today.totalTokens, 11);
  assert.equal(monitor.tokenLimitMode, 'reported-usage');
  assert.equal(monitor.inFlight.length, 0);
});

test('restart recovers an unfinished reservation and retains daily call limits without double counting finished IDs', async () => {
  const attempt = await beginUsage({ sessionKey: 'g-restart', model: 'm', kind: 'chat' });
  const source = `
    import { beginUsage, setUsagePolicy } from './src/platform/usage-policy.js';
    import { readUsageOverview } from './src/store/usage-store.js';
    setUsagePolicy({ limits: { maxCallsPerDay: 1 } });
    let code = null;
    try { await beginUsage({ sessionKey: 'g-restart', model: 'm' }); } catch (e) { code = e.code; }
    console.log(JSON.stringify({ code, overview: await readUsageOverview() }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
    cwd: process.cwd(), env: { ...process.env, USAGE_DIR: config.usageDir },
  });
  const child = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(child.code, 'USAGE_LIMIT');
  assert.equal(child.overview.totals.calls, 1);
  assert.equal(child.overview.totals.failures, 1);
  assert.equal(child.overview.items[0].status, 'interrupted');
  assert.equal(child.overview.items[0].id, attempt.id);
  // Simulate process death after completion row, before pending removal.
  await writeFile(join(config.usageDir, '.pending.json'), JSON.stringify([attempt]));
  const { stdout: repeated } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
    cwd: process.cwd(), env: { ...process.env, USAGE_DIR: config.usageDir },
  });
  assert.equal(JSON.parse(repeated.trim().split('\n').at(-1)).overview.totals.calls, 1);
});

test('time filters aggregate historical legacy rows; malformed lines and invalid session paths are rejected safely', async () => {
  await appendUsage('g-filter', { time: 100, total_tokens: 4 });
  await appendUsage('g-filter', { time: 200, kind: 'distill', total_tokens: 7 });
  assert.equal((await readUsageOverview({ since: 150, until: 200 })).totals.totalTokens, 7);
  await assert.rejects(readUsageOverview({ sessionKey: '../../escape' }), /Invalid usage session/);
  await assert.rejects(beginUsage({ sessionKey: '../escape', model: 'm' }), /Invalid usage session/);
  await assert.rejects(readUsageOverview({ since: 'not-a-date' }), /Invalid usage time/);
  assert.equal(usageDayStart(Date.parse('2026-10-26T15:59:59Z')), Date.parse('2026-10-25T16:00:00Z'));
  assert.equal(usageDayStart(Date.parse('2026-10-26T16:00:00Z')), Date.parse('2026-10-26T16:00:00Z'));
});

test('corrupt reservation state fails closed before fetch and surfaces storage health', async () => {
  await mkdir(config.usageDir, { recursive: true });
  await writeFile(join(config.usageDir, '.pending.json'), '{bad');
  globalThis.fetch = () => { assert.fail('unreadable budget cannot trigger fetch'); };
  await assert.rejects(chatCompletion([]), { code: 'USAGE_STORAGE' });
});

test('corrupt ledger cannot silently reopen a daily budget; monitoring stays available with unknown totals', async () => {
  setUsagePolicy({ limits: { maxCallsPerDay: 1 } });
  await mkdir(config.usageDir, { recursive: true });
  const ledger = join(config.usageDir, 'g-corrupt.jsonl');
  await writeFile(ledger, '{"time":');
  globalThis.fetch = () => { assert.fail('corrupt ledger must block fetch'); };
  await assert.rejects(readUsageOverview(), { code: 'USAGE_LEDGER_CORRUPT', status: 503 });
  await assert.rejects(chatCompletion([]), { code: 'USAGE_STORAGE' });
  const monitor = await readUsageMonitor();
  assert.equal(monitor.today, null);
  assert.equal(monitor.ledgerAvailable, false);
  assert.match(monitor.lastPersistenceError, /invalid record/);
  const { getUsageStoreStats } = await import('../src/store/usage-store.js');
  assert.match(getUsageStoreStats().lastReadError, /invalid record/);
  // Repairing the row restores health, but the recorded call still consumes cap.
  await writeFile(ledger, JSON.stringify({ time: Date.now(), kind: 'chat', total_tokens: 10 }) + '\n');
  await assert.rejects(chatCompletion([]), { code: 'USAGE_LIMIT' });
  assert.equal((await readUsageMonitor()).ledgerAvailable, true);
  assert.equal(getUsageStoreStats().lastReadError, null);
});

test('syntactically valid but invalid ledger records also block quota admission', async () => {
  await mkdir(config.usageDir, { recursive: true });
  const ledger = join(config.usageDir, 'g-invalid.jsonl');
  for (const record of [null, [], {}, { time: 'not-a-time' }, { time: Date.now(), total_tokens: '20' }, { time: Date.now(), total_tokens: -20 }, { time: Date.now(), usageKnown: true }]) {
    await writeFile(ledger, JSON.stringify(record) + '\n');
    await assert.rejects(readUsageOverview(), { code: 'USAGE_LEDGER_CORRUPT' });
    await assert.rejects(chatCompletion([]), { code: 'USAGE_STORAGE' });
  }
});
