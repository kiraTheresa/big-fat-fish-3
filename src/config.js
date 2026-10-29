// 配置：环境变量优先 + 默认值，全项目唯一配置来源
// 默认值出处：napcat-protocol.md §2.4（断线 5s 重连、15s 调用超时）、bot-core-design.md §3（发送固定 1s 间隔）
// 混合开关（upgrade-chat-pipeline spec）：连接/密钥/路径留 .env，行为开关进 config.json
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './utils/logger.js';
import { POKE_PROMPT } from './prompt/defaults.js';

function num(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

// 行为开关默认值（字段结构即对外契约，config.json 同名字段覆盖、缺省字段走默认）
export const DEFAULT_BEHAVIOR = {
  trigger: {
    // @命中：群聊 @bot 即触发（条件组合器既有条件，spec「条件全关」场景要求每个条件都有开关）
    at: { enabled: true },
    // 名字呼唤：命中 aliases 任一即触发
    nameCall: { enabled: true, aliases: ['大肥鱼', '肥鱼'] },
    // 引用回复：引用 bot 消息即触发
    replyQuote: { enabled: true },
    poke: { enabled: true, prompt: POKE_PROMPT },
  },
  chat: { cooldownMs: 2000 },
  reply: {
    // 随机延迟：模拟人的打字节奏
    delay: { enabled: true, minMs: 2000, maxMs: 8000 },
    // 分段连发：按 separator 拆为多条消息
    split: { enabled: true, separator: '||' },
    // 回复带引用：携带原消息引用
    quote: { enabled: true },
  },
  context: {
    // 上下文字节预算：人设+记忆+历史总量封顶，超出裁最旧历史
    budgetBytes: 12000,
  },
};

// 深合并：用户配置逐层覆盖默认值，未出现的字段保留默认；数组与原始值整体替换（不逐项合并）
function deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const base = defaults[key];
    const bothPlainObject =
      base !== null && typeof base === 'object' && !Array.isArray(base) &&
      value !== null && typeof value === 'object' && !Array.isArray(value);
    result[key] = bothPlainObject ? deepMerge(base, value) : value;
  }
  return result;
}

