// Shared Images API gateway; generated payloads and signed download URLs are
// never included in usage records or logs.
import { config } from './config.js';
import { beginUsage, finishUsage } from './platform/usage-policy.js';
import { redactText } from './utils/logger.js';

export async function generateImage(prompt, { sessionKey = 'system' } = {}) {
  const attempt = await beginUsage({ kind: 'draw', model: config.imageModel, sessionKey });
  let usage = null;
  let httpStatus;
  let images = 0;
  let failure;
  try {
    const res = await fetch(`${config.imageApiBaseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.imageApiKey}` },
      body: JSON.stringify({ model: config.imageModel, prompt, size: config.imageSize }),
      signal: AbortSignal.timeout(config.imageTimeoutMs),
    });
    httpStatus = res.status;
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        const message = body.error?.message ?? body.message ?? body.error;
        if (typeof message === 'string') detail = redactText(message, [config.imageApiKey]).slice(0, 500);
      } catch { /* Non-JSON errors still retain their HTTP status. */ }
      throw new Error(`Image API HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const data = await res.json();
    usage = data.usage ?? null;
    const item = data.data?.[0];
    // Image count is generated output, independent of a later download error.
    images = Array.isArray(data.data) ? data.data.filter((entry) => entry?.b64_json || entry?.url).length : 0;
    if (typeof item?.b64_json === 'string' && item.b64_json !== '') return { b64: item.b64_json };
    if (item?.url) {
      const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
      if (!imgRes.ok) throw new Error(`图片下载失败 HTTP ${imgRes.status}`);
      return { b64: Buffer.from(await imgRes.arrayBuffer()).toString('base64') };
    }
    throw new Error('Image API 响应缺少 data[0].b64_json/url');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await finishUsage(attempt, { usage, error: failure, httpStatus, images });
  }
}
