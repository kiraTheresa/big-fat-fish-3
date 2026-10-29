import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startAdminServer } from '../src/admin/server.js';

const token = 'isolated-media-gallery-api-token';
const key = 'memes/12345678-1234-1234-1234-123456789abc';
const bytes = Buffer.from('GIF89a\0exact-animation-payload');
const calls = [];
const item = { key, id: key.split('/').at(-1), kind: 'memes', name: '开心', tags: ['高兴'],
  memeType: 'image', status: 'available', previewVariant: 'original', originalAvailable: true,
  sessions: ['g-42'], missingParameters: [] };
const services = { media: {
  async list(query) {
    calls.push(['list', query]);
    if (query.q === 'invalid') throw Object.assign(new Error('查询格式不正确'), { status: 400 });
    return { items: [item], total: 1, nextOffset: null, counts: { generated: 0, memes: 1 }, sessions: ['g-42'], warnings: 0 };
  },
  async readFile(query) {
    calls.push(['file', query]);
    if (query.key === 'missing') throw Object.assign(new Error('媒体不存在'), { status: 404 });
    if (query.key !== key || ![undefined, 'original', 'preview'].includes(query.variant)) throw Object.assign(new Error('媒体路径或预览类型无效'), { status: 400 });
    return { bytes, mimeType: 'image/gif', filename: 'image.gif' };
  },
} };
const server = await startAdminServer({ host: '127.0.0.1', port: 0, token, services });
const base = `http://127.0.0.1:${server.port}`;
const auth = { Authorization: `Bearer ${token}` };
const request = (path, options = {}) => fetch(base + path, { headers: auth, ...options });
after(async () => { await server.close(); });
beforeEach(() => { calls.length = 0; });

test('列表与图片原文件均需要 header 鉴权，URL 中的令牌不能代替登录', async () => {
  for (const path of ['/api/media', `/api/media/file?key=${encodeURIComponent(key)}`]) {
    assert.equal((await request(path, { headers: {} })).status, 401);
    assert.equal((await request(path, { headers: { Authorization: 'Bearer incorrect' } })).status, 401);
    assert.equal((await request(`${path}${path.includes('?') ? '&' : '?'}token=${token}`, { headers: {} })).status, 401);
  }
  assert.deepEqual(calls, [], '拒绝请求不能读取目录或图片内容');
});

test('外站 Origin 拒绝，合法同源请求读取经过过滤的媒体列表', async () => {
  for (const path of ['/api/media', `/api/media/file?key=${encodeURIComponent(key)}`]) {
    assert.equal((await request(path, { headers: { ...auth, Origin: 'https://other.example' } })).status, 403);
  }
  assert.deepEqual(calls, []);
  const response = await request('/api/media?kind=memes&q=%E5%BC%80%E5%BF%83&sessionKey=g-42&status=available&offset=24&limit=24', { headers: { ...auth, Origin: base } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.deepEqual(result.items, [item]);
  assert.deepEqual(calls, [['list', { kind: 'memes', q: '开心', sessionKey: 'g-42', status: 'available', offset: '24', limit: 24 }]]);
  assert.ok(!JSON.stringify(result).includes(token));
});

test('鉴权图片响应保持 GIF 原始字节，禁止缓存和 MIME 猜测', async () => {
  const response = await request(`/api/media/file?key=${encodeURIComponent(key)}&variant=original`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^image\/gif(?:;|$)/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(calls, [['file', { key, variant: 'original' }]]);
});

test('媒体浏览仅支持读取，写入方法不会落到列表或文件服务', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    for (const path of ['/api/media', `/api/media/file?key=${encodeURIComponent(key)}`]) {
      const response = await request(path, { method });
      assert.ok([404, 405].includes(response.status));
    }
  }
  assert.deepEqual(calls, []);
});

test('路径与文件错误保留清楚的状态码，输出不包含内部路径', async () => {
  const invalid = await request('/api/media/file?key=..%2F..%2F.env');
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: '媒体路径或预览类型无效' });
  const missing = await request('/api/media/file?key=missing');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: '媒体不存在' });
  const badQuery = await request('/api/media?q=invalid');
  assert.equal(badQuery.status, 400);
  assert.deepEqual(await badQuery.json(), { error: '查询格式不正确' });
});

test('展示台静态模块可读取，CSP 只允许受控本地 blob 预览', async () => {
  const js = await request('/media.js', { headers: {} });
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(await js.text(), /createMediaGallery/);
  const css = await request('/media.css', { headers: {} });
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const csp = css.headers.get('content-security-policy');
  assert.match(csp, /img-src[^;]*blob:/);
  assert.ok(!/img-src[^;]*(?:https?:|\*)/.test(csp));
});
