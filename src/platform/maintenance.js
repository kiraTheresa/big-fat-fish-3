import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
// Only prune named, dated observation files. Never delete chats, personas, roles, jobs or usage ledger.
export async function pruneObservations(dataDir, retentionDays, now = Date.now()) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) return { deleted: 0 };
  const cutoff = new Date(now - retentionDays * 86400000).toISOString().slice(0, 10);
  let deleted = 0;
  for (const bucket of ['logs', 'events']) {
    const dir = join(dataDir, bucket);
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name) || entry.name.slice(0, 10) >= cutoff) continue;
      await unlink(join(dir, entry.name));
      deleted += 1;
    }
  }
  return { deleted };
}
