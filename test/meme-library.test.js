import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'fish-meme-library-'));
process.env.DATA_DIR = root;
const { collectMeme, searchMemes, getSharedMeme, getScopedMeme, recordMemeUse, updateMeme, initializeMemeLibrary } = await import('../src/store/meme-library.js');
const { mediaPaths, saveMeme } = await import('../src/store/media-store.js');
beforeEach(async () => { await rm(root, { recursive: true, force: true }); await initializeMemeLibrary(); });
after(async () => { await rm(root, { recursive: true, force: true }); });

const image = (suffix = '') => ({ type: 'image', image: Buffer.from(`GIF89a-original-${suffix}`), data: { sub_type: 1, summary: '[动画表情]' }, name: '躺平', tags: ['加班', '疲惫'] });

test('私聊收藏可在其他群检索读取；跨来源并发收藏相同原图全库只留一条', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => collectMeme(index % 2 ? 'g-1' : 'p-1', image())));
  assert.equal(results.filter((item) => !item.duplicate).length, 1);
  assert.equal(new Set(results.map((item) => item.asset.id)).size, 1);
  assert.equal((await searchMemes('g-1', '')).length, 1);
  const other = await collectMeme('g-2', image());
  assert.equal(other.duplicate, true);
  assert.equal(other.asset.id, results[0].asset.id);
  assert.equal((await getSharedMeme('g-99', results[0].asset.id)).send.data.sub_type, 1);
  assert.equal(getScopedMeme, getSharedMeme, '旧导出仅作为共享读取的兼容别名');
  await recordMemeUse('p-99', other.asset.id);
  await updateMeme('g-99', other.asset.id, { name: '共享命名', enabled: false });
  await assert.rejects(getSharedMeme('p-1', other.asset.id), { code: 'MEME_DISABLED' });
  const resultsFromAnotherGroup = await searchMemes('g-100', '共享命名', { includeUnavailable: true });
  assert.equal(resultsFromAnotherGroup[0].usedCount, 1);
  assert.ok(!JSON.stringify(resultsFromAnotherGroup).includes('sourceSessions'));
  const index = JSON.parse(await readFile(join(mediaPaths().root, 'meme-library.json'), 'utf8'));
  assert.equal(index.version, 2);
  assert.deepEqual(index.entries[0].sourceSessions.sort(), ['g-1', 'g-2', 'p-1']);
});

