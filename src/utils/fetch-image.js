// 图片现拉（识图）：QQ CDN URL → base64。用时拉取、零落盘（识图边界纪律）。
// UA 必带——实测部分 CDN 对无 UA 请求 403；超时/非 2xx 一律 reject，
// 由 chat 触发器决定回退策略（看图是增强不是依赖，图挂了纯文本对话继续走）。
export async function fetchImageAsB64(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

// data URL 的 mime 按 magic bytes 推断（DeepSeek 按实际内容判格式，mime 标错也不影响
// 识别，但标对是纪律）；未知类型按 jpeg 兜底（QQ 图绝大多数是 jpeg）。
export function mimeOfB64(b64) {
  const head = Buffer.from(b64, 'base64');
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head[0] === 0x89 && head[1] === 0x50) return 'image/png';
  if (head[0] === 0x47 && head[1] === 0x49) return 'image/gif';
  return 'image/jpeg';
}
