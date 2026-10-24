// mock LLM（OpenAI 兼容 /chat/completions）HTTP 服务器：自动化验证专用，零真实外呼。
// 与 test/mock-onebot.js 同思路：记录请求、可注入行为（setReply/setFail/setHang/setEmpty）。
import { createServer } from 'node:http';

// ok 模式默认携带的 usage（仿 DeepSeek 形状，含缓存命中 prompt_cache_hit_tokens）
const DEFAULT_USAGE = {
  prompt_tokens: 11,
  completion_tokens: 22,
  total_tokens: 33,
  prompt_cache_hit_tokens: 44,
};

export async function startLlmServer() {
  const requests = []; // { method, url, headers, body }（body 为已解析 JSON）
  let mode = { kind: 'ok', content: 'MOCK_LLM_REPLY', usage: DEFAULT_USAGE };

  const server = createServer((req, res) => {
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

      if (mode.kind === 'hang') return; // 挂起不响应（超时测试）
      if (mode.kind === 'empty') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [] })); // 形状异常：无 message.content
        return;
      }
      if (mode.kind === 'fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock llm down' }));
        return;
      }
      // kind === 'ok'：usage 为 null 时响应整体不含 usage 字段（缺 usage 容错用例）
      const payload = { choices: [{ message: { role: 'assistant', content: mode.content } }] };
      if (mode.usage !== null) payload.usage = mode.usage;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    setReply(content, usage = DEFAULT_USAGE) {
      mode = { kind: 'ok', content, usage };
    },
    setFail() {
      mode = { kind: 'fail' };
    },
    setEmpty() {
      mode = { kind: 'empty' };
    },
    setHang() {
      mode = { kind: 'hang' };
    },
    async close() {
      server.closeAllConnections?.(); // 掐掉 keep-alive 连接，保证测试进程退出
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
