// 配置：环境变量优先 + 默认值，全项目唯一配置来源
// 默认值出处：napcat-protocol.md §2.4（断线 5s 重连、15s 调用超时）、bot-core-design.md §3（发送固定 1s 间隔）
function num(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export const config = {
  // NapCat 正向 WebSocket 地址
  wsUrl: process.env.ONEBOT_WS_URL ?? 'ws://localhost:3001',
  // OneBot 访问令牌（Bearer 头；空 = 不校验）
  accessToken: process.env.ONEBOT_ACCESS_TOKEN ?? '',
  // 断线重连间隔（ms）
  reconnectDelayMs: num(process.env.RECONNECT_DELAY_MS, 5000),
  // API 调用超时（ms，echo 匹配等待上限）
  apiTimeoutMs: num(process.env.API_TIMEOUT_MS, 15000),
  // 出站消息限流间隔（ms，全项目仅 sender 一处管理）
  sendIntervalMs: num(process.env.SEND_INTERVAL_MS, 1000),
  // 数据目录（消息 JSONL 落盘根目录）
  dataDir: process.env.DATA_DIR ?? 'data',
};
