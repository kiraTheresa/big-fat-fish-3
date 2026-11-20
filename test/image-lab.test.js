import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { IMG_BYTES } from './image-server.js';

const root = await mkdtemp(join(tmpdir(), 'fish-image-lab-'));
process.env.DATA_DIR = root;
process.env.USAGE_DIR = join(root, 'usage');
process.env.IMAGE_API_BASE_URL = 'https://api2.laozhang.ai/v1';
process.env.IMAGE_API_KEY = 'isolated-image-test-key';
const { startAdminServer } = await import('../src/admin/server.js');
const { createImageLab } = await import('../src/admin/image-lab.js');
const { createMediaService } = await import('../src/admin/media-service.js');
const imageLab = createImageLab();
const { setUsagePolicy } = await import('../src/platform/usage-policy.js');
const token = 'isolated-image-admin-token';
const admin = await startAdminServer({ token, port: 0, services: { imageLab, media: createMediaService() } });
const url = `http://127.0.0.1:${admin.port}/api/image-lab`;
const fetchOriginal = globalThis.fetch;
const calls = [];
let releaseUpstream;
globalThis.fetch = async (input, options) => {
  input = String(input);
  if (input.startsWith('http://127.0.0.1:')) return fetchOriginal(input, options);
  assert.ok(input.startsWith('https://api2.laozhang.ai/'), 'unexpected outbound destination');
  calls.push({ input, ...options });
  if (releaseUpstream) await releaseUpstream;
  const b64 = IMG_BYTES.toString('base64');
  if (input.includes('/v1beta/models/')) return Response.json({
    candidates: [{ content: { parts: [{ text: '已编辑' }, { inlineData: { mimeType: 'image/png', data: b64 } }] } }],
    usageMetadata: { totalTokenCount: 12 },
  });
  if (options.body instanceof FormData || JSON.parse(options.body).model !== 'grok-imagine-image-2.0') {
    return Response.json({ data: [{ b64_json: `data:image/png;base64,${b64}` }], usage: { total_tokens: 5 } });
  }
  return Response.json({ data: [{ b64_json: b64 }, { url: 'https://cdn.example.com/temporary.png?signature=test' }] });
};
after(async () => {
  await imageLab.close();
  globalThis.fetch = fetchOriginal;
  await admin.close();
  await rm(root, { force: true, recursive: true });
});

function fields(operation) {
  const form = new FormData();
  form.set('operation', operation);
  form.set('prompt', '蓝色陶瓷鱼');
  form.set('size', '1536x1024');
  form.set('quality', 'high');
  return form;
}
const auth = { Authorization: `Bearer ${token}` };
const run = (body, headers = auth) => fetch(url, { method: 'POST', headers, body });
async function finished(response) {
  assert.equal(response.status, 202);
  const { id, status } = await response.json();
  assert.equal(status, 'queued');
  for (let index = 0; index < 100; index++) {
    const detail = await fetch(`${url}/tasks/${id}`, { headers: auth });
    assert.equal(detail.status, 200);
    const task = await detail.json();
    if (!['queued', 'running'].includes(task.status)) return task;
    await wait(20);
  }
  assert.fail('task did not finish');
}

