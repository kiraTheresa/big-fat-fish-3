import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const root = await mkdtemp(join(tmpdir(), 'fish-gallery-'));
process.env.DATA_DIR = root;
const { saveGeneratedImage, saveMeme, mediaPaths, initializeMediaStore } = await import('../src/store/media-store.js');
const { collectMeme, updateMeme, recordMemeUse } = await import('../src/store/meme-library.js');
const { createMediaService } = await import('../src/admin/media-service.js');
const gallery = createMediaService();
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const GIF = Buffer.from('GIF89a-original-animation-content');
beforeEach(async () => { await rm(join(root, 'media'), { recursive: true, force: true }); await initializeMediaStore(); });
after(async () => { await rm(root, { recursive: true, force: true }); });
const metadataPath = (asset) => join(mediaPaths().root, dirname(asset.path), 'metadata.json');
const indexPath = () => join(mediaPaths().root, 'meme-library.json');
const libraryEntry = (asset, overrides = {}) => ({ id: asset.id, type: asset.memeType,
  fingerprint: 'a'.repeat(64), name: '共享名称', tags: ['共享标签'], enabled: true,
  createdAt: 1000, usedCount: 0, failureCount: 0, lastUsedAt: null, lastFailureAt: null,
  lastErrorCode: null, ...overrides });

test('绘图按时间分页、搜索提示词和模型、会话筛选；统计与选项不随筛选丢失', async () => {
  const first = await saveGeneratedImage(PNG.toString('base64'), { prompt: '蓝色海洋', model: 'MODEL-A', sessionKey: 'g-1', size: '1024x1024' });
  const second = await saveGeneratedImage(PNG.toString('base64'), { prompt: '森林', model: 'model-b', sessionKey: 'p-2' });
  const third = await saveGeneratedImage(PNG.toString('base64'), { prompt: '蓝色天空', model: 'model-c', sessionKey: 'g-1' });
  for (const [index, asset] of [first, second, third].entries()) {
    const path = metadataPath(asset); const value = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...value, createdAt: `2026-10-${20 + index}T00:00:00.000Z` }));
  }
  const a = await gallery.list({ limit: '2' });
  assert.deepEqual(a.items.map((item) => item.id), [third.id, second.id]);
  assert.equal(a.total, 3); assert.equal(a.nextOffset, 2);
  assert.deepEqual(a.counts, { generated: 3, memes: 0 });
  assert.deepEqual(a.sessions, ['g-1', 'p-2']);
  assert.equal(a.items[0].previewVariant, 'original');
  assert.equal(a.items[0].mimeType, 'image/png');
  const b = await gallery.list({ offset: '2', limit: 2 });
  assert.deepEqual(b.items.map((item) => item.id), [first.id]); assert.equal(b.nextOffset, null);
  assert.equal((await gallery.list({ q: 'model-a' })).items[0].id, first.id);
  assert.equal((await gallery.list({ q: '蓝色', sessionKey: 'g-1' })).total, 2);
  assert.equal((await gallery.list({ sessionKey: 'p-2' })).total, 1);
  assert.equal((await gallery.list({ offset: 999 })).items.length, 0);
});

test('表情使用共享目录中的名称、标签、状态和使用次数，原生无图仍显示；不泄漏发送参数', async () => {
  const native = await collectMeme('g-1', { type: 'mface', name: '旧名', tags: ['笑'],
    data: { emoji_id: '123', emoji_package_id: '456', key: 'native-secret', url: 'https://example.invalid/signed?secret=token' },
    source: { secret: 'private-source', sessionKey: 'g-1' } });
  await updateMeme('g-1', native.asset.id, { name: '开心', tags: ['喜悦', '肥鱼'] });
  await recordMemeUse('g-1', native.asset.id);
  const disabled = await collectMeme('p-2', { type: 'face', name: '内置', data: { id: '66' } });
  await updateMeme('p-2', disabled.asset.id, { enabled: false });
  await collectMeme('g-1', { type: 'mface', name: '未完整', data: { emoji_id: 'partial' } });
  await saveMeme({ type: 'image', name: '旧收藏', image: PNG });
  const result = await gallery.list({ kind: 'memes' });
  assert.equal(result.total, 4);
  const item = result.items.find((row) => row.id === native.asset.id);
  assert.equal(item.name, '开心'); assert.equal(item.status, 'available');
  assert.equal(item.memeType, 'mface'); assert.equal(item.previewVariant, null);
  assert.equal(item.originalAvailable, false); assert.equal(item.usedCount, 1);
  assert.deepEqual(item.tags, ['喜悦', '肥鱼']); assert.deepEqual(item.sessions, ['g-1']);
  for (const secret of ['native-secret', 'private-source', 'https://', 'emoji_package_id', 'send', 'base64']) assert.ok(!JSON.stringify(item).includes(secret));
  assert.equal((await gallery.list({ kind: 'memes', q: '喜悦' })).items[0].id, native.asset.id);
  for (const status of ['disabled', 'incomplete', 'uncollected']) assert.equal((await gallery.list({ kind: 'memes', status })).total, 1);
  assert.equal((await gallery.list({ kind: 'memes', sessionKey: 'g-1' })).total, 2);
});

