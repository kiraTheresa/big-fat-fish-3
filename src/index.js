// 装配入口（架构文档 §5 分层规则）：注册触发器 → 接线 → 启动。
// 本文件是全项目唯一「知道所有层」的位置，import 即启动（npm start 与 E2E 的装配对象）。
import { config } from './config.js';
import { onEvent, startConnection, stopConnection, drainEventHandlers } from './connection/onebot.js';
import { dispatch } from './dispatch/dispatcher.js';
import { register } from './dispatch/registry.js';
import { logger } from './utils/logger.js';
import ping from './triggers/ping.js';
import draw from './triggers/draw.js';
import command from './triggers/command.js';
import chat from './triggers/chat.js';
import { drainSender } from './sender/sender.js';
import { startPlatform } from './platform/runtime.js';

export const platform = await startPlatform();

register(ping); // L3：加功能 = triggers/ 加一个文件 + 此处一行注册（ping 先注册，优先于 chat）
register(draw); // L3 绘图：/draw（默认公开）。必须排在 command 之前——command 的 '/' match 会吃掉 /draw
register(command); // L3 指令：'/' 前缀（help/status/persona/memory/remember/reset/history），群聊须 @ 本鱼（门控在 handle，match 仍宽吞）；置于 chat 前优先（命中即停，指令不落入 LLM）
register(chat); // AIChat：私聊全量 / 群聊 @bot（未配置 DEEPSEEK_API_KEY 时自动不生效）
onEvent(dispatch); // 接线：L1 连接层事件上抛 → L2 分发层（筛选 / 打标 / 存储 / 触发器链）

logger.info(`Bot 核心启动，目标: ${config.wsUrl}`);
startConnection(); // L1：连上 OneBot（NapCat）正向 WS

// Shared scheduler owns memory scans and maintenance; no independent distiller timer.
let stopping = false;
export async function shutdown() {
  if (stopping) return;
  stopping = true;
  onEvent(null);
  const scheduled = platform.scheduler.stop();
  await drainEventHandlers(5000);
  await drainSender(1000);
  stopConnection();
  await scheduled;
  await platform.stop();
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    const deadline = setTimeout(() => { logger.warn('停机等待超时，未完成调用将在下次启动记为中断'); process.exit(1); }, 8000);
    deadline.unref();
    shutdown().then(() => process.exit(0)).catch((err) => {
      logger.error(`停机清理失败: ${err.message}`);
      process.exit(1);
    });
  });
}
