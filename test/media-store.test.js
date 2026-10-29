import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { IMG_BYTES } from './image-server.js';
import { pruneObservations } from '../src/platform/maintenance.js';

const root = await mkdtemp(join(tmpdir(), 'fish-media-'));
process.env.DATA_DIR = root;
const { initializeMediaStore, mediaPaths, saveGeneratedImage, saveMemeImage, saveMeme, readMeme } = await import('../src/store/media-store.js');
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

test('商城表情无需图片文件，参数和来源经磁盘完整往返，不下载远程资源', async () => {
  const data = { emoji_id: '000123', emoji_package_id: 456, key: 'opaque-key', summary: '[开心]',
    extension: { flag: false, value: [0, null, '动画'] } };
  const source = { messageId: '123', sessionKey: 'g-456', segmentType: 'image' };
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('存储不得下载'); };
  try {
    const saved = await saveMeme({ type: 'mface', data, source, name: '开心' });
    assert.equal(saved.version, 2);
    assert.equal(saved.path, null);
    assert.equal(saved.filename, null);
    assert.deepEqual(saved.missingParameters, []);
    assert.deepEqual(await readdir(join(mediaPaths().memes, saved.id)), ['metadata.json']);
    const loaded = await readMeme(saved.id);
    assert.deepEqual(loaded, saved);
    assert.deepEqual(loaded.send, { type: 'mface', data });
    assert.deepEqual(loaded.source, source);
    const remote = await saveMeme({ type: 'image', data: { file: 'https://example.invalid/a.gif', sub_type: 1 } });
    assert.equal(remote.path, null);
    assert.deepEqual(remote.missingParameters, []);
  } finally { globalThis.fetch = nativeFetch; }
});

test('内置 face 保留 ID 原类型与扩展参数，调用后修改输入不影响保存', async () => {
  const data = { id: 0, resultId: '2', chainCount: 3, raw: { faceText: '示例' } };
  const source = { messageId: '42' };
  const saving = saveMeme({ type: 'face', data, source });
  data.id = 999;
  data.raw.faceText = '被改动';
  source.messageId = '99';
  const saved = await saving;
  const loaded = await readMeme(saved.id);
  assert.deepEqual(loaded.send.data, { id: 0, resultId: '2', chainCount: 3, raw: { faceText: '示例' } });
  assert.deepEqual(loaded.source, { messageId: '42' });
  assert.deepEqual(loaded.missingParameters, []);
});

test('自定义动画原图和预览分开保存，保留发送属性而不转码', async () => {
  const gif = Buffer.from('GIF89a-original-animated-content');
  const data = { sub_type: 7, summary: '[动画表情]', custom: { name: 'original' } };
  const saving = saveMeme({ type: 'image', image: gif, preview: IMG_BYTES, data });
  gif.fill(0);
  const saved = await saving;
  const loaded = await readMeme(saved.id);
  assert.deepEqual(loaded, saved);
  assert.deepEqual(loaded.send, { type: 'image', data });
  assert.deepEqual(loaded.missingParameters, []);
  assert.equal(await readFile(join(mediaPaths().root, loaded.path), 'utf8'), 'GIF89a-original-animated-content');
  assert.equal(loaded.preview.filename, 'preview.png');
  assert.deepEqual(await readFile(join(mediaPaths().root, loaded.preview.path)), IMG_BYTES);
});

test('缺少发送参数仍可保存，预览不能冒充可发送原图；参数缺失明确记录', async () => {
  const image = await saveMeme({ type: 'image', preview: IMG_BYTES, data: { summary: '[表情]' } });
  assert.equal(image.path, null);
  assert.deepEqual((await readMeme(image.id)).missingParameters, ['file']);
  const market = await saveMeme({ type: 'mface', image: IMG_BYTES, data: { emoji_id: '123' } });
  assert.deepEqual(market.missingParameters, ['emoji_package_id', 'key']);
  const face = await saveMeme({ type: 'face', data: { id: '' } });
  assert.deepEqual(face.missingParameters, ['id']);
});

test('兼容原图片接口，读取旧 v1 不猜测表情属性，也不改写磁盘', async () => {
  const saved = await saveMemeImage(IMG_BYTES, { data: { sub_type: 1, summary: '[表情]' } });
  assert.equal(saved.send.data.sub_type, 1);
  const file = join(mediaPaths().memes, saved.id, 'metadata.json');
  const legacy = { version: 1, id: saved.id, kind: 'memes', createdAt: saved.createdAt,
    filename: saved.filename, mimeType: saved.mimeType, bytes: saved.bytes, sha256: saved.sha256,
    name: '旧图', tags: ['旧'] };
  const originalJson = JSON.stringify(legacy);
  await writeFile(file, originalJson);
  const loaded = await readMeme(saved.id);
  assert.equal(loaded.version, 1);
  assert.deepEqual(loaded.send, { type: 'image', data: {} });
  assert.deepEqual(loaded.missingParameters, []);
  assert.equal(await readFile(file, 'utf8'), originalJson);
});

test('非法类型、不可序列化参数在落盘前拒绝，参数不会静默丢失', async () => {
  const before = await readdir(mediaPaths().memes);
  assert.throws(() => saveMeme({ type: 'video' }), /表情类型/);
  const cycle = {}; cycle.self = cycle;
  for (const data of [null, [], { value: undefined }, { value: Infinity }, { value: 1n }, { value: new Date() }, cycle]) {
    assert.throws(() => saveMeme({ type: 'face', data }), /JSON/);
  }
  assert.throws(() => saveMeme({ type: 'face', source: [] }), /JSON/);
  await assert.rejects(saveMeme({ type: 'face', preview: Buffer.from('not an image') }), /仅支持/);
  assert.deepEqual(await readdir(mediaPaths().memes), before);
});

test('读取限制为 UUID，缺失返回 null，损坏元数据/缺失文件明确报错', async () => {
  await assert.rejects(readMeme('../escape'), /无效/);
  assert.equal(await readMeme('00000000-0000-0000-0000-000000000000'), null);
  const saved = await saveMemeImage(IMG_BYTES);
  const file = join(mediaPaths().memes, saved.id, 'metadata.json');
  const metadata = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, '{bad');
  await assert.rejects(readMeme(saved.id), SyntaxError);
  await writeFile(file, JSON.stringify({ ...metadata, filename: '../../escape.png' }));
  await assert.rejects(readMeme(saved.id), /文件名/);
  await writeFile(file, JSON.stringify({ ...metadata, send: { type: 'mface', data: {} } }));
  await assert.rejects(readMeme(saved.id), /发送类型/);
  await writeFile(file, JSON.stringify(metadata));
  await rm(join(mediaPaths().root, saved.path));
  await assert.rejects(readMeme(saved.id), { code: 'ENOENT' });
});
