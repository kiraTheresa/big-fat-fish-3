import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAdminServer } from '../src/admin/server.js';
const TOKEN = 'a-strong-test-admin-token-123456';
let writes = 0;
const admin = await startAdminServer({ port: 0, token: TOKEN, services: {
  status: () => ({ uptimeSeconds: 12, connection: { connected: false } }),
  getSettings: () => ({ revision: '1', behavior: {} }),
  updateSettings: (body) => { if (body.revision !== '1') throw Object.assign(new Error('stale'), { status: 409 }); writes++; return { revision: '2' }; },
  setUser: (id, body) => ({ id, ...body }),
  readEvents: (query) => ({ items: [], query }),
  readLogs: () => ({ items: [] }),
} });
const base = `http://127.0.0.1:${admin.port}`;
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
after(() => admin.close());
test('健康检查公开，所有管理 API 必须鉴权且响应不可缓存', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const response = await fetch(`${base}/api/status`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).connection.connected, false);
});
test('拒绝跨域写入、过期配置及非法 JSON；正确配置可写入', async () => {
  const route = `${base}/api/config`;
  assert.equal((await fetch(route, { method: 'PUT', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(route, { method: 'PUT', headers, body: '{bad' })).status, 400);
  assert.equal((await fetch(route, { method: 'PUT', headers, body: '{"revision":"old"}' })).status, 409);
  assert.equal((await fetch(route, { method: 'PUT', headers, body: '{"revision":"1"}' })).status, 200);
  assert.equal(writes, 1);
});
test('分页上限、目录穿越拒绝、用户 ID 校验、超大请求拒绝', async () => {
  const result = await fetch(`${base}/api/events?limit=9999`, { headers });
  assert.equal((await result.json()).query.limit, 200);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/api/users/..%2fsecret`, { method: 'PUT', headers, body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/api/config`, { method: 'PUT', headers, body: JSON.stringify({ blob: 'x'.repeat(70000) }) })).status, 413);
});
