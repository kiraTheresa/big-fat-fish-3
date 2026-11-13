// Shared Images API gateway; generated payloads and signed download URLs are
// never included in usage records or logs.
import { config } from './config.js';
import { beginUsage, finishUsage } from './platform/usage-policy.js';
import { logger, redactText } from './utils/logger.js';
import { saveGeneratedImage } from './store/media-store.js';
import { readResponseBytes } from './utils/read-response.js';

const maxResponseBytes = 96 * 1024 * 1024;
const maxImageBytes = 64 * 1024 * 1024;

export async function generateImage(prompt, { sessionKey = 'system', onAttempt, logContext = {} } = {}) {
  const model = config.imageModel;
  const request = model === 'grok-imagine-image-2.0'
    ? { model, prompt, response_format: 'b64_json', n: 1 }
    : { model, prompt, size: config.imageSize };
  const { b64 } = await requestImage(request, { sessionKey, onAttempt, logContext });
  let asset = null;
  try {
    asset = await saveGeneratedImage(b64, { prompt, sessionKey, model: request.model, size: request.size });
  } catch (error) {
    // A disk failure must not discard an already paid-for image or trigger a redraw.
    logger.warn('[imagegen] 原图本地保存失败，继续发送图片', { code: error.code ?? 'MEDIA_SAVE_FAILED' });
  }
  return { b64, asset };
}

export async function requestImage(request, {
  references = [], sessionKey = 'system', onAttempt, logContext = {}, timeoutMs = config.imageTimeoutMs, lab,
} = {}) {
  const attempt = await beginUsage({ kind: lab ? 'image_lab' : 'draw', model: lab?.model ?? request.model, sessionKey,
    traceId: logContext.traceId, source: logContext.source, imageSearch: lab?.protocol === 'gemini' && !!request.tools?.length });
  let usage = null;
  let httpStatus;
  let images = 0;
  let imageResponseComplete = false;
  let failure;
  const startedAt = Date.now();
  try {
    onAttempt?.({ phase: 'request', name: 'image_api', request, at: startedAt });
    const headers = { Authorization: `Bearer ${config.imageApiKey}` };
    let body;
    if (references.length) {
      body = new FormData();
      for (const [key, value] of Object.entries(request)) body.set(key, value);
      for (const file of references) body.append(references.length === 1 ? 'image' : 'image[]', file, file.name);
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(request);
    }
    const operation = references.length ? 'edits' : 'generations';
    const endpoint = lab ? new URL(lab.endpoint, config.imageApiBaseUrl)
      : `${config.imageApiBaseUrl.replace(/\/$/, '')}/images/${operation}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers, body, signal: AbortSignal.timeout(timeoutMs),
      ...(lab && { redirect: 'error' }),
    });
    httpStatus = res.status;
    if (!res.ok) {
      let detail = '';
      try {
        const body = JSON.parse((await readResponseBytes(res, 1024 * 1024)).toString('utf8'));
        usage = body.usage ?? null;
        const message = body.error?.message ?? body.message ?? body.error;
        if (typeof message === 'string') detail = redactText(message, [config.imageApiKey]).slice(0, 500);
      } catch (err) {
        if (err.code === 'IMAGE_RESPONSE_TOO_LARGE') detail = err.message;
        // Non-JSON errors still retain their HTTP status.
      }
      throw new Error(`Image API HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const data = JSON.parse((await readResponseBytes(res, maxResponseBytes)).toString('utf8'));
    usage = data?.usage ?? null;
    const parts = lab?.protocol === 'gemini' && Array.isArray(data?.candidates)
      ? data.candidates.flatMap((candidate) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) : [];
    const items = lab?.protocol === 'gemini'
      ? parts.filter((part) => !part?.thought).map((part) => ({ b64_json: (part?.inlineData ?? part?.inline_data)?.data }))
      : data?.data;
    if (lab?.protocol === 'gemini' && data?.usageMetadata) {
      usage = {
        input_tokens: data.usageMetadata.promptTokenCount,
        output_tokens: data.usageMetadata.candidatesTokenCount,
        total_tokens: data.usageMetadata.totalTokenCount,
      };
    }
    const item = items?.[0];
    // Image count is generated output, independent of a later download error.
    imageResponseComplete = lab?.protocol === 'gemini'
      ? data !== null && typeof data === 'object' && !Array.isArray(data) : Array.isArray(items);
    images = imageResponseComplete ? items.filter((entry) =>
      (typeof entry?.b64_json === 'string' && entry.b64_json !== '') || (typeof entry?.url === 'string' && entry.url !== '')).length : 0;
    onAttempt?.({ phase: 'response', name: 'image_api', httpStatus, usage, images, elapsedMs: Date.now() - startedAt });
    if (lab) {
      if (!images) throw new Error('绘图 API 没有返回图片，请查看老张调用记录');
      const text = parts.filter((part) => !part?.thought && typeof part?.text === 'string').map((part) => part.text).join('\n');
      return { items, text, usage, httpStatus, elapsedMs: Date.now() - startedAt };
    }
    let b64;
    if (typeof item?.b64_json === 'string' && item.b64_json !== '') b64 = normalizeImageBase64(item.b64_json);
    else if (typeof item?.url === 'string' && item.url !== '') {
      const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
      if (!imgRes.ok) throw new Error(`图片下载失败 HTTP ${imgRes.status}`);
      b64 = (await readResponseBytes(imgRes, maxImageBytes)).toString('base64');
    } else throw new Error('Image API 响应缺少 data[0].b64_json/url');
    return { b64, usage, httpStatus, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    failure = error;
    onAttempt?.({ phase: 'error', name: 'image_api', httpStatus, error: redactText(error.message, [config.imageApiKey]), elapsedMs: Date.now() - startedAt });
    throw error;
  } finally {
    await finishUsage(attempt, { usage, error: failure, httpStatus, images, imageResponseComplete });
  }
}

export function normalizeImageBase64(value) {
  const b64 = value.replace(/^data:[^,]+;base64,/i, '').replace(/\s+/g, '');
  if (Buffer.byteLength(b64, 'base64') > maxImageBytes) throw new Error('生成图片超过 64 MiB，无法归档；请核对上游扣费');
  return b64;
}
