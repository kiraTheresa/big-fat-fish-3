// A shared-filesystem lease works across host/container PID namespaces.
// Hostname/PID are diagnostics only for v2; freshness comes from lock-directory mtime.
import { mkdir, readFile, unlink, access, realpath, open } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { atomicWriteJson } from './persistence.js';

// Keep these identical for every runtime sharing a directory. Do not make them env overrides.
export const RUNTIME_LOCK_STALE_MS = 30000;
const UPDATE_MS = 5000;
const STARTUP_RETRIES = 35;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Serialize the stale-check + removal + mkdir sequence: proper-lockfile alone can
// let multiple contenders remove one another's freshly reclaimed stale lease.
// This gate exists only during acquisition, never during normal Bot operation.
async function acquireGate(directory) {
  const file = join(directory, '.runtime-lock.acquire');
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.close();
      return () => unlink(file);
    } catch (err) { if (err.code !== 'EEXIST') throw err; }
    await delay(25);
  }
  throw new Error('运行锁接管正在进行，或上次启动被强制中断；请检查 data/.runtime-lock.acquire');
}

async function checkLegacyOwner(directory, file) {
  // Old versions did not renew locks. Never guess that a foreign legacy owner is dead.
  try {
    await access(join(directory, '.runtime-lock.gate'));
    throw new Error('发现旧版 data/.runtime-lock.gate；确认旧进程已停止后备份移走再启动');
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  let current;
  try { current = JSON.parse(await readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return; throw new Error('运行锁记录不可读，请检查 data/.runtime-lock.json', { cause: err }); }
  if (current?.version === 2) return; // The v2 lease has already been acquired exclusively.
  if (current?.hostname !== hostname() || !Number.isSafeInteger(current?.pid) || current.pid < 1) {
    throw new Error('发现其他运行环境留下的旧版运行锁；首次升级需确认旧实例已停止，再备份移走 data/.runtime-lock.json');
  }
  try { process.kill(current.pid, 0); }
  catch (err) { if (err.code === 'ESRCH') return; throw new Error('无法确认旧版 Bot 进程是否已退出', { cause: err }); }
  throw new Error('这个数据目录已有旧版 Bot 进程运行，请先停止旧进程');
}

export async function acquireRuntimeLock(dataDir, { retries = STARTUP_RETRIES } = {}) {
  await mkdir(dataDir, { recursive: true });
  const directory = await realpath(dataDir);
  const file = join(directory, '.runtime-lock.json');
  if (!Number.isInteger(retries) || retries < 0 || retries > STARTUP_RETRIES) throw new Error('Invalid runtime lock retries');
  let unlock;
  const identity = { version: 2, pid: process.pid, hostname: hostname(), nonce: randomUUID(), acquiredAt: new Date().toISOString() };
  for (let attempt = 0; ; attempt++) {
    const releaseGate = await acquireGate(directory);
    let busy;
    try {
      try {
        unlock = await lockfile.lock(directory, {
          lockfilePath: join(directory, '.runtime-lock.lease'),
          stale: RUNTIME_LOCK_STALE_MS,
          update: UPDATE_MS,
          retries: 0, // All contenders must hold the gate for each acquisition attempt.
          // Default onCompromised throws: losing the lease must stop further writes.
        });
      } catch (err) { if (err.code !== 'ELOCKED') throw err; busy = err; }
      if (unlock) {
        try {
          await checkLegacyOwner(directory, file);
          await atomicWriteJson(file, identity);
        } catch (err) { await unlock(); throw err; }
      }
    } finally { await releaseGate(); }
    if (unlock) break;
    if (attempt >= retries) {
      throw Object.assign(new Error('数据目录的运行锁仍在续期或尚未过期，请停止另一实例后重试（异常退出后约 30 秒恢复）', { cause: busy }), { code: 'ELOCKED' });
    }
    await delay(1000); // Do not hold the short-lived gate while waiting for a live owner.
  }

  let released = false;
  return async () => {
    if (released) return; // An old release callback must never remove a newer owner's lease.
    released = true;
    try {
      try {
        const current = JSON.parse(await readFile(file, 'utf8'));
        if (current.nonce === identity.nonce) await unlink(file);
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    } finally { await unlock(); }
  };
}
