import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, utimes, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireRuntimeLock, RUNTIME_LOCK_STALE_MS } from '../src/platform/runtime-lock.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fish-lease-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const acquire = (dir) => acquireRuntimeLock(dir, { retries: 0 });
async function metadata(dir) {
  // Container PID 1 may be alive in a new namespace: v2 must never probe it.
  await writeFile(join(dir, '.runtime-lock.json'), JSON.stringify({ version: 2, pid: 1, hostname: 'previous-container', nonce: 'old' }));
}

test('expired foreign/container lease recovers despite reused PID, concurrent recovery allows one winner', async (t) => {
  const dir = await fixture(t);
  await metadata(dir);
  const lease = join(dir, '.runtime-lock.lease');
  await mkdir(lease);
  const expired = new Date(Date.now() - RUNTIME_LOCK_STALE_MS - 5000);
  await utimes(lease, expired, expired);
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => acquire(dir)));
  const winners = results.filter((r) => r.status === 'fulfilled');
  assert.equal(winners.length, 1);
  const release = winners[0].value;
  t.after(release);
  assert.equal(JSON.parse(await readFile(join(dir, '.runtime-lock.json'))).pid, process.pid);
  await release();
  const next = await acquire(dir);
  await release();
  await assert.rejects(acquire(dir), { code: 'ELOCKED' });
  await next();
});

test('fresh foreign lease is not stolen or altered', async (t) => {
  const dir = await fixture(t);
  await metadata(dir);
  await mkdir(join(dir, '.runtime-lock.lease'));
  await assert.rejects(acquire(dir), { code: 'ELOCKED' });
  assert.equal(JSON.parse(await readFile(join(dir, '.runtime-lock.json'))).nonce, 'old');
});

test('unverifiable legacy foreign owner still requires explicit migration; no new lease is left behind', async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, '.runtime-lock.json'), JSON.stringify({ pid: 1, hostname: 'legacy-container', nonce: 'legacy' }));
  await assert.rejects(acquire(dir), /旧版运行锁/);
  await assert.rejects(stat(join(dir, '.runtime-lock.lease')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(dir, '.runtime-lock.json'))).nonce, 'legacy');
});

test('real process heartbeat advances lease; SIGKILL recovery and symlink aliases preserve exclusion', async (t) => {
  const dir = await fixture(t);
  const url = new URL('../src/platform/runtime-lock.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireRuntimeLock } from ${JSON.stringify(url)}; await acquireRuntimeLock(process.argv[1], {retries:0}); process.stdout.write('READY\\n'); setInterval(()=>{},1000);`, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', (code) => reject(new Error(`child exited: ${code}`))); });
  const before = (await stat(join(dir, '.runtime-lock.lease'))).mtimeMs;
  await assert.rejects(acquire(dir), { code: 'ELOCKED' });
  const alias = `${dir}-alias`;
  await symlink(dir, alias);
  t.after(() => rm(alias, { force: true }));
  await assert.rejects(acquire(alias), { code: 'ELOCKED' });
  const deadline = Date.now() + 8000;
  while ((await stat(join(dir, '.runtime-lock.lease'))).mtimeMs <= before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok((await stat(join(dir, '.runtime-lock.lease'))).mtimeMs > before);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  await metadata(dir);
  const expired = new Date(Date.now() - RUNTIME_LOCK_STALE_MS - 5000);
  await utimes(join(dir, '.runtime-lock.lease'), expired, expired);
  const release = await acquire(alias);
  t.after(release);
  await assert.rejects(acquire(dir), { code: 'ELOCKED' });
  await release();
});

test('independent processes reclaiming one stale lease cannot both enter the protected section', async (t) => {
  const dir = await fixture(t);
  await metadata(dir);
  await mkdir(join(dir, '.runtime-lock.lease'));
  const expired = new Date(Date.now() - RUNTIME_LOCK_STALE_MS - 5000);
  await utimes(join(dir, '.runtime-lock.lease'), expired, expired);
  const url = new URL('../src/platform/runtime-lock.js', import.meta.url).href;
  const script = `import { acquireRuntimeLock } from ${JSON.stringify(url)};
    try {
      const release = await acquireRuntimeLock(process.argv[1], {retries:0});
      process.on('message', async () => { await release(); process.exit(0); });
      process.send({acquired:true});
    } catch(error) { process.send({acquired:false,code:error.code,message:error.message}); process.disconnect(); }`;
  const children = Array.from({ length: 5 }, () => spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(() => children.forEach((child) => child.kill('SIGKILL')));
  const exits = children.map((child) => once(child, 'exit'));
  const responses = await Promise.all(children.map((child) => once(child, 'message').then(([message]) => message)));
  assert.equal(responses.filter((message) => message.acquired).length, 1);
  assert.ok(responses.filter((message) => !message.acquired).every((message) => message.code === 'ELOCKED'));
  children[responses.findIndex((message) => message.acquired)].send('release');
  await Promise.all(exits);
});
