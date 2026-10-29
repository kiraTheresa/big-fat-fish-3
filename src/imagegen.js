// Shared Images API gateway; generated payloads and signed download URLs are
// never included in usage records or logs.
import { config } from './config.js';
import { beginUsage, finishUsage } from './platform/usage-policy.js';
import { logger, redactText } from './utils/logger.js';
import { saveGeneratedImage } from './store/media-store.js';

export async function generateImage(prompt, { sessionKey = 'system', onAttempt } = {}) {
  const attempt = await beginUsage({ kind: 'draw', model: config.imageModel, sessionKey });
  let usage = null;
  let httpStatus;
  let images = 0;
  let failure;
  const request = { model: config.imageModel, prompt, size: config.imageSize };
  const startedAt = Date.now();
  onAttempt?.({ phase: 'request', name: 'image_api', request, at: startedAt });
  try {
    const res = await fetch(`${config.imageApiBaseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.imageApiKey}` },
      body: JSON.stringify(request),
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
    onAttempt?.({ phase: 'response', name: 'image_api', httpStatus, usage, images, elapsedMs: Date.now() - startedAt });
    let b64;
    if (typeof item?.b64_json === 'string' && item.b64_json !== '') b64 = item.b64_json;
    else if (item?.url) {
      const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
      if (!imgRes.ok) throw new Error(`图片下载失败 HTTP ${imgRes.status}`);
      b64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');
    } else throw new Error('Image API 响应缺少 data[0].b64_json/url');
    let asset = null;
    try {
      asset = await saveGeneratedImage(b64, { prompt, sessionKey, model: request.model, size: request.size });
    } catch (error) {
      // A disk failure must not discard an already paid-for image or trigger a redraw.
      logger.warn('[imagegen] 原图本地保存失败，继续发送图片', { code: error.code ?? 'MEDIA_SAVE_FAILED' });
    }
    return { b64, asset };
  } catch (error) {
    failure = error;
    onAttempt?.({ phase: 'error', name: 'image_api', httpStatus, error: redactText(error.message, [config.imageApiKey]), elapsedMs: Date.now() - startedAt });
    throw error;
  } finally {
    await finishUsage(attempt, { usage, error: failure, httpStatus, images });
  }
}