test('生图台按任务发送 JSON 或 multipart，返回原图和用量', async () => {
  const settings = await (await fetch(url, { headers: auth })).json();
  assert.deepEqual(settings, { model: 'gpt-image-2.5-flare-vip', available: true, reason: '' });
  const generated = await finished(await run(fields('generations')));
  assert.equal(generated.status, 'completed');
  const mediaUrl = new URL('/api/media', url);
  const gallery = await (await fetch(String(mediaUrl), { headers: auth })).json();
  assert.equal(gallery.items[0].key, generated.images[0].key);
  const original = await fetch(`${mediaUrl}/file?${new URLSearchParams({ key: generated.images[0].key })}`, { headers: auth });
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), IMG_BYTES);
  assert.equal(calls[0].input, `${process.env.IMAGE_API_BASE_URL}/images/generations`);
  assert.deepEqual(JSON.parse(calls[0].body), { model: settings.model, prompt: '蓝色陶瓷鱼', size: '1536x1024', quality: 'high', response_format: 'b64_json' });
  assert.equal(calls[0].redirect, 'error');
  const form = fields('edits');
  form.set('model', 'gpt-image-2.5-sunburst-vip');
  form.set('transparent', '1');
  form.append('reference', new Blob([IMG_BYTES], { type: 'image/png' }), 'source.png');
  form.append('reference', new Blob([IMG_BYTES], { type: 'image/png' }), 'other.png');
  const edited = await finished(await run(form));
  assert.equal(edited.status, 'completed');
  const { images, usage } = edited;
  assert.equal(images[0].mimeType, 'image/png');
  assert.ok(images[0].key.startsWith('generated/'));
  assert.equal(edited.references[0].name, 'source.png');
  assert.ok(!JSON.stringify(edited).includes(IMG_BYTES.toString('base64')));
  assert.deepEqual(usage, { total_tokens: 5 });
  const edit = calls[1];
  assert.equal(edit.input, `${process.env.IMAGE_API_BASE_URL}/images/edits`);
  assert.equal(edit.body.get('model'), 'gpt-image-2.5-sunburst-vip');
  assert.equal(edit.body.get('output_format'), 'png');
  assert.equal(edit.body.get('background'), 'transparent');
  assert.equal(edit.headers['Content-Type'], undefined);
  assert.deepEqual(edit.body.getAll('image[]').map(({ name }) => name), ['source.png', 'other.png']);
  assert.deepEqual(Buffer.from(await edit.body.get('image[]').arrayBuffer()), IMG_BYTES);
});

test('Grok 多图与临时链接使用同一入口，客户端不下载外链', async () => {
  const form = fields('generations');
  form.set('model', 'grok-imagine-image-2.0');
  form.set('quality', 'low');
  form.set('resolution', '2k');
  form.set('aspect_ratio', '16:9');
  form.set('n', '2');
  form.set('response_format', 'url');
  const task = await finished(await run(form));
  assert.equal(task.status, 'completed');
  assert.deepEqual(JSON.parse(calls.at(-1).body), {
    model: 'grok-imagine-image-2.0', prompt: '蓝色陶瓷鱼', response_format: 'b64_json', resolution: '2k', aspect_ratio: '16:9', quality: 'low', n: 2,
  });
  assert.equal(task.images.length, 1);
  assert.match(task.error, /1 张结果/);
  assert.ok(!JSON.stringify(task).includes('cdn.example.com'));
  form.set('n', '11');
  const count = calls.length;
  assert.equal((await run(form)).status, 400);
  assert.equal(calls.length, count);
});

test('Nano Banana 用 Gemini 原生字段上传参考图并解析图片和文字', async () => {
  const form = fields('edits');
  form.set('model', 'gemini-nano-banana-2.1');
  form.set('imageSize', '4K');
  form.set('aspectRatio', '8:1');
  form.set('mimeType', 'image/jpeg');
  form.set('compressionQuality', '0');
  form.set('thinkingLevel', 'high');
  form.set('imageSearch', '1');
  form.append('reference', new Blob([IMG_BYTES], { type: 'image/png' }), 'source.png');
  const task = await finished(await run(form));
  assert.equal(task.status, 'completed');
  assert.equal(calls.at(-1).input, 'https://api2.laozhang.ai/v1beta/models/gemini-nano-banana-2.1:generateContent');
  const request = JSON.parse(calls.at(-1).body);
  assert.deepEqual(request.contents[0].parts[1].inlineData, { mimeType: 'image/png', data: IMG_BYTES.toString('base64') });
  assert.deepEqual(request.generationConfig, {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { imageSize: '4K', aspectRatio: '8:1', imageOutputOptions: { mimeType: 'image/jpeg', compressionQuality: 0 } },
    thinkingConfig: { thinkingLevel: 'high' },
  });
  assert.deepEqual(request.tools, [{ googleSearch: { searchTypes: { imageSearch: {} } } }]);
  const { images, text, usage } = task;
  assert.equal(text, '已编辑');
  assert.equal(images[0].mimeType, 'image/png');
  assert.equal(usage.total_tokens, 12);
});

test('启用 Node 环境代理时拒绝发出绘图请求', async () => {
  const count = calls.length;
  const previous = process.env.NODE_USE_ENV_PROXY;
  process.env.NODE_USE_ENV_PROXY = '1';
  try {
    assert.equal((await run(fields('generations'))).status, 503);
    assert.equal(calls.length, count);
  } finally {
    if (previous === undefined) delete process.env.NODE_USE_ENV_PROXY;
    else process.env.NODE_USE_ENV_PROXY = previous;
  }
});