// 读取 config.json：读取失败只 WARN 不抛（与存储层纪律一致，spec 要求缺失/损坏回退默认继续启动）
function loadBehaviorConfig() {
  const path = process.env.CONFIG_PATH ?? './config.json';
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // ENOENT 属正常场景（用户未创建 config.json），静默回退；其余读失败记 WARN
    if (err.code !== 'ENOENT') {
      logger.warn(`config.json 读取失败（${path}），行为开关回退默认：`, err.message);
    }
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(`config.json 解析失败（${path}），行为开关回退默认：`, err.message);
    return {};
  }
  // 合法 JSON 但顶层非对象（如数组/字符串/null）无法作为配置结构，视同损坏处理
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn(`config.json 顶层应为对象（${path}），行为开关回退默认`);
    return {};
  }
  return parsed;
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
  // 本地管理服务：无 token 不启动；密钥仅从环境读取。
  adminHost: process.env.ADMIN_HOST ?? '127.0.0.1',
  adminPort: num(process.env.ADMIN_PORT, 3210),
  adminToken: process.env.ADMIN_TOKEN ?? '',
  logLevel: process.env.LOG_LEVEL ?? 'INFO',
  retentionDays: num(process.env.RETENTION_DAYS, 30),
  // ---- AIChat（LLM）----
  // DeepSeek API Key（留空 = chat 触发器不生效）
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? '',
  // OpenAI 兼容接口地址
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  deepseekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  // LLM 调用超时（ms）
  chatTimeoutMs: num(process.env.CHAT_TIMEOUT_MS, 60000),
  // 对话/识图默认流式接收；不兼容的中转可设 false，提炼仍使用完整 JSON。
  chatStream: process.env.CHAT_STREAM !== 'false',
  // 每次对话携带的历史条数（会话 JSONL 尾部）
  chatContextLines: num(process.env.CHAT_CONTEXT_LINES, 20),
  // 会话冷却启动初值（ms）；运行时使用 behavior.chat.cooldownMs，支持面板热更新
  chatCooldownMs: num(process.env.CHAT_COOLDOWN_MS, 2000),
  // ---- 识图（chat 触发器图分流；DeepSeek 视觉款，与上共用同一 Key/BaseUrl）----
  // 视觉模型（留空 = 识图关闭，同 deepseekApiKey 模式；deepseek-flash 实测可看图，
  // 单图约 1024 tokens，图只能放 user 消息块——system/assistant 带图 400）
  deepseekVisionModel: process.env.DEEPSEEK_VISION_MODEL ?? 'deepseek-flash',
  // 周围图时间窗（ms）：@ 消息不带图时，群聊同用户该窗口内最新一条图可被识图引用
  visionImageWindowMs: num(process.env.VISION_IMAGE_WINDOW_MS, 120000),
  // 图片现拉超时（ms）：QQ CDN rkey URL 直接 GET（带 UA 防 403，实测可下）
  visionFetchTimeoutMs: num(process.env.VISION_FETCH_TIMEOUT_MS, 30000),
  // ---- 自进化人设（默认值出处：add-self-evolving-persona spec 设计决策）----
  // 管理员 QQ 白名单（ADMIN_QQ 逗号分隔 → 字符串数组，跨群统一；默认 [] = 群聊管理指令全拒）
  adminQq: (process.env.ADMIN_QQ ?? '')
    .split(',')
    .map((qq) => qq.trim())
    .filter((qq) => qq !== ''),
  // 人设文件根目录（按会话隔离的 character.md / memory.md）
  personaDir: process.env.PERSONA_DIR ?? join(process.env.DATA_DIR ?? 'data', 'personas'),
  // character.md / memory.md 单文件字节上限（append 超限环形淘汰，patch 超限拒绝）
  personaMaxBytes: num(process.env.PERSONA_MAX_BYTES, 4096),
  // 离线提炼触发条件一：会话静默毫秒数（与批量条件先到先触发）
  distillSilenceMs: num(process.env.DISTILL_SILENCE_MS, 600000),
  // 离线提炼触发条件二：水位后新增消息条数
  distillBatchSize: num(process.env.DISTILL_BATCH_SIZE, 50),
  // 离线提炼调度器扫描间隔（ms）
  distillIntervalMs: num(process.env.DISTILL_INTERVAL_MS, 300000),
  // 群聊最后一次有效调用后多久退出记忆提炼（默认两小时）
  distillIdleMs: Math.max(1000, num(process.env.DISTILL_IDLE_MS, 7200000)),
  // LLM 用量 JSONL 落盘根目录
  usageDir: process.env.USAGE_DIR ?? join(process.env.DATA_DIR ?? 'data', 'usage'),
  // ---- 绘图（draw 触发器 / imagegen.js 唯一出口）----
  // 上游可切换（OpenAI Images 协议 /v1/images/generations：老张中转 / 火山方舟 /
  // 任意兼容源），换上游只改 base_url + key + model 三项，代码零改动。
  // 域名注意（2026-10 实测）：老张默认主域名 api.laozhang.ai 国内直连不通，用 api2。
  imageApiBaseUrl: process.env.IMAGE_API_BASE_URL ?? 'https://api2.laozhang.ai/v1',
  // 绘图 API Key（留空 = draw 触发器不生效，同 deepseekApiKey 模式）
  imageApiKey: process.env.IMAGE_API_KEY ?? '',
  imageModel: process.env.IMAGE_MODEL ?? 'gpt-image-2.5-flare-vip',
  // 出图尺寸（老张兼容 '2K' 简写与 '1024x1024' 全写，实测 2K 可用）
  imageSize: process.env.IMAGE_SIZE ?? '2K',
  // 绘图超时（ms）：实测 GPT Image 2.5 出图 20-70s，给足余量
  imageTimeoutMs: num(process.env.IMAGE_TIMEOUT_MS, 120000),
  // ---- 行为开关（config.json 层，字段说明见 config.example.json）----
  behavior: deepMerge({ ...DEFAULT_BEHAVIOR, chat: { cooldownMs: num(process.env.CHAT_COOLDOWN_MS, 2000) } }, loadBehaviorConfig()),
};
