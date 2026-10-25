// imagegen.js 客户端测试（draw 接入）：成功（b64_json 直取）、url 形态现下载转 base64、
// HTTP 500 reject、形状异常（data 空数组）reject，以及请求形状（Bearer key、model、
// prompt、size 原样上送）。
// 模式（同 llm.test.js）：起 mock 图片 API → 设 env（必须 import config 之前）→ 动态 import。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startImageServer, IMG_BYTES } from './image-server.js';

const imageServer = await startImageServer();
process.env.IMAGE_API_KEY = 'test-image-key';
process.env.IMAGE_API_BASE_URL = imageServer.url;
process.env.IMAGE_MODEL = 'gpt-image-2.5-flare-vip';
process.env.IMAGE_SIZE = '2K';
process.env.IMAGE_TIMEOUT_MS = '2000';

const { generateImage } = await import('../src/imagegen.js');

after(async () => {
  await imageServer.close();
});

test('成功（b64_json 形态）：resolve { b64 }，请求携带 Bearer、model、prompt、size 原样上送', async () => {
  const { b64 } = await generateImage('一只橘猫');
  assert.equal(b64, IMG_BYTES.toString('base64'));

  assert.equal(imageServer.requests.length, 1);
  const req = imageServer.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/images/generations');
  assert.equal(req.headers.authorization, 'Bearer test-image-key');
  assert.deepEqual(req.body, { model: 'gpt-image-2.5-flare-vip', prompt: '一只橘猫', size: '2K' });
});

test('url 形态：data[0].url 指向外链 → 现下载转 base64，与原始字节逐字节一致', async () => {
  imageServer.setUrl();
  try {
    const { b64 } = await generateImage('火锅');
    assert.equal(b64, IMG_BYTES.toString('base64'));
  } finally {
    imageServer.setB64(); // 恢复默认，避免影响后续用例
  }
});

test('HTTP 500：reject 且错误信息含状态码（调用方兜底的依据）', async () => {
  imageServer.setFail();
  try {
    await assert.rejects(() => generateImage('会失败'), (err) => err.message.includes('HTTP 500'));
  } finally {
    imageServer.setB64();
  }
});

test('形状异常：data 为空数组 → reject（缺 b64_json/url）', async () => {
  imageServer.setEmpty();
  try {
    await assert.rejects(() => generateImage('空响应'), (err) => err.message.includes('data[0]'));
  } finally {
    imageServer.setB64();
  }
});