test('任务提交后立即可见，后续任务排队，按顺序执行', async () => {
  const before = calls.length;
  let unblock;
  releaseUpstream = new Promise((resolve) => { unblock = resolve; });
  let first;
  let second;
  try {
    first = await run(fields('generations'));
    second = await run(fields('generations'));
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    for (let index = 0; calls.length === before && index < 100; index++) await wait(20);
    const { items } = await (await fetch(`${url}/tasks?limit=2`, { headers: auth })).json();
    assert.deepEqual(items.map((task) => task.status).sort(), ['queued', 'running']);
    assert.equal(calls.length, before + 1);
  } finally {
    unblock();
    releaseUpstream = null;
  }
  const tasks = await Promise.all([finished(first), finished(second)]);
  assert.ok(tasks.every((task) => task.status === 'completed'));
  assert.equal(calls.length, before + 2);
});

test('未经授权、跨站、文件类型错误、尺寸错误和绘图关闭都不会访问上游', async () => {
  const count = calls.length;
  assert.equal((await run(fields('generations'), {})).status, 401);
  assert.equal((await run(fields('generations'), { ...auth, Origin: 'https://example.com' })).status, 403);
  assert.equal((await run(fields('edits'))).status, 400);
  const invalidSize = fields('generations');
  invalidSize.set('size', '4096x4096');
  assert.equal((await run(invalidSize)).status, 400);
  const invalidFile = fields('edits');
  invalidFile.append('reference', new Blob(['not an image'], { type: 'image/png' }), 'source.png');
  assert.equal((await run(invalidFile)).status, 400);
  setUsagePolicy({ features: { draw: false } });
  const denied = await finished(await run(fields('generations')));
  assert.equal(denied.status, 'failed');
  assert.match(denied.error, /停用/);
  assert.equal(calls.length, count);
});

test('重启后保留成功结果和任务参数，将进行中的任务标记中断且不重发', async () => {
  const count = calls.length;
  const { items } = await (await fetch(`${url}/tasks`, { headers: auth })).json();
  const completed = items.find((item) => item.status === 'completed');
  const id = `${Date.now()}-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa`;
  await writeFile(join(root, 'management', 'image-tasks', `${id}.json`), JSON.stringify({ ...await imageLab.read(completed.id), id, status: 'running', parameters: { prompt: '未完成' } }));
  const restarted = createImageLab();
  await restarted.recover();
  assert.equal((await restarted.read(id)).status, 'interrupted');
  assert.deepEqual((await restarted.read(completed.id)).images, completed.images);
  assert.equal(calls.length, count);
});

test('坏 JSON、无效结构及 ID 不匹配均保留原文件，不影响恢复、分页和正常任务', async () => {
  const original = (await imageLab.list()).items.find((item) => item.status === 'completed');
  const good = await imageLab.read(original.id);
  const malformed = ['{broken', 'null', '{}', JSON.stringify({ ...good, parameters: {} }),
    JSON.stringify({ ...good, images: [null] }), JSON.stringify(good)];
  const ids = [];
  for (const [index, raw] of malformed.entries()) {
    const id = `${Date.now() + 1000 + index}-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb`;
    const body = index === 3 || index === 4 ? JSON.stringify({ ...JSON.parse(raw), id }) : raw;
    malformed[index] = body;
    ids.push(id);
    await writeFile(join(root, 'management', 'image-tasks', `${id}.json`), body);
  }
  const count = calls.length;
  const restarted = createImageLab();
  await restarted.recover();
  const page = await restarted.list({ limit: 1 });
  assert.equal(page.items.length, 1);
  assert.ok(!ids.includes(page.items[0].id));
  assert.ok((await restarted.list({ before: page.nextCursor, limit: 50 })).items.length);
  for (const [index, id] of ids.entries()) {
    await assert.rejects(restarted.read(id), { status: 409, code: 'IMAGE_TASK_CORRUPT' });
    assert.equal(await readFile(join(root, 'management', 'image-tasks', `${id}.json`), 'utf8'), malformed[index]);
    assert.equal((await fetch(`${url}/tasks/${id}`, { headers: auth })).status, 409);
  }
  assert.deepEqual(await restarted.read(good.id), good);
  assert.equal(calls.length, count);
});
