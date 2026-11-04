import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger, configureLogger, flushLogs, readLogs, getLogStats } from '../src/utils/logger.js';

const root = await mkdtemp(join(tmpdir(), 'fish-logs-'));
after(async () => { await flushLogs(); configureLogger({ dataDir: null, secrets: [] }); await rm(root, { recursive: true, force: true }); });

test('structured log file keeps useful error detail, filters by level/text and redacts credentials, signed URLs and image bodies', async () => {
  configureLogger({ dataDir: root, secrets: ['my-secret-key'], level: 'INFO', retentionDays: 7 });
  logger.info('ready');
  logger.warn('upstream HTTP 400', {
    status: 400, apiKey: 'other-key', authorization: 'Bearer another-secret',
    url: 'https://cdn.example/pic?access_token=signed-value',
    error: 'my-secret-key Bearer private-token',
    image: 'data:image/png;base64,abcdef123', prompt: 'user-private-prompt',
  });
  logger.debug('hidden-by-level');
  await flushLogs();
  const logs = await readLogs({ level: 'warn', q: 'HTTP 400' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'WARN');
  assert.match(logs[0].message, /status.*400/);
  const all = JSON.stringify(await readLogs());
  for (const sensitive of ['my-secret-key', 'other-key', 'another-secret', 'access_token', 'signed-value', 'private-token', 'abcdef123', 'user-private-prompt', 'hidden-by-level']) assert.ok(!all.includes(sensitive), sensitive);
  const files = await readdir(join(root, 'logs'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  const disk = await readFile(join(root, 'logs', files[0]), 'utf8');
  assert.ok(!disk.includes('my-secret-key'));
  assert.equal(disk.trim().split('\n').length, 2);
  assert.equal(getLogStats().pendingWrites, 0);
});

test('retention only deletes expired daily log files; malformed lines do not block queries', async () => {
  const nextRoot = join(root, 'retention');
  await mkdir(join(nextRoot, 'logs'), { recursive: true });
  await writeFile(join(nextRoot, 'logs', '2000-01-01.jsonl'), '{}\n');
  await writeFile(join(nextRoot, 'logs', 'keep.txt'), 'unrelated');
  configureLogger({ dataDir: nextRoot, level: 'ERROR', retentionDays: 1 });
  logger.info('filtered');
  logger.error('retained error');
  await flushLogs();
  assert.ok(!(await readdir(join(nextRoot, 'logs'))).includes('2000-01-01.jsonl'));
  assert.ok((await readdir(join(nextRoot, 'logs'))).includes('keep.txt'));
  assert.equal((await readLogs({ limit: 1 }))[0].message, 'retained error');
  assert.equal((await readLogs({ before: '2001-01-01T00:00:00Z' })).length, 0);
});

test('logging persistence errors never crash the application and are visible in health stats', async () => {
  const badRoot = join(root, 'regular-file');
  await writeFile(badRoot, 'x');
  configureLogger({ dataDir: badRoot });
  logger.error('safe failure');
  await flushLogs();
  assert.equal(getLogStats().pendingWrites, 0);
  assert.equal(typeof getLogStats().lastError, 'string');
});

test('opaque cursors paginate every same-millisecond row, including historical rows without IDs and concurrent appends', async () => {
  const pagingRoot = join(root, 'pagination');
  const directory = join(pagingRoot, 'logs');
  await mkdir(directory, { recursive: true });
  configureLogger({ dataDir: pagingRoot, level: 'INFO' });
  const time = new Date().toISOString();
  const day = time.slice(0, 10);
  const file = join(directory, `${day}.jsonl`);
  await writeFile(file, [
    JSON.stringify({ time, level: 'INFO', message: 'legacy oldest' }),
    'corrupt historical log line',
    JSON.stringify({ id: 'row-a', time, level: 'WARN', message: 'identified middle' }),
    JSON.stringify({ time, level: 'INFO', message: 'legacy middle' }),
    JSON.stringify({ id: 'row-b', time, level: 'INFO', message: 'identified newest' }),
  ].join('\n') + '\n');
  const first = await readLogs({ limit: 2 });
  assert.deepEqual(first.map((row) => row.message), ['identified newest', 'legacy middle']);
  assert.equal(first[1].id, `legacy-${day}-4`);
  assert.ok(first.every((row) => row.cursor.startsWith('log1.')));
  // New appends must not shift the cursor or make an older page repeat rows.
  const { appendFile } = await import('node:fs/promises');
  await appendFile(file, JSON.stringify({ id: 'row-c', time, level: 'INFO', message: 'appended after page one' }) + '\n');
  const second = await readLogs({ limit: 2, before: first.at(-1).cursor });
  assert.deepEqual(second.map((row) => row.message), ['identified middle', 'legacy oldest']);
  assert.equal(new Set([...first, ...second].map((row) => row.id)).size, 4);
  assert.deepEqual(await readLogs({ limit: 2, before: second.at(-1).cursor }), []);
  const filtered = await readLogs({ limit: 1, q: 'legacy' });
  assert.deepEqual((await readLogs({ limit: 1, q: 'legacy', before: filtered[0].cursor })).map((row) => row.message), ['legacy oldest']);
  assert.equal((await readLogs({ limit: 10 })).find((row) => row.message === 'legacy middle').id, first[1].id);
  await assert.rejects(readLogs({ before: 'log1.not-valid-json' }), /Invalid log cursor/);
  const badPath = `log1.${Buffer.from(JSON.stringify({ day: '../../secret', line: 2 })).toString('base64url')}`;
  await assert.rejects(readLogs({ before: badPath }), /Invalid log cursor/);
});

test('new persisted log rows have stable unique IDs returned by later reads', async () => {
  const identityRoot = join(root, 'identities');
  configureLogger({ dataDir: identityRoot, level: 'INFO' });
  logger.info('one');
  logger.info('two');
  await flushLogs();
  const first = await readLogs();
  const second = await readLogs();
  assert.equal(first.length, 2);
  assert.equal(new Set(first.map((row) => row.id)).size, 2);
  assert.deepEqual(first.map((row) => row.id), second.map((row) => row.id));
  const file = (await readdir(join(identityRoot, 'logs')))[0];
  const persisted = (await readFile(join(identityRoot, 'logs', file), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(first.map((row) => row.id), persisted.reverse().map((row) => row.id));
});


test('business events retain structured fields below the diagnostic level, redact payloads and support exact filters', async () => {
  const eventRoot = join(root, 'events');
  configureLogger({ dataDir: eventRoot, level: 'ERROR', secrets: ['event-secret'] });
  logger.info('diagnostic filtered');
  const id = logger.event('model.request.finished', { traceId: 'trace-a', operationId: 'attempt-a', sessionKey: 'g-1', source: 'live',
    outcome: 'failed', reason: 'upstream_busy', elapsedMs: 263,
    data: { httpStatus: 503, prompt: 'private text', apiKey: 'event-secret', error: 'Bearer event-secret' } });
  logger.event('reply.finished', { traceId: 'trace-b', operationId: 'send-b', outcome: 'confirmed' });
  const rows = await readLogs({ traceId: 'trace-a', event: 'model.request.finished', outcome: 'failed', source: 'live', sessionKey: 'g-1', operationId: 'attempt-a' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].schemaVersion, 1);
  assert.equal(rows[0].elapsedMs, 263);
  assert.equal(rows[0].data.httpStatus, 503);
  assert.equal(rows[0].data.prompt, '[REDACTED]');
  assert.equal((await readLogs({ traceId: 'trace' })).length, 0);
  assert.equal((await readLogs()).length, 2);
  const persisted = await readFile(join(eventRoot, 'logs', rows[0].time.slice(0, 10) + '.jsonl'), 'utf8');
  for (const value of ['event-secret', 'private text', 'diagnostic filtered']) assert.ok(!persisted.includes(value));
  assert.equal((await readLogs({ since: rows[0].time, until: rows[0].time, traceId: 'trace-a' })).length, 1);
  await assert.rejects(readLogs({ since: 'invalid' }), /Invalid log time/);
  await assert.rejects(readLogs({ since: Infinity }), /Invalid log time/);
  await assert.rejects(readLogs({ traceId: {} }), /Invalid log filter/);
  assert.throws(() => logger.event('invalid name'), /Invalid business event/);
  assert.throws(() => logger.event('valid.event', { elapsedMs: -1 }), /Invalid event duration/);
});

test('business events preserve cursor pagination, cap detail size and expose write failures without recursion', async () => {
  const eventRoot = join(root, 'event-pagination');
  configureLogger({ dataDir: eventRoot, level: 'ERROR' });
  for (let i = 0; i < 4; i++) logger.event('reply.finished', { traceId: 'page-trace', data: { i } });
  const first = await readLogs({ traceId: 'page-trace', limit: 2 });
  logger.event('reply.finished', { traceId: 'page-trace', data: { i: 4 } });
  const second = await readLogs({ traceId: 'page-trace', limit: 2, before: first.at(-1).cursor });
  assert.equal(new Set([...first, ...second].map(row => row.id)).size, 4);
  assert.deepEqual([...first, ...second].map(row => row.data.i), [3, 2, 1, 0]);
  logger.event('payload.received', { traceId: 'large', data: Object.fromEntries(Array.from({length: 8}, (_, i) => [i, 'word '.repeat(900)])) });
  assert.equal((await readLogs({ traceId: 'large' }))[0].data.omitted, true);
  const invalidRoot = join(root, 'event-no-directory');
  await writeFile(invalidRoot, 'file');
  configureLogger({ dataDir: invalidRoot });
  logger.event('reply.finished', { outcome: 'confirmed' });
  await flushLogs();
  assert.equal(getLogStats().pendingWrites, 0);
  assert.equal(typeof getLogStats().lastError, 'string');
});
