// L1 连接层：只认识 OneBot 11，不含任何业务。
// 职责：正向 WS 连接/鉴权（Bearer）、断线自动重连、入站帧筛选（①JSON 可解析 ②有 echo 走
// API 响应、无 echo 走事件上抛）、API 下调（callApi：echo 自增、apiTimeoutMs 超时、retcode 判定）。
// 协议依据：napcat-protocol.md §2.3–2.4；筛选顺序依据：bot-core-design.md §2.1。
import WebSocket from 'ws';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let ws = null; // 当前连接（始终指向最新一条）
let echoSeq = 0; // echo 自增序号
const activeEvents = new Set();
const pending = new Map(); // echo -> { resolve, reject, timer }
let eventHandler = null; // onEvent 注册的事件上抛回调
let reconnectTimer = null; // 断线重连定时器
let stopped = true; // 生命周期标记：stopConnection() 后不再自动重连
const status = {
  connectedAt: null, disconnectedAt: null, lastEventAt: null, lastHeartbeatAt: null,
  heartbeatIntervalMs: null, heartbeatStatus: null, lastError: null,
  eventsReceived: 0, malformedFrames: 0, handlerErrors: 0, connectionAttempts: 0,
};

export function getConnectionStatus() {
  return {
    ...status, heartbeatStatus: status.heartbeatStatus ? structuredClone(status.heartbeatStatus) : null,
    connected: ws?.readyState === WebSocket.OPEN, stopped,
    reconnecting: reconnectTimer !== null, pendingApiCalls: pending.size, activeEvents: activeEvents.size,
  };
}

export function onEvent(fn) {
  eventHandler = fn;
}

export function startConnection() {
  stopped = false;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  // 已有存活/进行中的连接则不重复建连，避免双连接、双重连
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connect();
}

function connect() {
  status.connectionAttempts++;
  const headers = config.accessToken !== '' ? { Authorization: `Bearer ${config.accessToken}` } : undefined;
  const sock = new WebSocket(config.wsUrl, { headers });
  ws = sock;

  sock.on('open', () => {
    if (ws !== sock) return;
    status.connectedAt = Date.now();
    status.lastError = null;
    logger.info(`已连接 OneBot 服务: ${config.wsUrl}`);
  });

  sock.on('message', (raw) => {
    if (ws !== sock || stopped) return;
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      status.malformedFrames++;
      return; // 筛选①：JSON 不可解析 → 丢弃
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      status.malformedFrames++;
      return;
    }
    // 筛选②：有 echo 且在 pending 表 → API 响应，按 echo 匹配回调
    if (frame?.echo !== undefined && pending.has(String(frame.echo))) {
      settle(String(frame.echo), frame);
      return;
    }
    // All protocol event types pass upstream; API responses remain separate.
    if (typeof frame.post_type !== 'string' || frame.post_type.trim() === '') return;
    status.lastEventAt = Date.now();
    status.eventsReceived++;
    if (frame.post_type === 'meta_event' && frame.meta_event_type === 'heartbeat') {
      status.lastHeartbeatAt = status.lastEventAt;
      status.heartbeatIntervalMs = Number.isFinite(frame.interval) && frame.interval > 0 ? frame.interval : null;
      status.heartbeatStatus = frame.status && typeof frame.status === 'object' && !Array.isArray(frame.status) ? structuredClone(frame.status) : null;
    }
    if (eventHandler) {
      // Both synchronous throws and async rejection are isolated from the socket.
      const handler = eventHandler;
      const active = Promise.resolve().then(() => handler(frame)).catch((err) => {
        status.handlerErrors++;
        logger.error(`OneBot 事件处理失败: ${err?.message ?? String(err)}`);
      }).finally(() => activeEvents.delete(active));
      activeEvents.add(active);
    }
  });

  sock.on('error', (err) => {
    if (stopped) return; // 主动停机（stopConnection 终止 CONNECTING 套接字）不算异常
    status.lastError = err.message;
    logger.warn(`连接错误: ${err.message}`); // error 不致命：记 WARN，等 close 走重连
  });

  sock.on('close', () => {
    if (ws !== sock) return; // 已被 stopConnection 或新一轮 startConnection 取代
    ws = null;
    status.disconnectedAt = Date.now();
    if (stopped) return;
    logger.warn(`连接断开，${config.reconnectDelayMs}ms 后重连`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) connect();
    }, config.reconnectDelayMs);
  });
}

function settle(echo, frame) {
  const entry = pending.get(echo);
  pending.delete(echo);
  clearTimeout(entry.timer);
  if (frame.retcode === 0) entry.resolve(frame.data);
  else entry.reject(new Error(`OneBot API 失败: ${frame.wording || `retcode=${frame.retcode}`}`));
}

// 调用 OneBot API：发送 {action, params, echo}，按 echo 匹配响应。
// retcode===0 → resolve(data)；非 0 → reject（信息含 wording 或 retcode）；超时 → reject。
export function callApi(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('WS 未连接'));
      return;
    }
    const echo = String(++echoSeq);
    const timer = setTimeout(() => {
      if (pending.delete(echo)) reject(new Error(`API 调用超时: ${action}`));
    }, config.apiTimeoutMs);
    pending.set(echo, { resolve, reject, timer });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

// 生命周期收口（测试退出 / 优雅停机）：清重连定时器、关闭连接、reject 全部未决 API 调用。
export function stopConnection() {
  stopped = true;
  status.disconnectedAt = Date.now();
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('连接已停止，API 调用中止'));
  }
  pending.clear();
  if (ws) {
    const sock = ws;
    ws = null;
    if (sock.readyState === WebSocket.OPEN) sock.close();
    else sock.terminate();
  }
}

export async function drainEventHandlers(timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      Promise.allSettled([...activeEvents]).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
