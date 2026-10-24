// 配置：环境变量优先，带本地默认值
export const config = {
  // NapCat 正向 WebSocket 地址
  wsUrl: process.env.ONEBOT_WS_URL ?? 'ws://localhost:3001',
  // OneBot 访问令牌（与 NapCat WebUI 网络配置保持一致，空 = 不校验）
  accessToken: process.env.ONEBOT_ACCESS_TOKEN ?? '',
  // 断线重连间隔（ms）
  reconnectDelayMs: 3000,
  // 发送限流间隔（ms）——出站消息的防风控节流，全项目仅 sender 一处
  sendIntervalMs: 1000,
};
