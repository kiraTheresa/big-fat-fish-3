// mock 图片生成 API（OpenAI Images 协议）HTTP 服务器：自动化验证专用，零真实外呼。
// 与 llm-server.js 同思路：记录请求、可注入行为。模式：
//   b64（默认）  → 响应 { data: [{ b64_json }] }（GPT Image 家族形态）
//   url         → 响应 { data: [{ url: <本机>/img }] }，GET /img 返回图片字节
//                （Seedream 家族形态，验证现下载转 base64 路径）
//   fail        → HTTP 500
//   empty       → data 空数组（形状异常）
import { createServer } from 'node:http';

// 假图片字节（PNG magic 头 + 少量内容）：url 模式下 GET /img 返回它，客户端下载后
// 转 base64 应与 IMG_BYTES.toString('base64') 逐字节一致
export const IMG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

export async function startImageServer() {
  const requests = []; // { method, url, headers, body }（body 为已解析 JSON）
  let mode = { kind: 'b64' };

  const server = createServer((req, res) => {
    // 图片下载路由（url 模式 data[0].url 指向这里；不记录入 requests——它不是 API 调用）
    if (req.method === 'GET' && req.url === '/img') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(IMG_BYTES);
      return;
    }

    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // 非 JSON 请求体：body 保持 null
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (mode.kind === 'fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock image api down' }));
        return;
      }
      if (mode.kind === 'empty') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ created: 0, data: [] }));
        return;
      }
      if (mode.kind === 'url') {
        const port = server.address().port;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ created: 0, data: [{ url: `http://127.0.0.1:${port}/img` }] }));
        return;
      }
      // kind === 'b64'
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ created: 0, data: [{ b64_json: IMG_BYTES.toString('base64') }] }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    setB64() {
      mode = { kind: 'b64' };
    },
    setUrl() {
      mode = { kind: 'url' };
    },
    setFail() {
      mode = { kind: 'fail' };
    },
    setEmpty() {
      mode = { kind: 'empty' };
    },
    async close() {
      server.closeAllConnections?.(); // 掐掉 keep-alive 连接，保证测试进程退出
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