test('原生引用无需图片可使用；去重不依赖 key 和摘要，检索不泄漏发送参数', async () => {
  const first = await collectMeme('p-10', { type: 'mface', name: '开心', tags: ['笑'],
    data: { emoji_id: '001', emoji_package_id: 10, key: 'native-secret', summary: '[开心]' }, source: { url: 'https://private.example/?token=secret' } });
  const again = await collectMeme('g-10', { type: 'mface', name: '开心', tags: ['快乐'],
    data: { emoji_id: '001', emoji_package_id: '10', key: 'native-secret', summary: '[开心]' } });
  assert.equal(again.duplicate, true);
  assert.equal(again.asset.id, first.asset.id);
  assert.equal((await getScopedMeme('p-10', first.asset.id)).path, null);
  const results = await searchMemes('g-20', '快乐');
  assert.equal(results.length, 1);
  assert.ok(!JSON.stringify(results).includes('native-secret'));
  assert.ok(!JSON.stringify(results).includes('private.example'));
  assert.ok(!JSON.stringify(results).includes('p-10'));
  assert.ok(!JSON.stringify(results).includes('g-10'));
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
  const entry = index.entries.find((item) => item.id === second.asset.id);
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

test('v1迁移保留不同旧ID，同ID合并来源和统计且保守停用；原文件和一次性备份保持完整', async () => {
  const input = image('legacy');
  const first = await collectMeme('p-2', input);
  const second = await saveMeme(input);
  const path = join(mediaPaths().root, 'meme-library.json');
  const { sourceSessions, ...entry } = JSON.parse(await readFile(path, 'utf8')).entries[0];
  const firstMetadataPath = join(mediaPaths().memes, first.asset.id, 'metadata.json');
  const firstMetadata = await readFile(firstMetadataPath, 'utf8');
  const legacy = { version: 1, sessions: {
    'p-2': [
      { ...entry, name: '私聊命名', tags: ['共同', '私聊'], enabled: false, usedCount: 3, failureCount: 2,
        createdAt: 10, lastUsedAt: 40, lastFailureAt: 41, lastErrorCode: 'SECOND_FAILURE' },
      { ...entry, id: second.id, name: '另一个旧ID', usedCount: 5 },
    ],
    'g-1': [{ ...entry, name: '群里命名', tags: ['共同', '群'], usedCount: 2, failureCount: 1,
      createdAt: 20, lastUsedAt: 30, lastFailureAt: 31, lastErrorCode: 'FIRST_FAILURE' }],
  } };
  const raw = JSON.stringify(legacy, null, 2) + '\n';
  await writeFile(path, raw);
  assert.deepEqual(await initializeMemeLibrary(), { version: 2, total: 2 });
  const migrated = JSON.parse(await readFile(path, 'utf8'));
  const merged = migrated.entries.find((item) => item.id === first.asset.id);
  assert.deepEqual(merged.sourceSessions, ['g-1', 'p-2']);
  assert.deepEqual(merged.tags, ['共同', '群', '私聊']);
  assert.equal(merged.name, '群里命名', '名称按来源字典序稳定选取首个非空值');
  assert.equal(merged.enabled, false, '任一来源停用即保持全局停用');
  assert.equal(merged.usedCount, 5);
  assert.equal(merged.failureCount, 3);
  assert.equal(merged.createdAt, 10);
  assert.equal(merged.lastUsedAt, 40);
  assert.equal(merged.lastFailureAt, 41);
  assert.equal(merged.lastErrorCode, 'SECOND_FAILURE');
  assert.equal(migrated.entries.find((item) => item.id === second.id).name, '另一个旧ID');
  assert.equal((await getSharedMeme('g-unrelated', second.id)).id, second.id);
  await assert.rejects(getSharedMeme('p-unrelated', first.asset.id), { code: 'MEME_DISABLED' });
  assert.equal(await readFile(firstMetadataPath, 'utf8'), firstMetadata, '迁移不改动旧资产');
  const backup = join(mediaPaths().root, 'meme-library.v1.backup.json');
  assert.equal(await readFile(backup, 'utf8'), raw, '备份与旧索引逐字节一致');
  const before = await readFile(path, 'utf8');
  const beforeStat = await stat(path);
  const backupStat = await stat(backup);
  await Promise.all(Array.from({ length: 3 }, () => initializeMemeLibrary()));
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await stat(path)).mtimeMs, beforeStat.mtimeMs, '重复初始化不重写v2目录');
  assert.equal((await stat(backup)).mtimeMs, backupStat.mtimeMs, '重复初始化不重写旧备份');
  assert.deepEqual((await readdir(mediaPaths().root)).filter((name) => name.includes('backup')), ['meme-library.v1.backup.json']);
  const again = await collectMeme('p-new', input);
  assert.equal(again.duplicate, true, '新收藏在迁移后的全库去重');
  assert.ok([first.asset.id, second.id].includes(again.asset.id));
  const after = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(new Set(after.entries.map((item) => item.id)), new Set([first.asset.id, second.id]), '同指纹不同旧ID均保留');
  assert.ok(after.entries.find((item) => item.id === again.asset.id).sourceSessions.includes('p-new'));
});

