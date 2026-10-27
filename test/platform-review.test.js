import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { Scheduler } from '../src/platform/scheduler.js';
import { acquireRuntimeLock } from '../src/platform/runtime-lock.js';
import { flushPersistence } from '../src/platform/persistence.js';

const dir = await mkdtemp(join(tmpdir(), 'fish-platform-review-'));
process.env.DATA_DIR = dir;
process.env.CONFIG_PATH = join(dir, 'absent.json');
process.env.ADMIN_QQ = '10001';
const { config } = await import('../src/config.js');
const permissions = await import('../src/platform/permissions.js');
const settings = await import('../src/platform/settings.js');
after(async () => { await flushPersistence(); await rm(dir, { recursive: true, force: true }); });

test('observed users follow current ADMIN_QQ across restart; explicit management overrides stay authoritative', async () => {
  await permissions.initializePermissions();
  await permissions.observeUser({ user_id: 10001, sender: { nickname: 'former admin' } });
  await permissions.observeUser({ user_id: 10002, sender: { nickname: 'new admin' } });
  assert.equal(permissions.getRole(10001), 'admin');
  assert.equal(permissions.getRole(10002), 'user');
  config.adminQq = ['10002'];
  await permissions.initializePermissions();
  assert.equal(permissions.getRole(10001), 'user', 'removing env admin revokes observed role');
  assert.equal(permissions.getRole(10002), 'admin', 'adding env admin promotes observed user');
  const listed = permissions.listUsers().items;
  assert.equal(listed.find((user) => user.id === '10001').role, 'user');
  assert.equal(listed.find((user) => user.id === '10002').role, 'admin');
  await permissions.setUser('10002', { role: 'blocked' });
  await permissions.initializePermissions();
  assert.equal(permissions.getRole(10002), 'blocked', 'explicit block overrides env admin');
  await permissions.deleteUser('10002');
  assert.equal(permissions.getRole(10002), 'admin', 'restore default returns to current env role');
});

test('a slow interval job does not starve another due job, and next run waits a full interval after finish', async () => {
  let now = 1800000000000;
  const calls = [];
  const scheduler = new Scheduler({ dataDir: join(dir, 'fair'), clock: () => now, handlers: {
    slow: async () => { calls.push('slow'); now += 2000; },
    maintenance: async () => { calls.push('maintenance'); },
  } });
  await scheduler.initialize();
  await scheduler.create({ name: 'slow', type: 'slow', enabled: true, schedule: { kind: 'interval', everyMs: 1000 } });
  await scheduler.create({ name: 'maintenance', type: 'maintenance', enabled: true, schedule: { kind: 'interval', everyMs: 1000 } });
  now += 2000;
  await scheduler.runDue();
  const slow = scheduler.list().items.find((job) => job.type === 'slow');
  assert.equal(slow.nextRunAt, now + 1000);
  await scheduler.runDue();
  assert.deepEqual(calls, ['slow', 'maintenance']);
  await scheduler.runDue();
  assert.equal(calls.length, 2, 'finished jobs do not immediately run again');
});

test('when jobs become due together, oldest scheduled run wins over insertion order', async () => {
  let now = 1800000000000;
  const calls = [];
  const scheduler = new Scheduler({ dataDir: join(dir, 'oldest'), clock: () => now, handlers: {
    later: async () => { calls.push('later'); }, earlier: async () => { calls.push('earlier'); },
  } });
  await scheduler.initialize();
  await scheduler.create({ name: 'inserted first, due later', type: 'later', enabled: true, schedule: { kind: 'interval', everyMs: 10000 } });
  await scheduler.create({ name: 'inserted second, due earlier', type: 'earlier', enabled: true, schedule: { kind: 'interval', everyMs: 1000 } });
  now += 20000;
  await scheduler.runDue();
  await scheduler.runDue();
  assert.deepEqual(calls, ['earlier', 'later']);
});

test('legacy empty/newline split separators remain valid live settings', async () => {
  await settings.initializeSettings();
  for (const separator of ['', '\n\n']) {
    const value = settings.getSettings();
    value.behavior.reply.split.separator = separator;
    await settings.updateSettings(value);
    await settings.initializeSettings();
    assert.equal(settings.getSettings().behavior.reply.split.separator, separator);
  }
});


test('concurrent runtime acquisition allows exactly one writer; release permits a new owner', async () => {
  const folder = join(dir, 'live-lock');
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => acquireRuntimeLock(folder, { retries: 0 })));
  const acquired = attempts.filter((result) => result.status === 'fulfilled');
  assert.equal(acquired.length, 1);
  assert.equal(attempts.filter((result) => result.status === 'rejected').length, 4);
  const identity = JSON.parse(await readFile(join(folder, '.runtime-lock.json'), 'utf8'));
  assert.equal(identity.pid, process.pid);
  await acquired[0].value();
  await assert.rejects(access(join(folder, '.runtime-lock.json')), { code: 'ENOENT' });
  const release = await acquireRuntimeLock(folder, { retries: 0 });
  // Calling an older owner's release after replacement must leave the new owner intact.
  await acquired[0].value();
  await access(join(folder, '.runtime-lock.json'));
  await release();
});

test('simultaneous stale-lock recovery cannot produce two writers', async () => {
  const folder = await mkdtemp(join(dir, 'stale-lock-'));
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  await writeFile(join(folder, '.runtime-lock.json'), JSON.stringify({ pid: child.pid, hostname: hostname(), nonce: 'dead-owner' }));
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => acquireRuntimeLock(folder, { retries: 0 })));
  const acquired = attempts.filter((result) => result.status === 'fulfilled');
  assert.equal(acquired.length, 1);
  const identity = JSON.parse(await readFile(join(folder, '.runtime-lock.json'), 'utf8'));
  assert.equal(identity.pid, process.pid);
  assert.notEqual(identity.nonce, 'dead-owner');
  await acquired[0].value();
});

test('abandoned reclaim gate fails closed without deleting it or the ownership evidence', async () => {
  const folder = await mkdtemp(join(dir, 'gate-lock-'));
  await writeFile(join(folder, '.runtime-lock.gate'), 'abandoned');
  const marker = JSON.stringify({ pid: 123, hostname: 'another-host', nonce: 'keep' });
  await writeFile(join(folder, '.runtime-lock.json'), marker);
  await assert.rejects(acquireRuntimeLock(folder, { retries: 0 }), /runtime-lock.gate/);
  assert.equal(await readFile(join(folder, '.runtime-lock.gate'), 'utf8'), 'abandoned');
  assert.equal(await readFile(join(folder, '.runtime-lock.json'), 'utf8'), marker);
});
