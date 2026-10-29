import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer } from './mock-onebot.js';

const root = await mkdtemp(join(tmpdir(), 'fish-meme-service-'));
const wire = await startMockServer();
Object.assign(process.env, { DATA_DIR: root, CONFIG_PATH: join(root, 'absent.json'),
  ONEBOT_WS_URL: wire.url, SEND_INTERVAL_MS: '1', API_TIMEOUT_MS: '100', RECONNECT_DELAY_MS: '100' });
const { collectFromEvent, sendStoredMeme, downloadMemeImage, MAX_MEME_BYTES } = await import('../src/memes/service.js');
const { collectMeme, searchMemes } = await import('../src/store/meme-library.js');
const { appendMessage, readRecentMessages, flushMessageStore } = await import('../src/store/message-store.js');
const { mediaPaths } = await import('../src/store/media-store.js');
const { startConnection, stopConnection, callApi } = await import('../src/connection/onebot.js');
const { drainSender, sendPrivate } = await import('../src/sender/sender.js');
startConnection();
await wire.waitForConnectionCount(1);
for (let attempt = 0; ; attempt++) {
  try { await callApi('get_status'); break; }
  catch (error) { if (attempt > 50 || !error.message.includes('WS 未连接')) throw error; await new Promise((resolve) => setTimeout(resolve, 5)); }
}
after(async () => { await drainSender(); await flushMessageStore(); stopConnection(); await wire.close(); await rm(root, { recursive: true, force: true }); });
const image = Buffer.from('GIF89a-animation-original');
const group = (message, overrides = {}) => ({ sessionKey: 'g-123', event: { message_type: 'group', group_id: 123, user_id: 456, message_id: 900, message, ...overrides } });
const privateContext = (message) => ({ sessionKey: 'p-456', event: { message_type: 'private', user_id: 456, message_id: 901, message } });
const face = (id = '14') => ({ type: 'face', data: { id } });

test('收集商城表情不下载 URL，按原生 mface 参数发出，确认后才记录历史', async () => {
  const segment = { type: 'image', data: { emoji_id: 'E1', emoji_package_id: 'P1', key: 'opaque', summary: '[开心]',
    file: 'marketface', url: 'https://gxh.vip.qq.com/a', maliciousExtra: 'not replayed' } };
  const ctx = group([segment]);
  const { asset } = await collectFromEvent(ctx, { name: '开心', tags: ['开心'] }, { downloadImage: () => { throw new Error('不得下载商城表情'); } });
  assert.equal(asset.memeType, 'mface');
  assert.equal(asset.path, null);
  assert.deepEqual(asset.send.data, { emoji_id: 'E1', emoji_package_id: 'P1', key: 'opaque', summary: '[开心]' });
  const result = await sendStoredMeme(ctx, asset.id);
  assert.equal(result.ok, true);
  assert.ok(result.messageId);
  const frame = wire.frames.find((item) => item.params?.message?.[0]?.type === 'mface');
  assert.deepEqual(frame.params.message, [{ type: 'mface', data: asset.send.data }]);
  const history = await readRecentMessages(ctx.sessionKey, 10);
  assert.equal(history.at(-1).memeId, asset.id);
  assert.equal(history.at(-1).message_id, result.messageId);
});

test('自定义 GIF 保留字节和 sub_type，只发本地原图的 base64', async () => {
  const ctx = privateContext([{ type: 'image', data: { file: '/sensitive/local/file', url: 'https://gchat.qpic.cn/a',
    sub_type: 7, summary: '[动画表情]' } }]);
  const { asset } = await collectFromEvent(ctx, { name: '动画', tags: ['躺平'] }, { downloadImage: async () => image });
  assert.deepEqual(await readFile(join(mediaPaths().root, asset.path)), image);
  assert.deepEqual(asset.send.data, { sub_type: 7, summary: '[动画表情]' });
  const result = await sendStoredMeme(ctx, asset.id);
  assert.equal(result.ok, true);
  const frame = wire.frames.find((item) => item.params?.message?.[0]?.type === 'image');
  assert.deepEqual(frame.params.message[0].data, { sub_type: 7, summary: '[动画表情]', file: `base64://${image.toString('base64')}` });
  assert.equal(frame.params.user_id, 456);
});

test('引用优先读取同会话存档；缺失时 get_msg 必须核实会话与消息 ID', async () => {
  await appendMessage({ sessionKey: 'g-123', message_id: 101, message_type: 'group', group_id: 123, user_id: 789, message: [face('101')] });
  const before = wire.frames.filter((frame) => frame.action === 'get_msg').length;
  const local = await collectFromEvent(group([{ type: 'reply', data: { id: '101' } }]), { name: '本群旧表情' });
  assert.equal(local.asset.send.data.id, '101');
  assert.equal(wire.frames.filter((frame) => frame.action === 'get_msg').length, before);
  wire.setActionResponse('get_msg', { message_type: 'group', group_id: 999, user_id: 789, message_id: 102, message: [face('102')] });
  await assert.rejects(collectFromEvent(group([{ type: 'reply', data: { id: '102' } }]), { name: '跨群' }), /当前会话/);
  wire.setActionResponse('get_msg', { message_type: 'group', group_id: 123, user_id: 789, message_id: 102, message: [face('102')] });
  const remote = await collectFromEvent(group([{ type: 'reply', data: { id: '102' } }]), { name: '本群引用' });
  assert.equal(remote.asset.send.data.id, '102');
  wire.clearActionResponse('get_msg');
});

