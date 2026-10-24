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
  // ---- AIChat（LLM）----
  // DeepSeek API Key（留空 = chat 触发器不生效）
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? '',
  // OpenAI 兼容接口地址
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  deepseekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  // LLM 调用超时（ms）
  chatTimeoutMs: num(process.env.CHAT_TIMEOUT_MS, 60000),
  // 每次对话携带的历史条数（会话 JSONL 尾部）
  chatContextLines: num(process.env.CHAT_CONTEXT_LINES, 20),
  // 会话级冷却（ms）：窗口内后续消息静默跳过，防刷防刷量
  chatCooldownMs: num(process.env.CHAT_COOLDOWN_MS, 5000),
  // ---- 自进化人设（默认值出处：add-self-evolving-persona spec 设计决策）----
  // 管理员 QQ 白名单（ADMIN_QQ 逗号分隔 → 字符串数组，跨群统一；默认 [] = 群聊管理指令全拒）
  adminQq: (process.env.ADMIN_QQ ?? '')
    .split(',')
    .map((qq) => qq.trim())
    .filter((qq) => qq !== ''),
  // 人设文件根目录（按会话隔离的 character.md / memory.md）
  personaDir: process.env.PERSONA_DIR ?? 'data/personas',
  // character.md / memory.md 单文件字节上限（append 超限环形淘汰，patch 超限拒绝）
  personaMaxBytes: num(process.env.PERSONA_MAX_BYTES, 4096),
  // 离线提炼触发条件一：会话静默毫秒数（与批量条件先到先触发）
  distillSilenceMs: num(process.env.DISTILL_SILENCE_MS, 600000),
  // 离线提炼触发条件二：水位后新增消息条数
  distillBatchSize: num(process.env.DISTILL_BATCH_SIZE, 50),
  // 离线提炼调度器扫描间隔（ms）
  distillIntervalMs: num(process.env.DISTILL_INTERVAL_MS, 60000),
  // LLM 用量 JSONL 落盘根目录
  usageDir: process.env.USAGE_DIR ?? 'data/usage',
};
