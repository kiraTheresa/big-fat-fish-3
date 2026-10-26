// Single-writer guard. A brief exclusive reclaim gate makes stale-lock recovery atomic
// with respect to other starters; an abandoned gate fails closed for manual inspection.
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function acquireRuntimeLock(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, '.runtime-lock.json');
  const gateFile = join(dataDir, '.runtime-lock.gate');
  let gate;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { gate = await open(gateFile, 'wx', 0o600); break; }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!gate) throw new Error('另一个进程正在取得运行锁；若启动进程已退出，请检查 data/.runtime-lock.gate');
  const identity = { pid: process.pid, hostname: hostname(), nonce: randomUUID() };
  try {
    let current;
    try { current = JSON.parse(await readFile(file, 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw new Error('运行锁不可读，请先确认旧 Bot 已停止再检查 data/.runtime-lock.json'); }
    if (current) {
      if (current.hostname !== hostname() || !Number.isSafeInteger(current.pid) || current.pid < 1) throw new Error('数据目录被其他主机或未知进程占用');
      let alive = true;
      try { process.kill(current.pid, 0); } catch (err) { if (err.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('这个数据目录已有 Bot 进程运行，请先停止旧进程');
      await unlink(file);
    }
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(identity)); await handle.sync(); }
    finally { await handle.close(); }
  } finally { await gate.close(); await unlink(gateFile); }
  return async () => {
    try { const current = JSON.parse(await readFile(file, 'utf8')); if (current.nonce === identity.nonce) await unlink(file); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  };
}
