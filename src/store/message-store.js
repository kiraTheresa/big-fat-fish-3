// 消息存储（横切组件，bot-core-design §6）：按会话把入站消息快照追加写 JSONL，
// 一行一条：{dataDir}/messages/{sessionKey}.jsonl；出站回复以 bot:true 标记回存
// （add-aichat-mvp spec：落实 §6.3「LLM 需要完整对话上下文」的预留条款）。
// 纪律（§6.3）：旁听者——只被分发层 fire-and-forget 调用，任何读写失败仅记 WARN、
// 绝不向上抛。dataDir 在调用时读取（而非模块加载时求值），保证测试 env 注入生效。
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// 追加写串行化：入站快照与 bot 回复在同一事件流里几乎同时提交（fire-and-forget，
// 谁都不 await），若并发落盘，同会话两行的先后不可控（多轮上下文会拿到错序角色）。
// 链式 Promise 保证「按提交顺序逐条写完」，对调用方仍是即发即忘、失败只记 WARN。
let writeChain = Promise.resolve();

export function appendMessage(snapshot) {
  writeChain = writeChain.then(() => appendOne(snapshot));
  return writeChain;
}

async function appendOne(snapshot) {
  try {
    const dir = join(config.dataDir, 'messages');
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${snapshot.sessionKey}.jsonl`), JSON.stringify(snapshot) + '\n');
  } catch (err) {
    logger.warn(`消息存储失败: ${err.message}`);
  }
}

// 读某会话最近 limit 条记录（尾部截取），供 AIChat 构造上下文。
// 文件不存在（会话尚未落盘）返回 []；单行损坏跳过不炸整体；读失败仅记 WARN。
export async function readRecentMessages(sessionKey, limit) {
  try {
    const file = join(config.dataDir, 'messages', `${sessionKey}.jsonl`);
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n').filter((line) => line !== '');
    const records = [];
    for (const line of lines.slice(-limit)) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // 损坏行跳过：不因单行坏数据丢掉整个会话历史
      }
    }
    return records;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    logger.warn(`消息读取失败: ${err.message}`);
    return [];
  }
}
