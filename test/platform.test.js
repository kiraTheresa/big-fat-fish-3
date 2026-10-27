import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteJson, readJson, appendJsonl, readJsonl, flushPersistence } from '../src/platform/persistence.js';

const dir = await mkdtemp(join(tmpdir(), 'fish-platform-'));
process.env.DATA_DIR = dir;
process.env.CONFIG_PATH = join(dir, 'absent.json');
process.env.ADMIN_QQ = '10001';
const { config } = await import('../src/config.js');
const settings = await import('../src/platform/settings.js');
const permissions = await import('../src/platform/permissions.js');
after(async () => { await flushPersistence(); await rm(dir, { recursive: true, force: true }); });

test('原子替换与队列：并发写完成后文件完整，无临时残留；坏 JSON 明确失败', async () => {
  const file = join(dir, 'atomic.json');
  await Promise.all(Array.from({ length: 20 }, (_, i) => atomicWriteJson(file, { i })));
  assert.deepEqual(await readJson(file), { i: 19 });
  assert.equal((await readdir(dir)).filter((name) => name.endsWith('.tmp')).length, 0);
  await writeFile(file, '{bad');
  await assert.rejects(readJson(file, {}), SyntaxError);
});
test('JSONL 顺序、过滤和损坏行隔离；读取不存在文件为空', async () => {
  const file = join(dir, 'test.jsonl');
  await Promise.all(Array.from({ length: 15 }, (_, i) => appendJsonl(file, { time: i, kind: i % 2 })));
  assert.deepEqual((await readJsonl(file, { limit: 2, before: 12, filter: (row) => row.kind === 0 })).map((row) => row.time), [8, 10]);
  assert.deepEqual(await readJsonl(join(dir, 'none.jsonl')), []);
});
test('配置保存立即生效，版本冲突拒绝，重载仍保留；不向面板返回密钥', async () => {
  let applied;
  await settings.initializeSettings((policy) => { applied = policy; });
  const first = settings.getSettings();
  const next = structuredClone(first);
  next.behavior.trigger.at.enabled = false;
  next.policy.features.draw = false;
  const saved = await settings.updateSettings(next);
  assert.equal(config.behavior.trigger.at.enabled, false);
  assert.equal(applied.features.draw, false);
  assert.notEqual(saved.revision, first.revision);
  await assert.rejects(settings.updateSettings(first), (err) => err.status === 409);
  await settings.initializeSettings();
  assert.equal(settings.getSettings().behavior.trigger.at.enabled, false);
  assert.ok(!('imageApiKey' in saved.connection));
  const bad = structuredClone(saved);
  bad.behavior.reply.delay.maxMs = -1;
  await assert.rejects(settings.updateSettings(bad), /最长延迟/);
  assert.equal(settings.getSettings().revision, saved.revision);
});
test('权限：默认公开，环境管理员兼容；持久化封禁及角色撤销', async () => {
  await permissions.initializePermissions();
  assert.equal(permissions.canUseBot({ user_id: 42 }), true);
  assert.equal(permissions.canManageSession({ user_id: 42, message_type: 'group' }), false);
  assert.equal(permissions.canManageSession({ user_id: 42, message_type: 'private' }), true);
  assert.equal(permissions.getRole(10001), 'admin');
  await permissions.setUser('42', { role: 'admin', note: 'test' });
  assert.equal(permissions.canManageSession({ user_id: 42, message_type: 'group' }), true);
  await permissions.setUser('42', { role: 'blocked' });
  await permissions.initializePermissions();
  assert.equal(permissions.canUseBot({ user_id: 42 }), false);
  assert.equal(permissions.canManageSession({ user_id: 42, message_type: 'private' }), false);
  await assert.rejects(async () => permissions.setUser('../escape', { role: 'admin' }));
  await permissions.deleteUser('42');
  assert.equal(permissions.getRole(42), 'user');
  assert.equal(JSON.parse(await readFile(join(dir, 'management/users.json'))).version, 1);
});
