import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'fish-meme-library-'));
process.env.DATA_DIR = root;
const { collectMeme, searchMemes, getScopedMeme, recordMemeUse, updateMeme } = await import('../src/store/meme-library.js');
const { mediaPaths } = await import('../src/store/media-store.js');
after(async () => { await rm(root, { recursive: true, force: true }); });

const image = (suffix = '') => ({ type: 'image', image: Buffer.from(`GIF89a-original-${suffix}`), data: { sub_type: 1, summary: '[动画表情]' }, name: '躺平', tags: ['加班', '疲惫'] });

test('并发收藏相同原图仅创建一条记录，跨会话独立且不能越权读取', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => collectMeme('g-1', image())));
  assert.equal(results.filter((item) => !item.duplicate).length, 1);
  assert.equal(new Set(results.map((item) => item.asset.id)).size, 1);
  assert.equal((await searchMemes('g-1', '')).length, 1);
  const other = await collectMeme('g-2', image());
  assert.notEqual(other.asset.id, results[0].asset.id);
  await assert.rejects(getScopedMeme('g-2', results[0].asset.id), { code: 'MEME_NOT_FOUND' });
  await assert.rejects(updateMeme('g-2', results[0].asset.id, { enabled: false }), { code: 'MEME_NOT_FOUND' });
  assert.equal((await getScopedMeme('g-1', results[0].asset.id)).send.data.sub_type, 1);
});

test('原生引用无需图片可使用；去重不依赖 key 和摘要，检索不泄漏发送参数', async () => {
  const first = await collectMeme('p-10', { type: 'mface', name: '开心', tags: ['笑'],
    data: { emoji_id: '001', emoji_package_id: 10, key: 'native-secret', summary: '[开心]' }, source: { url: 'https://private.example/?token=secret' } });
  const again = await collectMeme('p-10', { type: 'mface', name: '开心', tags: ['快乐'],
    data: { emoji_id: '001', emoji_package_id: '10', key: 'native-secret', summary: '[开心]' } });
  assert.equal(again.duplicate, true);
  assert.equal(again.asset.id, first.asset.id);
  assert.equal((await getScopedMeme('p-10', first.asset.id)).path, null);
  const results = await searchMemes('p-10', '快乐');
  assert.equal(results.length, 1);
  assert.ok(!JSON.stringify(results).includes('native-secret'));
  assert.ok(!JSON.stringify(results).includes('private.example'));
  const face = await collectMeme('p-10', { type: 'face', name: '微笑', data: { id: 0 } });
  assert.equal((await getScopedMeme('p-10', face.asset.id)).send.data.id, 0);
});

test('重新收藏补全原生引用或刷新 key，替换索引并保留旧文件、标签与使用状态', async () => {
  const initial = await collectMeme('g-15', { type: 'mface', name: '先前命名', tags: ['开心'],
    data: { emoji_id: '123', emoji_package_id: '456' } });
  await assert.rejects(getScopedMeme('g-15', initial.asset.id), { code: 'MEME_INCOMPLETE' });
  const complete = await collectMeme('g-15', { type: 'mface', name: '新名字', tags: ['快乐'],
    data: { emoji_id: '123', emoji_package_id: '456', key: 'first-key' } });
  assert.equal(complete.duplicate, true);
  assert.equal(complete.refreshed, true);
  assert.notEqual(complete.asset.id, initial.asset.id);
  assert.equal((await searchMemes('g-15', '')).length, 1);
  assert.equal((await getScopedMeme('g-15', complete.asset.id)).name, '先前命名');
  const originalMetadata = JSON.parse(await readFile(join(mediaPaths().memes, initial.asset.id, 'metadata.json'), 'utf8'));
  assert.equal(originalMetadata.send.data.key, undefined);
  await recordMemeUse('g-15', complete.asset.id);
  await updateMeme('g-15', complete.asset.id, { enabled: false });
  const rotated = await collectMeme('g-15', { type: 'mface', data: { emoji_id: '123', emoji_package_id: '456', key: 'rotated-key' } });
  assert.equal(rotated.refreshed, true);
  assert.notEqual(rotated.asset.id, complete.asset.id);
  const [entry] = await searchMemes('g-15', '', { includeUnavailable: true });
  assert.equal(entry.usedCount, 1);
  assert.equal(entry.enabled, false);
  assert.equal(entry.name, '先前命名');
  assert.deepEqual(entry.tags, ['开心', '快乐']);
  await updateMeme('g-15', rotated.asset.id, { enabled: true });
  assert.equal((await getScopedMeme('g-15', rotated.asset.id)).send.data.key, 'rotated-key');
  const incompleteAgain = await collectMeme('g-15', { type: 'mface', data: { emoji_id: '123', emoji_package_id: '456' } });
  assert.equal(incompleteAgain.refreshed, false);
  assert.equal(incompleteAgain.asset.id, rotated.asset.id);
});

