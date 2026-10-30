import { join } from 'node:path';
import { readdir, unlink } from 'node:fs/promises';
import { config } from '../config.js';
import { atomicWriteJson, readJson, withStorageLock } from '../platform/persistence.js';
const dir = () => join(config.dataDir, 'prompt-runs');
export function sanitizeTrace(value) {
  const secrets = [config.deepseekApiKey, config.imageApiKey, config.adminToken, config.accessToken].filter(Boolean);
  let redacted = false;
  const clean = (item) => {
    if (typeof item === 'string') {
      let text = item;
      for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
      text = text.replace(/data:[^\s;,]+;base64,[A-Za-z0-9+/=_-]+/gi, '[图片数据已省略]')
        .replace(/base64:\/\/[A-Za-z0-9+/=_-]+/gi, '[图片数据已省略]')
        .replace(/https?:\/\/[^\s"<>]+/g, (url) => { try { const parsed = new URL(url); if (!parsed.search && !parsed.username && !parsed.password) return url; return `${parsed.origin}${parsed.pathname}?[URL 参数已省略]`; } catch { return url; } });
      if (text.length > 24000) text = text.slice(0, 24000) + '\n[内容已截断]';
      if (text !== item) redacted = true;
      return text;
    }
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, v]) => [key, clean(v)]));
    return item;
  };
  const result = clean(value);
  return { ...result, redacted: redacted || value.redacted === true };
}
export async function saveRun(run) {
  const safe = sanitizeTrace(run);
  await withStorageLock(`${dir()}.index`, async () => {
    await atomicWriteJson(join(dir(), `${run.id}.json`), safe);
    const rows = (await listRuns()).items;
    for (const old of rows.filter((r) => r.status !== 'running').slice(50)) {
      for (const name of await readdir(dir())) if (name === `${old.id}.json` || name.startsWith(`${old.id}-image-`)) await unlink(join(dir(), name));
    }
  });
  return safe;
}
export async function readRun(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('运行 ID 不正确');
  const run = await readJson(join(dir(), `${id}.json`), null);
  if (!run) throw Object.assign(new Error('运行记录不存在或已过期'), { status: 404 });
  return run;
}
export async function listRuns() {
  let names;
  try { names = await readdir(dir()); } catch (error) { if (error.code === 'ENOENT') return { items: [] }; throw error; }
  const rows = [];
  for (const name of names.filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))) {
    const row = await readJson(join(dir(), name), null);
    if (row) rows.push({ id: row.id, createdAt: row.createdAt, source: row.source, status: row.status, sessionKey: row.sessionKey, version: row.version, revision: row.revision, kind: row.kind, error: row.error });
  }
  return { items: rows.sort((a, b) => b.createdAt - a.createdAt) };
}

export async function saveRunImage(id, index, b64, prompt) {
  if (b64.length > 16000000) throw new Error('测试图片超过 12 MB 展示上限');
  await atomicWriteJson(join(dir(), `${id}-image-${index}.json`), { b64, prompt });
}
export async function readRunImage(id, index) {
  const run = await readRun(id);
  if (!Number.isInteger(index) || index < 0 || index >= (run.imageCount ?? 0)) throw new Error('图片不存在');
  const image = await readJson(join(dir(), `${id}-image-${index}.json`), null);
  if (!image) throw new Error('图片已过期');
  return image;
}
