// WS 连接层：只认识 OneBot 11，不含业务。
// 职责：连接/重连、事件上抛（onEvent）、API 下调（callApi，echo 匹配）。
import WebSocket from 'ws';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let ws = null;
let echoSeq = 0;
const pending = new Map(); // echo -> { resolve, reject }
let eventHandler = null;

export function onEvent(fn) {
  eventHandler = fn;
}

export function startConnection() {
  const headers = config.accessToken
    ? { Authorization: `Bearer ${config.accessToken}` }
    : undefined;
  ws = new WebSocket(config.wsUrl, { headers });

  ws.on('open', () => logger.info(`已连接 OneBot 服务: ${config.wsUrl}`));

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return; // 非 JSON 帧，忽略
    }

    // API 响应：按 echo 匹配回调
    if (data.echo !== undefined && pending.has(String(data.echo))) {
      const { resolve, reject } = pending.get(String(data.echo));
      pending.delete(String(data.echo));
      if (data.retcode === 0) resolve(data.data);
      else reject(new Error(`OneBot API 失败: ${data.wording || `retcode=${data.retcode}`}`));
      return;
    }

    // 事件：上抛给分发层
    if (data.post_type && eventHandler) eventHandler(data);
  });

  ws.on('error', (err) => logger.warn(`连接错误: ${err.message}`));

  ws.on('close', () => {
    logger.warn(`连接断开，${config.reconnectDelayMs}ms 后重连`);
    setTimeout(startConnection, config.reconnectDelayMs);
  });
}

// 调用 OneBot API，如 callApi('send_group_msg', { group_id, message })
export function callApi(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('WS 未连接'));
      return;
    }
    const echo = String(++echoSeq);
    pending.set(echo, { resolve, reject });
    ws.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => {
      if (pending.delete(echo)) reject(new Error(`API 调用超时: ${action}`));
    }, 15000);
  });
}