test('原图丢失后重新提供完整原图能修复重复收藏，保留名称、停用和使用次数', async () => {
  const input = image('repair-missing');
  const first = await collectMeme('g-16', input);
  await recordMemeUse('g-16', first.asset.id);
  await updateMeme('g-16', first.asset.id, { name: '管理员命名', enabled: false });
  await rm(join(mediaPaths().root, first.asset.path));
  const repaired = await collectMeme('g-16', input);
  assert.equal(repaired.duplicate, true);
  assert.equal(repaired.refreshed, true);
  assert.notEqual(repaired.asset.id, first.asset.id);
  const [entry] = await searchMemes('g-16', '', { includeUnavailable: true });
  assert.equal(entry.name, '管理员命名');
  assert.equal(entry.enabled, false);
  assert.equal(entry.usedCount, 1);
  assert.deepEqual(await readFile(join(mediaPaths().root, repaired.asset.path)), input.image);
  await updateMeme('g-16', repaired.asset.id, { enabled: true });
  assert.equal((await getScopedMeme('g-16', repaired.asset.id)).id, repaired.asset.id);
});

test('损坏元数据只允许完整原生引用修复，不完整重收藏不改索引', async () => {
  const original = await collectMeme('g-17', { type: 'mface', name: '保留名字',
    data: { emoji_id: '123', emoji_package_id: '789', key: 'first-key' } });
  const metadataPath = join(mediaPaths().memes, original.asset.id, 'metadata.json');
  await writeFile(metadataPath, '{broken');
  const before = await readFile(join(mediaPaths().root, 'meme-library.json'), 'utf8');
  await assert.rejects(collectMeme('g-17', { type: 'mface', data: { emoji_id: '123', emoji_package_id: '789' } }), { code: 'MEME_ASSET_MISSING' });
  assert.equal(await readFile(join(mediaPaths().root, 'meme-library.json'), 'utf8'), before);
  const repaired = await collectMeme('g-17', { type: 'mface', data: { emoji_id: '123', emoji_package_id: '789', key: 'fresh-key' } });
  assert.equal(repaired.refreshed, true);
  assert.equal(repaired.duplicate, true);
  assert.equal((await getScopedMeme('g-17', repaired.asset.id)).name, '保留名字');
  assert.equal((await getScopedMeme('g-17', repaired.asset.id)).send.data.key, 'fresh-key');
  assert.equal(await readFile(metadataPath, 'utf8'), '{broken');
});

