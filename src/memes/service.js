// Collect and replay only explicit, scoped assets. No LLM-supplied paths or URLs reach transport.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { collectMeme, getScopedMeme, recordMemeUse } from '../store/meme-library.js';
import { mediaPaths } from '../store/media-store.js';
import { appendMessage, readRecentMessages } from '../store/message-store.js';
import { callApi } from '../connection/onebot.js';
import { getEventSessionKey, parseCqMessage } from '../protocol/onebot.js';
import { sendGroup, sendPrivate } from '../sender/sender.js';
import { logger } from '../utils/logger.js';

export const MAX_MEME_BYTES = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 30000;
const pick = (data, keys) => Object.fromEntries(keys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
const segments = (event) => Array.isArray(event.message) ? event.message : parseCqMessage(event.message ?? event.raw_message ?? '');
const memeSegments = (event) => segments(event).filter((segment) => ['image', 'mface', 'face'].includes(segment?.type));

function checkedContext(ctx) {
  if (!ctx?.event || getEventSessionKey(ctx.event) !== ctx.sessionKey || !['group', 'private'].includes(ctx.event.message_type)) {
    throw new Error('表情操作缺少有效会话');
  }
}

function publicAddress(address) {
  if (isIP(address) === 6) return /^[23]/i.test(address); // Public IPv6 global unicast only.
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b)));
}

async function lookupBeforeAbort(host, signal) {
  let onAbort;
  try {
    signal.throwIfAborted();
    return await Promise.race([
      lookup(host, { all: true }),
      new Promise((_, reject) => {
        onAbort = () => reject(new Error('DNS timeout'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

// QQ's image hosts only. Pin validated DNS answers to the connection; never follow redirects.
export async function downloadMemeImage(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('表情图片地址无效'); }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))
    || !(host === 'qpic.cn' || host.endsWith('.qpic.cn') || host === 'multimedia.nt.qq.com.cn' || host === 'gxh.vip.qq.com')) {
    throw new Error('仅支持 QQ 图片服务器的原图地址');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  timer.unref();
  try {
    let addresses;
    try { addresses = await lookupBeforeAbort(host, controller.signal); } catch { throw new Error('无法解析表情图片服务器或解析超时'); }
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('表情图片服务器地址不可用');
    const chosen = addresses[0];
    return await new Promise((resolve, reject) => {
      const request = url.protocol === 'https:' ? requestHttps : requestHttp;
      const req = request(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal,
        lookup: (_hostname, options, callback) => options.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family),
      }, (res) => {
        if (res.statusCode !== 200) { res.destroy(); reject(new Error(`表情图片下载失败（HTTP ${res.statusCode}）`)); return; }
        if (Number(res.headers['content-length']) > MAX_MEME_BYTES) { res.destroy(); reject(new Error('表情原图不能超过 10 MB')); return; }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_MEME_BYTES) { res.destroy(); reject(new Error('表情原图不能超过 10 MB')); }
          else chunks.push(chunk);
        });
        res.on('end', () => size > 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('表情原图为空')));
        res.on('error', () => reject(new Error('表情图片下载中断')));
      });
      req.on('error', () => reject(new Error('表情图片下载失败或超时')));
      req.end();
    });
  } finally { clearTimeout(timer); }
}

async function resolveSource(ctx) {
  const own = memeSegments(ctx.event);
  if (own.length) return { event: ctx.event, candidates: own };
  const replies = segments(ctx.event).filter((segment) => segment.type === 'reply');
  if (replies.length !== 1 || !replies[0].data?.id) throw new Error('请附上一个表情，或引用一个表情再让我收藏');
  const id = String(replies[0].data.id);
  if (!/^-?\d{1,20}$/.test(id)) throw new Error('引用消息 ID 无效');
  const local = (await readRecentMessages(ctx.sessionKey, 1000)).find((entry) => String(entry.message_id) === id);
  // Outgoing meme history deliberately stores only a small placeholder. Resolve
  // that trusted reference inside the same scope instead of looking up our own
  // message as if the bot's user ID were the private conversation's peer.
  if (local?.bot && local.memeId) return { event: local, asset: await getScopedMeme(ctx.sessionKey, local.memeId) };
  if (local) return { event: local, candidates: memeSegments(local) };
  const found = await callApi('get_msg', { message_id: id });
  // A get_msg lookup is global. A guessed message ID must never import another conversation.
  const source = found && { ...found, user_id: found.user_id ?? found.sender?.user_id };
  if (!source || getEventSessionKey(source) !== ctx.sessionKey
    || String(source.message_id) !== id || source.message_type !== ctx.event.message_type) {
    throw new Error('无法确认引用消息属于当前会话，请直接附上表情');
  }
  return { event: source, candidates: memeSegments(source) };
}