test('v2 共享表情按历史来源筛选，群聊和私聊看到相同标签、状态和累计使用记录', async () => {
  const asset = await saveMeme({ type: 'mface', name: '原始名称', tags: ['原始标签'],
    data: { emoji_id: '123', emoji_package_id: '456', key: 'shared-secret' },
    source: { sessionKey: 'g-original', privateField: 'private-source-value' } });
  const tags = Array.from({ length: 35 }, (_, index) => `合并标签${index}`);
  const entry = libraryEntry(asset, { name: '共享开心', tags, sourceSessions: ['g-1', 'p-2'],
    enabled: false, usedCount: 7, lastUsedAt: 1760000000000 });
  await writeFile(indexPath(), JSON.stringify({ version: 2, entries: [entry] }));
  const all = await gallery.list({ kind: 'memes' });
  const group = await gallery.list({ kind: 'memes', sessionKey: 'g-1' });
  const privateChat = await gallery.list({ kind: 'memes', sessionKey: 'p-2' });
  assert.equal(all.total, 1);
  assert.deepEqual(group.items, all.items);
  assert.deepEqual(privateChat.items, all.items);
  const item = all.items[0];
  assert.equal(item.name, '共享开心'); assert.equal(item.status, 'disabled');
  assert.equal(item.usedCount, 7); assert.equal(item.lastUsedAt, entry.lastUsedAt);
  assert.deepEqual(item.tags, tags); assert.deepEqual(item.sessions, ['g-1', 'p-2']);
  assert.deepEqual(all.sessions, ['g-1', 'p-2']);
  assert.equal((await gallery.list({ kind: 'memes', q: '合并标签34', sessionKey: 'p-2', status: 'disabled' })).total, 1);
  assert.equal((await gallery.list({ kind: 'memes', sessionKey: 'p-other' })).total, 0);
  assert.equal((await gallery.list({ kind: 'memes', sessionKey: 'g-original' })).total, 0);
  for (const secret of ['shared-secret', 'private-source-value', 'fingerprint', 'emoji_package_id', 'send']) assert.ok(!JSON.stringify(all).includes(secret));
});

test('迁移前 v1 索引可只读浏览，来源选择不再切换同一表情的名称、状态和统计', async () => {
  const asset = await saveMeme({ type: 'face', data: { id: '66' } });
  const saved = { version: 1, sessions: {
    'p-2': [libraryEntry(asset, { name: '私聊命名', tags: ['私聊标签'], enabled: false, usedCount: 3, lastUsedAt: 2000 })],
    'g-1': [libraryEntry(asset, { name: '群聊命名', tags: ['群聊标签'], usedCount: 2, lastUsedAt: 1000 })],
  } };
  const serialized = JSON.stringify(saved);
  await writeFile(indexPath(), serialized);
  const group = await gallery.list({ kind: 'memes', sessionKey: 'g-1' });
  const privateChat = await gallery.list({ kind: 'memes', sessionKey: 'p-2' });
  assert.deepEqual(group.items, privateChat.items);
  assert.equal(group.items[0].name, '群聊命名');
  assert.equal(group.items[0].status, 'disabled');
  assert.equal(group.items[0].usedCount, 5); assert.equal(group.items[0].lastUsedAt, 2000);
  assert.deepEqual(group.items[0].tags, ['群聊标签', '私聊标签']);
  assert.deepEqual(group.items[0].sessions, ['g-1', 'p-2']);
  assert.equal(await readFile(indexPath(), 'utf8'), serialized);
});

test('v2 索引来源、条目和累计次数必须有效，坏索引不伪装成空收藏', async () => {
  const asset = await saveMeme({ type: 'face', data: { id: '66' } });
  const entry = libraryEntry(asset, { sourceSessions: ['g-1'] });
  for (const saved of [
    { version: 2, entries: {} },
    { version: 2, entries: [entry, entry] },
    { version: 2, entries: [{ ...entry, sourceSessions: ['../invalid'] }] },
    { version: 2, entries: [{ ...entry, sourceSessions: null }] },
    { version: 2, entries: [{ ...entry, usedCount: -1 }] },
  ]) {
    await writeFile(indexPath(), JSON.stringify(saved));
    await assert.rejects(gallery.list({ kind: 'memes' }), { status: 500 });
  }
});

test('原图和预览按实际字节 MIME 读取，GIF 字节保持完整，不依赖元数据声明', async () => {
  const asset = await saveMeme({ type: 'image', name: '动态', image: GIF, preview: PNG });
  const item = (await gallery.list({ kind: 'memes' })).items[0];
  assert.equal(item.previewVariant, 'preview');
  const record = JSON.parse(await readFile(metadataPath(asset), 'utf8'));
  await writeFile(metadataPath(asset), JSON.stringify({ ...record, mimeType: 'text/html' }));
  const original = await gallery.readFile({ key: item.key });
  assert.deepEqual(original.bytes, GIF); assert.equal(original.mimeType, 'image/gif');
  assert.equal(original.filename, 'image.gif');
  const preview = await gallery.readFile({ key: item.key, variant: 'preview' });
  assert.deepEqual(preview.bytes, PNG); assert.equal(preview.mimeType, 'image/png');
  assert.deepEqual(Object.keys(original).sort(), ['bytes', 'filename', 'mimeType']);
});

