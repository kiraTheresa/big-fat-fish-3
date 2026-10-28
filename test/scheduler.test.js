import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler } from '../src/platform/scheduler.js';
import { readJson, atomicWriteJson } from '../src/platform/persistence.js';
const dir = await mkdtemp(join(tmpdir(), 'fish-jobs-'));
after(() => rm(dir, { recursive: true, force: true }));

test('旧内置间隔迁移：保留 ID、历史和启停状态，不覆盖手动任务或修改，重启不重复延后', async () => {
  let now = 1800000000000;
  const scheduler = new Scheduler({ dataDir: join(dir, 'migration'), clock: () => now, handlers: { distill: async () => {}, maintenance: async () => {} } });
  const old = [
    { name: '记忆提炼扫描', type: 'distill', enabled: true, schedule: { kind: 'interval', everyMs: 60000 } },
    { name: '观察数据保留清理', type: 'maintenance', enabled: true, schedule: { kind: 'interval', everyMs: 86400000 } },
  ];
  const defaults = old.map((job, i) => ({ ...job, schedule: { kind: 'interval', everyMs: i === 0 ? 300000 : 21600000 } }));
  await scheduler.initialize(old);
  const original = scheduler.list().items;
  const edited = await scheduler.create(old[0]);
  const created = await scheduler.create(old[1]);
  const saved = await readJson(scheduler.file);
  // Simulate an edited seed and a previously interrupted, disabled seed.
  delete saved.items[2].createdAt;
  saved.items[2].updatedAt = now;
  saved.items[0].enabled = false;
  saved.items[0].lastStatus = 'running';
  saved.items[0].lastRunAt = now - 1000;
  await atomicWriteJson(scheduler.file, saved);
  await scheduler.initialize(defaults, old);
  const migrated = scheduler.list().items;
  assert.equal(migrated[0].id, original[0].id);
  assert.equal(migrated[0].enabled, false);
  assert.equal(migrated[0].lastStatus, 'interrupted');
  assert.equal(migrated[0].lastRunAt, now - 1000);
  assert.equal(migrated[0].schedule.everyMs, 300000);
  assert.equal(migrated[0].nextRunAt, now + 300000);
  assert.equal(migrated[1].schedule.everyMs, 21600000);
  assert.equal(migrated[1].nextRunAt, now + 21600000);
  assert.equal(migrated.find((j) => j.id === edited.id).schedule.everyMs, 60000);
  assert.equal(migrated.find((j) => j.id === created.id).schedule.everyMs, 86400000);
  now += 10000;
  await scheduler.initialize(defaults, old);
  assert.equal(scheduler.list().items[0].nextRunAt, migrated[0].nextRunAt);
});

test('任务持久化、停用不运行、并发扫描只执行一次、错过周期不补发', async () => {
  let now = 1800000000000;
  let calls = 0;
  const scheduler = new Scheduler({ dataDir: dir, clock: () => now, handlers: { maintenance: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 10)); } } });
  await scheduler.initialize();
  const job = await scheduler.create({ name: '清理', type: 'maintenance', enabled: true, schedule: { kind: 'interval', everyMs: 1000 } });
  now += 10000;
  await Promise.all([scheduler.runDue(), scheduler.runDue(), scheduler.runDue()]);
  assert.equal(calls, 1);
  assert.equal(scheduler.list().items[0].nextRunAt, now + 1000);
  assert.equal(scheduler.list().items[0].lastStatus, 'success');
  await scheduler.update(job.id, { ...job, enabled: false });
  now += 2000;
  await scheduler.runDue();
  assert.equal(calls, 1);
  const restarted = new Scheduler({ dataDir: dir, clock: () => now, handlers: scheduler.handlers });
  await restarted.initialize();
  assert.equal(restarted.list().items[0].enabled, false);
});
test('单次任务失败也不重复执行，崩溃状态重启记 interrupted', async () => {
  let now = 1800001000000;
  const scheduler = new Scheduler({ dataDir: join(dir, 'once'), clock: () => now, handlers: { maintenance: async () => { throw new Error('模拟失败'); } } });
  await scheduler.initialize();
  await scheduler.create({ name: '单次', type: 'maintenance', enabled: true, schedule: { kind: 'once', at: new Date(now + 1000).toISOString() } });
  now += 1500;
  await scheduler.runDue();
  const result = scheduler.list().items[0];
  assert.equal(result.enabled, false);
  assert.equal(result.lastStatus, 'failed');
  const saved = await readJson(scheduler.file);
  saved.items[0].lastStatus = 'running';
  await atomicWriteJson(scheduler.file, saved);
  await scheduler.initialize();
  assert.equal(scheduler.list().items[0].lastStatus, 'interrupted');
  assert.equal(scheduler.list().items[0].enabled, false);
  await assert.rejects(scheduler.create({ name: '命令', type: 'shell', enabled: true, schedule: { kind: 'interval', everyMs: 1000 } }));
});