test('迁移合并超过30个旧标签后，改名、停用和重新收藏不会截断词汇', async () => {
  const input = image('many-tags');
  const saved = await collectMeme('g-1', input);
  const path = join(mediaPaths().root, 'meme-library.json');
  const { sourceSessions, ...entry } = JSON.parse(await readFile(path, 'utf8')).entries[0];
  const tags = Array.from({ length: 40 }, (_, index) => `旧标签${index}`);
  await writeFile(path, JSON.stringify({ version: 1, sessions: {
    'g-1': [{ ...entry, tags: tags.slice(0, 20) }], 'p-2': [{ ...entry, tags: tags.slice(20) }],
  } }));
  await initializeMemeLibrary();
  await updateMeme('g-3', saved.asset.id, { name: '共享旧收藏', enabled: false });
  await collectMeme('p-4', { ...input, tags: ['新标签'] });
  const [result] = await searchMemes('g-5', '共享旧收藏', { includeUnavailable: true });
  assert.deepEqual(result.tags, [...tags, '新标签']);
  assert.equal(result.enabled, false);
  await assert.rejects(updateMeme('g-3', saved.asset.id, { tags }), { code: 'MEME_LABEL_INVALID' });
});

test('迁移不截断超过5000个旧收藏；新收藏遵循全库上限，重复收藏仍可合并来源', async () => {
  const input = image('large-legacy');
  const saved = await collectMeme('g-1', input);
  const path = join(mediaPaths().root, 'meme-library.json');
  const { sourceSessions, ...entry } = JSON.parse(await readFile(path, 'utf8')).entries[0];
  const sessions = {};
  for (let index = 0; index < 5001; index++) {
    const scope = `g-${Math.floor(index / 500)}`;
    const id = index === 0 ? saved.asset.id : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    (sessions[scope] ??= []).push({ ...entry, id });
  }
  await writeFile(path, JSON.stringify({ version: 1, sessions }));
  assert.deepEqual(await initializeMemeLibrary(), { version: 2, total: 5001 });
  await assert.rejects(collectMeme('p-new', image('new-over-limit')), { code: 'MEME_LIBRARY_FULL' });
  const duplicate = await collectMeme('p-new', input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.asset.id, saved.asset.id);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).entries.length, 5001);
  assert.deepEqual(await readdir(mediaPaths().memes), [saved.asset.id], '超限拒绝发生在新资产写入之前');
});

test('损坏旧库、新库或冲突备份均拒绝覆盖；中断后可复用精确的v1备份', async () => {
  await collectMeme('g-1', image('invalid-index'));
  const path = join(mediaPaths().root, 'meme-library.json');
  const backup = join(mediaPaths().root, 'meme-library.v1.backup.json');
  const current = JSON.parse(await readFile(path, 'utf8'));
  const { sourceSessions, ...entry } = current.entries[0];
  const corrupt = [
    '{broken',
    JSON.stringify({ version: 2, entries: [{ ...current.entries[0], sourceSessions: ['../private'] }] }),
    JSON.stringify({ version: 2, entries: [current.entries[0], current.entries[0]] }),
    JSON.stringify({ version: 1, sessions: { 'g-1': [entry], 'p-2': [{ ...entry, fingerprint: 'f'.repeat(64) }] } }),
  ];
  for (const raw of corrupt) {
    await writeFile(path, raw);
    await assert.rejects(initializeMemeLibrary(), { code: 'MEME_INDEX_INVALID' });
    await assert.rejects(collectMeme('p-new', image('do-not-write')), { code: 'MEME_INDEX_INVALID' });
    assert.equal(await readFile(path, 'utf8'), raw);
    await assert.rejects(readFile(backup), { code: 'ENOENT' });
  }
  const raw = JSON.stringify({ version: 1, sessions: { 'g-1': [entry] } });
  await writeFile(path, raw);
  await writeFile(backup, '{"different":"backup"}');
  await assert.rejects(initializeMemeLibrary(), { code: 'MEME_BACKUP_CONFLICT' });
  assert.equal(await readFile(path, 'utf8'), raw);
  assert.equal(await readFile(backup, 'utf8'), '{"different":"backup"}');
  await writeFile(backup, raw);
  assert.deepEqual(await initializeMemeLibrary(), { version: 2, total: 1 });
  assert.equal(await readFile(backup, 'utf8'), raw);
});