test('损坏元数据跳过并报告；缺图明确不可预览；损坏索引不能伪装成空库', async () => {
  const broken = await saveGeneratedImage(PNG.toString('base64'), { prompt: '损坏' });
  await writeFile(metadataPath(broken), '{bad');
  const missing = await collectMeme('g-1', { type: 'image', image: PNG, name: '丢失原图' });
  await rm(join(mediaPaths().root, missing.asset.path));
  const native = await saveMeme({ type: 'face', name: '无图', data: { id: '66' } });
  const result = await gallery.list({ kind: 'memes' });
  assert.equal(result.total, 2); assert.ok(result.warnings >= 2);
  assert.equal(result.items.find((item) => item.id === missing.asset.id).status, 'incomplete');
  await assert.rejects(gallery.readFile({ key: `memes/${native.id}` }), { status: 404 });
  await writeFile(join(mediaPaths().root, 'meme-library.json'), '{bad');
  await assert.rejects(gallery.list({ kind: 'memes' }), { status: 500 });
});

test('任意路径、伪装图片和符号链接都不能读取，目录中的临时记录不进入图库', async () => {
  const asset = await saveMeme({ type: 'image', image: PNG });
  const key = `memes/${asset.id}`;
  for (const input of ['../.env', `memes/${asset.id}/../../.env`, `memes/${asset.id}/image.png`, `memes/%2e%2e`, 'generated/../' + asset.id]) {
    await assert.rejects(gallery.readFile({ key: input }), { status: 400 });
  }
  await assert.rejects(gallery.readFile({ key, variant: '../metadata.json' }), { status: 400 });
  await writeFile(join(mediaPaths().root, asset.path), '<svg onload="alert(1)">');
  await assert.rejects(gallery.readFile({ key }), { status: 415 });
  await rm(join(mediaPaths().root, asset.path));
  const outside = join(root, 'outside.png'); await writeFile(outside, PNG);
  await symlink(outside, join(mediaPaths().root, asset.path));
  await assert.rejects(gallery.readFile({ key }), { status: 404 });
  const linkedId = randomUUID();
  await symlink(join(mediaPaths().memes, asset.id), join(mediaPaths().memes, linkedId));
  await assert.rejects(gallery.readFile({ key: `memes/${linkedId}` }), { status: 404 });
  await mkdir(join(mediaPaths().memes, `.${randomUUID()}.tmp`));
  const result = await gallery.list({ kind: 'memes' });
  assert.equal(result.total, 1); assert.equal(result.items[0].previewVariant, null); assert.ok(result.warnings >= 2);
  const metadata = JSON.parse(await readFile(metadataPath(asset), 'utf8'));
  await writeFile(metadataPath(asset), JSON.stringify({ ...metadata, filename: '../../../outside.png' }));
  await assert.rejects(gallery.readFile({ key }), { status: 404 });
});

test('超限文件拒绝，元数据文件或 media 根目录的符号链接不能绕过边界', async () => {
  const asset = await saveMeme({ type: 'image', image: PNG });
  const key = `memes/${asset.id}`;
  await truncate(join(mediaPaths().root, asset.path), 64 * 1024 * 1024 + 1);
  await assert.rejects(gallery.readFile({ key }), { status: 413 });
  const metadata = metadataPath(asset);
  const outside = join(root, 'outside-metadata.json');
  await writeFile(outside, await readFile(metadata));
  await rm(metadata); await symlink(outside, metadata);
  await assert.rejects(gallery.readFile({ key }), { status: 404 });
  await rm(mediaPaths().root, { recursive: true });
  const other = join(root, 'other-media'); await mkdir(other, { recursive: true });
  await symlink(other, mediaPaths().root);
  await assert.rejects(gallery.readFile({ key }), { status: 404 });
  await assert.rejects(gallery.list(), { status: 500 });
});

test('新实例为空列表，查询边界受控，未知格式生成物只展示信息不提供原始下载', async () => {
  await rm(mediaPaths().root, { recursive: true });
  assert.deepEqual(await gallery.list(), { items: [], total: 0, nextOffset: null, counts: { generated: 0, memes: 0 }, sessions: [], warnings: 0 });
  for (const input of [{ kind: 'all' }, { status: 'unknown' }, { offset: '-1' }, { limit: '0' }, { limit: 49 }, { offset: 1.5 }, { sessionKey: '../bad' }, { q: 'a'.repeat(301) }]) {
    await assert.rejects(gallery.list(input), { status: 400 });
  }
  const asset = await saveGeneratedImage(Buffer.from('unrecognized-payload').toString('base64'));
  const result = await gallery.list();
  assert.equal(result.items[0].previewVariant, null);
  assert.equal(result.items[0].status, 'incomplete');
  await assert.rejects(gallery.readFile({ key: dirname(asset.path) }), { status: 404 });
});
