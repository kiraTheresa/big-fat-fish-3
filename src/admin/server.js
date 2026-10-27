// Same-origin static console + authenticated JSON API. No shell execution or outbound chat API.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url));
const STATIC = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/prompt.js', ['prompt.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/styles.css', ['styles.css', 'text/css']]]);
const hash = (value) => createHash('sha256').update(value).digest();
function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function body(req, limit = 65536) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw Object.assign(new Error('需要 application/json'), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(`请求体超过 ${limit / 1024} KiB`), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON 格式不正确'), { status: 400 }); }
}
export async function startAdminServer({ host = '127.0.0.1', port = 3210, token, services, webDir = WEB_DIR }) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('ADMIN_TOKEN 至少需要 24 个字符');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ADMIN_PORT 不正确');
  const expected = hash(token);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz' && req.method === 'GET') return reply(res, 200, { ok: true });
      if (!url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, { error: '方法不支持' });
        const asset = STATIC.get(url.pathname);
        if (!asset) return reply(res, 404, { error: '页面不存在' });
        const contents = await readFile(join(webDir, asset[0]));
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` });
        return res.end(req.method === 'HEAD' ? undefined : contents);
      }
      // No CORS; explicitly reject foreign Origins as defense in depth. Token never enters URL/cookies.
      const origin = req.headers.origin;
      if (origin) {
        let allowed = false;
        try { allowed = new URL(origin).host === req.headers.host && ['http:', 'https:'].includes(new URL(origin).protocol); } catch {}
        if (!allowed) return reply(res, 403, { error: '跨站请求被拒绝' });
      }
      const bearer = String(req.headers.authorization ?? '');
      if (!bearer.startsWith('Bearer ') || !timingSafeEqual(hash(bearer.slice(7)), expected)) return reply(res, 401, { error: '请输入有效的管理令牌' });
      const query = Object.fromEntries(url.searchParams);
      if (query.limit !== undefined) {
        if (!/^\d+$/.test(query.limit)) throw new Error('limit 格式不正确');
        query.limit = Math.max(1, Math.min(200, Number(query.limit)));
      }
      for (const key of ['since', 'until']) {
        if (query[key] !== undefined && query[key] !== '') {
          const parsed = /^\d+$/.test(query[key]) ? Number(query[key]) : Date.parse(query[key]);
          if (!Number.isFinite(parsed)) throw new Error(`${key} 时间格式不正确`);
          query[key] = parsed;
        } else delete query[key];
      }
      for (const key of Object.keys(query)) if (query[key] === '') delete query[key];
      const route = `${req.method} ${url.pathname}`;
      if (url.pathname.startsWith('/api/prompt/') && services.prompt) {
        const action = `${req.method} ${url.pathname.slice('/api/prompt/'.length)}`;
        const prompt = services.prompt;
        if (action === 'GET workspace') return reply(res, 200, prompt.workspace());
        if (action === 'GET sessions') return reply(res, 200, await prompt.sessions());
        if (action === 'GET runs') return reply(res, 200, await prompt.listRuns());
        const runMatch = url.pathname.match(/^\/api\/prompt\/runs\/([a-f0-9-]{36})(?:\/images\/(\d+))?$/);
        if (req.method === 'GET' && runMatch) return reply(res, 200, runMatch[2] === undefined ? await prompt.readRun(runMatch[1]) : await prompt.readRunImage(runMatch[1], Number(runMatch[2])));
        const handlers = { 'PUT draft': 'saveDraft', 'POST restore': 'restore', 'POST review': 'review', 'POST publish': 'publish', 'POST snapshot': 'snapshot', 'POST preview': 'preview', 'POST tests': 'startTest' };
        if (handlers[action]) return reply(res, action === 'POST tests' ? 202 : 200, await prompt[handlers[action]](await body(req, 524288)));
      }
      if (route === 'GET /api/status') return reply(res, 200, await services.status());
      if (route === 'GET /api/config') return reply(res, 200, services.getSettings());
      if (route === 'PUT /api/config') return reply(res, 200, await services.updateSettings(await body(req)));
      if (route === 'GET /api/events') return reply(res, 200, await services.readEvents(query));
      if (route === 'GET /api/users') return reply(res, 200, services.listUsers());
      if (route === 'GET /api/jobs') return reply(res, 200, services.scheduler.list());
      if (route === 'POST /api/jobs') return reply(res, 201, await services.scheduler.create(await body(req)));
      if (route === 'GET /api/logs') return reply(res, 200, await services.readLogs(query));
      if (route === 'GET /api/usage') return reply(res, 200, await services.readUsageOverview(query));
      const user = url.pathname.match(/^\/api\/users\/(\d{1,20})$/);
      if (user && req.method === 'PUT') return reply(res, 200, await services.setUser(user[1], await body(req)));
      if (user && req.method === 'DELETE') return reply(res, 200, await services.deleteUser(user[1]));
      const job = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]{1,80})$/);
      if (job && req.method === 'PUT') return reply(res, 200, await services.scheduler.update(job[1], await body(req)));
      if (job && req.method === 'DELETE') return reply(res, 200, await services.scheduler.remove(job[1]));
      return reply(res, 404, { error: '接口不存在' });
    } catch (err) {
      const diskError = typeof err.code === 'string' && /^E[A-Z]+$/.test(err.code);
      reply(res, diskError ? 500 : err.status ?? 400, { error: diskError ? '文件读取或保存失败，请查看本机存储状态' : String(err.message).slice(0, 500) });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, port: server.address().port, close: async () => { server.closeIdleConnections(); await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); } };
}
