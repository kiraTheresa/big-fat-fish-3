// 消息存储（横切组件，bot-core-design §6）：按会话把入站消息快照追加写 JSONL，
// 一行一条：{dataDir}/messages/{sessionKey}.jsonl。
// 纪律（§6.3）：旁听者——只被分发层 fire-and-forget 调用，任何写失败（目录不可建、
// 盘满等）仅记 WARN、绝不向上抛；出站回复不回存（本模块只接收分发层给出的入站快照）。
// dataDir 在调用时读取（而非模块加载时求值），保证测试 env 注入生效。
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export async function appendMessage(snapshot) {
  try {
    const dir = join(config.dataDir, 'messages');
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${snapshot.sessionKey}.jsonl`), JSON.stringify(snapshot) + '\n');
  } catch (err) {
    logger.warn(`消息存储失败: ${err.message}`);
  }
}
