// mock OneBot 11（NapCat 式）正向 WS 服务器。
// 供 node:test 自动化用例导入使用；真实 NapCat / QQ 不参与自动验证。
import WebSocket, { WebSocketServer } from 'ws';

export async function startMockServer({ token = '' } = {}) {
  const wss = new WebSocketServer({ port: 0 });

  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  wss.on('error', () => {});

  const port = wss.address().port;
  const frames = [];
  const clients = new Set();
  const frameWaiters = [];
  const connectionWaiters = [];

  let autoRespond = true;
  let pendingFailure = null;
  let nextMessageId = 1000;
  let closed = false;

  function settleFrameWaiters() {
    for (let i = frameWaiters.length - 1; i >= 0; i--) {
      const waiter = frameWaiters[i];
      const frame = frames.find(waiter.predicate);
      if (frame !== undefined) {
        frameWaiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    }
  }

  function settleConnectionWaiters() {
    for (let i = connectionWaiters.length - 1; i >= 0; i--) {
      const waiter = connectionWaiters[i];
      if (clients.size >= waiter.n) {
        connectionWaiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(clients.size);
      }
    }
  }

  function dropWaiters(reason) {
    for (const waiter of frameWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    for (const waiter of connectionWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
  }

  function broadcast(text) {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    }
  }

  wss.on('connection', (ws, req) => {
    // 鉴权（协议 §5）：token 非空时，Bearer 不匹配的连接立即被服务端关闭
    if (token !== '') {
      const authorization = req.headers['authorization'] ?? '';
      if (authorization !== `Bearer ${token}`) {
        ws.close(4001, 'authorization failed');
        return;
      }
    }

    clients.add(ws);
    settleConnectionWaiters();

    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return; // 非 JSON 坏帧丢弃，不入 frames
      }
      frames.push(frame);
      settleFrameWaiters();

      if (frame === null || typeof frame !== 'object' || typeof frame.action !== 'string') return;

      if (pendingFailure) {
        const { retcode, wording } = pendingFailure;
        pendingFailure = null;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ status: 'failed', retcode, data: null, echo: frame.echo, wording }));
        }
      } else if (autoRespond) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              status: 'ok',
              retcode: 0,
              data: { message_id: nextMessageId++ },
              echo: frame.echo,
              wording: '',
            })
          );
        }
      }
    });

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  return {
    port,
    url: `ws://localhost:${port}`,
    frames,
    get connections() {
      return clients.size;
    },

    injectEvent(obj) {
      broadcast(JSON.stringify(obj));
    },

    sendRaw(text) {
      broadcast(text);
    },

    setAutoRespond(enabled) {
      autoRespond = Boolean(enabled);
    },

    failNextCall(retcode = 1400, wording = 'mock failure') {
      pendingFailure = { retcode, wording };
    },

    disconnectClients() {
      for (const ws of clients) ws.close(1000, 'mock server disconnect');
    },

    close() {
      if (closed) return Promise.resolve();
      closed = true;
      dropWaiters('mock server closed');
      for (const ws of clients) ws.terminate();
      clients.clear();
      return new Promise((resolve) => wss.close(() => resolve()));
    },

    waitForFrame(predicate, { timeoutMs = 2000 } = {}) {
      return new Promise((resolve, reject) => {
        const existing = frames.find(predicate);
        if (existing !== undefined) {
          resolve(existing);
          return;
        }
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const index = frameWaiters.indexOf(waiter);
          if (index !== -1) frameWaiters.splice(index, 1);
          reject(new Error(`waitForFrame: no matching frame within ${timeoutMs}ms`));
        }, timeoutMs);
        frameWaiters.push(waiter);
      });
    },

    waitForConnectionCount(n, { timeoutMs = 2000 } = {}) {
      return new Promise((resolve, reject) => {
        if (clients.size >= n) {
          resolve(clients.size);
          return;
        }
        const waiter = { n, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const index = connectionWaiters.indexOf(waiter);
          if (index !== -1) connectionWaiters.splice(index, 1);
          reject(new Error(`waitForConnectionCount: ${n} connections not reached within ${timeoutMs}ms`));
        }, timeoutMs);
        connectionWaiters.push(waiter);
      });
    },
  };
}
