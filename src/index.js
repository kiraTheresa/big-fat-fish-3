// 装配入口（架构文档 §5 分层规则）：注册触发器 → 接线 → 启动。
// 本文件是全项目唯一「知道所有层」的位置，import 即启动（npm start 与 E2E 的装配对象）。
import { config } from './config.js';
import { onEvent, startConnection } from './connection/onebot.js';
import { dispatch } from './dispatch/dispatcher.js';
import { register } from './dispatch/registry.js';
import { logger } from './utils/logger.js';
import ping from './triggers/ping.js';

register(ping); // L3：加功能 = triggers/ 加一个文件 + 此处一行注册
onEvent(dispatch); // 接线：L1 连接层事件上抛 → L2 分发层（筛选 / 打标 / 存储 / 触发器链）

logger.info(`Bot 核心启动，目标: ${config.wsUrl}`);
startConnection(); // L1：连上 OneBot（NapCat）正向 WS