export async function collectFromEvent(ctx, { name = '', tags = [] } = {}, { downloadImage = downloadMemeImage } = {}) {
  checkedContext(ctx);
  const { event, candidates, asset } = await resolveSource(ctx);
  if (asset) {
    const image = asset.path ? await readFile(join(mediaPaths().root, asset.path)) : null;
    if (image && image.length > MAX_MEME_BYTES) throw new Error('表情原图不能超过 10 MB');
    return collectMeme(ctx.sessionKey, {
      type: asset.memeType, data: asset.send.data, image, name: name.trim() || asset.name, tags,
      source: { sessionKey: ctx.sessionKey, messageId: String(event.message_id), segmentType: asset.memeType },
    });
  }
  if (candidates.length !== 1) throw new Error(candidates.length ? '一次只能收藏一个表情，请单独发送或引用' : '引用消息中没有可收藏的表情');
  const segment = candidates[0];
  const received = segment.data ?? {};
  let type = segment.type;
  if (type === 'image' && (received.file === 'marketface'
    || ['emoji_id', 'emoji_package_id', 'key'].some((key) => received[key] !== undefined))) type = 'mface';
  let data;
  let image = null;
  if (type === 'mface') data = pick(received, ['emoji_id', 'emoji_package_id', 'key', 'summary']);
  else if (type === 'face') data = pick(received, ['id', 'resultId', 'chainCount']);
  else {
    data = { sub_type: received.sub_type ?? 1, ...pick(received, ['summary']) };
    const url = received.url ?? (/^https?:\/\//.test(received.file ?? '') ? received.file : null);
    if (url) image = await downloadImage(url);
    if (image && image.length > MAX_MEME_BYTES) throw new Error('表情原图不能超过 10 MB');
  }
  return collectMeme(ctx.sessionKey, {
    type, data, image, name: name.trim() || String(received.summary ?? '未命名表情').slice(0, 100), tags,
    source: { sessionKey: ctx.sessionKey, messageId: String(event.message_id ?? ''), segmentType: segment.type },
  });
}

export async function sendStoredMeme(ctx, id) {
  checkedContext(ctx);
  const asset = await getScopedMeme(ctx.sessionKey, id);
  let data;
  if (asset.memeType === 'image') {
    if (!asset.path || !asset.filename) throw new Error('这个表情缺少本地原图，暂时不能发送');
    const bytes = await readFile(join(mediaPaths().root, asset.path));
    if (bytes.length > MAX_MEME_BYTES) throw new Error('表情原图不能超过 10 MB');
    data = { ...pick(asset.send.data, ['sub_type', 'summary']), file: `base64://${bytes.toString('base64')}` };
  } else data = pick(asset.send.data, asset.memeType === 'mface'
    ? ['emoji_id', 'emoji_package_id', 'key', 'summary'] : ['id', 'resultId', 'chainCount']);
  const message = [{ type: asset.memeType, data }];
  const result = ctx.event.message_type === 'group'
    ? await sendGroup(ctx.event.group_id, message) : await sendPrivate(ctx.event.user_id, message);
  try { await recordMemeUse(ctx.sessionKey, id, { ok: result.ok, ...(result.ok ? {} : { errorCode: 'SEND_FAILED' }) }); }
  catch { logger.warn('[meme] 表情使用记录保存失败'); }
  if (!result.ok) return { ok: false, id, error: '表情发送失败或结果未知，请稍后明确要求重试' };
  await appendMessage({ sessionKey: ctx.sessionKey, time: Math.floor(Date.now() / 1000),
    message_type: ctx.event.message_type, user_id: ctx.event.user_id,
    ...(ctx.event.group_id !== undefined ? { group_id: ctx.event.group_id } : {}),
    bot: true, message_id: result.messageId, memeId: id, raw_message: `[表情] ${asset.name}` });
  return { ok: true, id, name: asset.name, messageId: result.messageId, message: 'OneBot 已确认表情发送成功' };
}