test('中文检索支持词语组合，准确名称优先，无关查询返回空，近期使用降低同等候选排名', async () => {
  const first = await collectMeme('g-20', image('first'));
  const second = await collectMeme('g-20', { ...image('second'), name: '灵魂出窍' });
  assert.equal((await searchMemes('g-20', '躺平'))[0].id, first.asset.id);
  const relevant = await searchMemes('g-20', '加班疲惫');
  assert.equal(relevant.length, 2);
  const chosen = relevant[0].id;
  await recordMemeUse('g-20', chosen);
  assert.notEqual((await searchMemes('g-20', '加班疲惫'))[0].id, chosen);
  assert.deepEqual(await searchMemes('g-20', '生日蛋糕'), []);
  await recordMemeUse('g-20', second.asset.id, { ok: false, errorCode: 'https://secret.example?key=abc' });
  const index = JSON.parse(await readFile(join(mediaPaths().root, 'meme-library.json'), 'utf8'));
  const entry = index.sessions['g-20'].find((item) => item.id === second.asset.id);
  assert.equal(entry.failureCount, 1);
  assert.equal(entry.lastErrorCode, 'SEND_FAILED');
});

test('修改名称与标签及停用只影响目录；重新收藏不自动启用；可列出停用记录', async () => {
  const saved = await collectMeme('g-30', image('labels'));
  const before = await readFile(join(mediaPaths().memes, saved.asset.id, 'metadata.json'), 'utf8');
  await updateMeme('g-30', saved.asset.id, { name: '尴尬陪笑', tags: ['尴尬'], enabled: false });
  assert.deepEqual(await searchMemes('g-30', ''), []);
  await assert.rejects(getScopedMeme('g-30', saved.asset.id), { code: 'MEME_DISABLED' });
  await collectMeme('g-30', image('labels'));
  const unavailable = await searchMemes('g-30', '', { includeUnavailable: true });
  assert.equal(unavailable[0].enabled, false);
  assert.equal(unavailable[0].available, false);
  await updateMeme('g-30', saved.asset.id, { enabled: true });
  assert.equal((await getScopedMeme('g-30', saved.asset.id)).name, '尴尬陪笑');
  assert.equal(await readFile(join(mediaPaths().memes, saved.asset.id, 'metadata.json'), 'utf8'), before);
});

test('缺失参数、仅预览和远程图片不进入可发送候选；损坏单份资产不影响其他表情', async () => {
  await collectMeme('g-40', { type: 'mface', name: '不完整', data: { emoji_id: '1' } });
  await collectMeme('g-40', { type: 'image', name: '预览', preview: image().image });
  const remote = await collectMeme('g-40', { type: 'image', name: '远程', data: { file: 'https://example.invalid/img.gif' } });
  await assert.rejects(getScopedMeme('g-40', remote.asset.id), { code: 'MEME_IMAGE_MISSING' });
  const broken = await collectMeme('g-40', image('broken'));
  await writeFile(join(mediaPaths().memes, broken.asset.id, 'metadata.json'), '{broken');
  const good = await collectMeme('g-40', { type: 'face', name: '完整', data: { id: 2 } });
  assert.deepEqual((await searchMemes('g-40', '')).map((item) => item.id), [good.asset.id]);
  const all = await searchMemes('g-40', '', { limit: 20, includeUnavailable: true });
  assert.equal(all.length, 5);
  assert.equal(all.filter((item) => item.available).length, 1);
});

test('非法范围与字段拒绝，目录损坏不回退成空库', async () => {
  await assert.rejects(searchMemes('../escape', ''), { code: 'MEME_SCOPE_INVALID' });
  assert.throws(() => collectMeme('g-1', { type: 'file' }), { code: 'MEME_TYPE_INVALID' });
  await assert.rejects(updateMeme('g-1', 'any', { source: {} }), { code: 'MEME_UPDATE_INVALID' });
  const path = join(mediaPaths().root, 'meme-library.json');
  const saved = await readFile(path, 'utf8');
  try {
    await writeFile(path, '{"version":1,"sessions":{"g-1":{}}}');
    await assert.rejects(searchMemes('g-1', ''), { code: 'MEME_INDEX_INVALID' });
    await assert.rejects(collectMeme('g-1', image()), { code: 'MEME_INDEX_INVALID' });
    assert.equal(await readFile(path, 'utf8'), '{"version":1,"sessions":{"g-1":{}}}');
  } finally { await writeFile(path, saved); }
});
