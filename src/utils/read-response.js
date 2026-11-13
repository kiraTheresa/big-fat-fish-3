// Count decoded stream bytes too: Content-Length can be absent or compressed.
export async function readResponseBytes(response, limit) {
  const tooLarge = () => Object.assign(new Error(`绘图响应超过 ${limit / 1024 / 1024} MiB 限制，已停止接收；请核对上游扣费`), { code: 'IMAGE_RESPONSE_TOO_LARGE' });
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw tooLarge();
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks, size);
}