test('引用肥鱼发出的原生表情和动画占位可再收藏，不查全局消息、不下载图片', async () => {
  const inputs = [
    { type: 'mface', data: { emoji_id: 'SELF1', emoji_package_id: 'PACK1', key: 'opaque', summary: '[开心]' }, name: '原生收藏' },
    { type: 'image', data: { sub_type: 1, summary: '[动画表情]' }, image, name: '动画收藏' },
  ];
  for (const input of inputs) {
    const { asset } = await collectMeme('p-456', input);
    const sent = await sendStoredMeme(privateContext([]), asset.id);
    assert.equal(sent.ok, true);
    const before = wire.frames.filter((entry) => entry.action === 'get_msg').length;
    const quoted = privateContext([{ type: 'reply', data: { id: String(sent.messageId) } }]);
    const result = await collectFromEvent(quoted, { name: '重新描述', tags: ['引用补充'] }, {
      downloadImage: () => { throw new Error('已存原图无需下载'); },
    });
    assert.equal(result.duplicate, true);
    assert.equal(result.asset.id, asset.id);
    assert.deepEqual(result.asset.send, asset.send);
    assert.ok(result.asset.tags.includes('引用补充'));
    if (result.asset.path) assert.deepEqual(await readFile(join(mediaPaths().root, result.asset.path)), image);
    assert.equal(wire.frames.filter((entry) => entry.action === 'get_msg').length, before);
  }
});

test('缺原图和缺商城参数可暂存但不能发；拒绝歧义与不匹配的操作会话', async () => {
  await assert.rejects(collectFromEvent(group([face(), face('15')]), { name: '两个' }), /一次只能/);
  await assert.rejects(collectFromEvent({ ...group([face()]), sessionKey: 'g-999' }), /有效会话/);
  const { asset } = await collectFromEvent(group([{ type: 'image', data: { file: '/tmp/arbitrary-file' } }]), { name: '没原图' });
  assert.deepEqual(asset.missingParameters, ['file']);
  await assert.rejects(sendStoredMeme(group([]), asset.id));
  const native = await collectFromEvent(group([{ type: 'image', data: { emoji_id: 'E2' } }]), { name: '没参数' });
  assert.deepEqual(native.asset.missingParameters, ['emoji_package_id', 'key']);
  await assert.rejects(sendStoredMeme(group([]), native.asset.id));
  const previewOnly = await collectFromEvent(group([{ type: 'image', data: { file: 'marketface', url: 'https://gxh.vip.qq.com/preview' } }]),
    { name: '商城预览' }, { downloadImage: () => { throw new Error('不能将商城预览冒充原图'); } });
  assert.equal(previewOnly.asset.memeType, 'mface');
  assert.deepEqual(previewOnly.asset.missingParameters, ['emoji_id', 'emoji_package_id', 'key']);
});

test('发送隔离会话；失败不写成功占位，sender Promise 返回确认结果', async () => {
  const { asset } = await collectFromEvent(privateContext([face('103')]), { name: '测试表情' });
  await assert.rejects(sendStoredMeme(group([]), asset.id));
  const before = await readRecentMessages('p-456', 100);
  await drainSender();
  wire.failNextCall(1400, 'mock send failure');
  const failed = await sendStoredMeme(privateContext([]), asset.id);
  assert.equal(failed.ok, false);
  assert.deepEqual(await readRecentMessages('p-456', 100), before);
  const next = await sendPrivate(456, '仍能正常发送');
  assert.equal(next.ok, true);
  assert.ok(next.messageId);
});

test('不对远程引用型 image 发起二次下载，不重放 arbitrary file', async () => {
  const { asset } = await collectMeme('g-123', { type: 'image', name: '仅引用', data: { file: 'file:///etc/passwd' } });
  await assert.rejects(sendStoredMeme(group([]), asset.id), /原图/);
});

test('只有 retcode 成功但缺少消息 ID 时不能声称发送确认成功', async () => {
  await drainSender();
  wire.setActionResponse('send_msg', {});
  try {
    const result = await sendPrivate(456, '响应不完整');
    assert.equal(result.ok, false);
    assert.match(result.error, /结果未知/);
  } finally { wire.clearActionResponse('send_msg'); }
});

test('图片下载入口拒绝内网、非 QQ 域名、用户信息、特殊端口；限制原图尺寸', async () => {
  for (const url of ['file:///etc/passwd', 'http://127.0.0.1/a', 'http://[::1]/a', 'https://qpic.cn.example.com/a',
    'https://user:pass@gchat.qpic.cn/a', 'https://gchat.qpic.cn:8080/a', 'https://example.com/a']) {
    await assert.rejects(downloadMemeImage(url), /QQ 图片服务器/);
  }
  const ctx = group([{ type: 'image', data: { url: 'https://gchat.qpic.cn/a' } }]);
  await assert.rejects(collectFromEvent(ctx, { name: '超大' }, { downloadImage: async () => Buffer.alloc(MAX_MEME_BYTES + 1) }), /10 MB/);
  assert.ok(!(await searchMemes('g-123', '超大')).length);
});
