import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { IMG_BYTES } from './image-server.js';
import { pruneObservations } from '../src/platform/maintenance.js';

const root = await mkdtemp(join(tmpdir(), 'fish-media-'));
process.env.DATA_DIR = root;
const { initializeMediaStore, mediaPaths, saveGeneratedImage, saveMemeImage } = await import('../src/store/media-store.js');
after(async () => { await rm(root, { recursive: true, force: true }); });

test('初始化可重复执行，生成图片与表情包目录独立', async () => {
  const paths = await initializeMediaStore();
  await initializeMediaStore();
  assert.ok((await stat(paths.generated)).isDirectory());
  assert.ok((await stat(paths.memes)).isDirectory());
});

test('并发保存相同原图不覆盖；提示词和会话不能影响路径；无临时残留', async () => {
  const items = await Promise.all(Array.from({ length: 8 }, () => saveGeneratedImage(IMG_BYTES.toString('base64'), {
    prompt: '../../outside', sessionKey: '../escape', model: 'test', size: '2K',
  })));
  assert.equal(new Set(items.map((item) => item.path)).size, 8);
  for (const item of items) {
    assert.match(item.path, /^generated\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]+\/image.png$/);
    const file = join(mediaPaths().root, item.path);
    assert.deepEqual(await readFile(file), IMG_BYTES);
    assert.equal(item.sha256, createHash('sha256').update(IMG_BYTES).digest('hex'));
    const metadata = JSON.parse(await readFile(join(dirname(file), 'metadata.json'), 'utf8'));
    assert.equal(metadata.id, item.id);
    assert.equal(metadata.prompt, '../../outside');
    assert.equal(metadata.bytes, IMG_BYTES.length);
  }
  const dayDir = dirname(dirname(join(mediaPaths().root, items[0].path)));
  assert.ok((await readdir(dayDir)).every((name) => !name.startsWith('.')));
});

test('表情包保留 GIF 原始字节和标签；JPEG、WebP 按文件头识别', async () => {
  for (const [bytes, extension] of [
    [Buffer.from('GIF89a-original-animation-bytes'), 'gif'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'jpg'],
    [Buffer.from('RIFF1234WEBP-original'), 'webp'],
    [IMG_BYTES, 'png'],
  ]) {
    const item = await saveMemeImage(bytes, { name: '../../开心', tags: ['开心', '肥鱼', '开心'] });
    assert.equal(item.filename, `image.${extension}`);
    assert.match(item.path, /^memes\/[a-f0-9-]+\/image\./);
    assert.deepEqual(item.tags, ['开心', '肥鱼']);
    assert.deepEqual(await readFile(join(mediaPaths().root, item.path)), bytes);
  }
});

test('无效输入拒绝；未知绘图格式保留原字节为 bin，不冒充 PNG', async () => {
  assert.throws(() => saveGeneratedImage('not base64!'), /Base64/);
  await assert.rejects(saveMemeImage(Buffer.alloc(0)), /非空/);
  await assert.rejects(saveMemeImage(Buffer.from('<html>error</html>')), /仅支持/);
  assert.throws(() => saveMemeImage(IMG_BYTES, { tags: [123] }), /标签/);
  const item = await saveGeneratedImage(Buffer.from('unknown format').toString('base64'));
  assert.equal(item.filename, 'image.bin');
  assert.equal(await readFile(join(mediaPaths().root, item.path), 'utf8'), 'unknown format');
});

test('观察数据清理不会删除媒体；重新初始化保留已有文件', async () => {
  const item = await saveMemeImage(IMG_BYTES);
  await pruneObservations(root, 1, Date.now() + 365 * 86400000);
  await initializeMediaStore();
  assert.deepEqual(await readFile(join(mediaPaths().root, item.path)), IMG_BYTES);
});
