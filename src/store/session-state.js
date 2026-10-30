// 会话状态存储（add-self-evolving-persona spec「会话状态」）：按会话读写
// {dataDir}/session-state/{sessionKey}.json：重置/提炼水位、失败退避及群聊 memoryActivity。
// resetAt 供 chat 触发器过滤历史水位，distillMark 供 distiller 记录提炼水位。
// 纪律（同 message-store）：update 走「读-合-写」且经 writeChain 串行化，防并发更新
// 以过期底稿互相覆盖丢键；任何失败仅记 WARN、绝不向上抛（调用方拿 {} / false 兜底）。
// dataDir 在调用时读取（而非模块加载时求值），保证测试 env 注入生效。
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteJson } from '../platform/persistence.js';
import { logger } from '../utils/logger.js';

// 读-合-写串行化：指令触发器（/reset 置 resetAt）与 distiller（推进 distillMark）
// 可能在不同异步流里同时更新同一会话，若并发执行「读旧值→合并→写回」，
// 后写者会丢掉先写者刚落盘的键。链式 Promise 保证按提交顺序逐个完成。
let writeChain = Promise.resolve();

export function updateState(sessionKey, patch) {
  writeChain = writeChain.then(() => updateOne(sessionKey, patch));
  return writeChain;
}

async function updateOne(sessionKey, patch) {
  try {
    const current = await readState(sessionKey); // 文件不存在/损坏均已兜底 {}
    const dir = join(config.dataDir, 'session-state');
    await mkdir(dir, { recursive: true });
    await atomicWriteJson(join(dir, `${sessionKey}.json`), { ...current, ...(typeof patch === 'function' ? patch(current) : patch) });
    return true;
  } catch (err) {
    logger.warn(`会话状态写入失败(${sessionKey}): ${err.message}`);
    return false;
  }
}

// 读会话状态。文件不存在（会话尚无状态）静默返回 {}；损坏或其他读失败仅 WARN 返回 {}。
export async function readState(sessionKey) {
  try {
    return JSON.parse(await readFile(join(config.dataDir, 'session-state', `${sessionKey}.json`), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    logger.warn(`会话状态读取失败(${sessionKey}): ${err.message}`);
    return {};
  }
}
