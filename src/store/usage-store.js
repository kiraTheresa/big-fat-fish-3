// LLM 用量存储（add-self-evolving-persona spec「用量观测」）：按会话把每次
// chatCompletion 的 usage 快照追加写 JSONL，一行一条：{usageDir}/{sessionKey}.jsonl，
// 行形状 { time, kind: 'chat'|'distill', model, prompt_tokens?, completion_tokens?,
// total_tokens?, prompt_cache_hit_tokens? }（缓存命中字段供观测 DeepSeek 上下文缓存）。
// 纪律（同 message-store）：旁路观测——appendUsage 由 chat/distill 调用方 fire-and-forget
// 提交，任何失败仅记 WARN、绝不向上抛；写入走 writeChain 串行化。
// usageDir 在调用时读取（而非模块加载时求值），保证测试 env 注入生效。
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// 追加写串行化：同一会话的多次 LLM 调用几乎同时提交 usage（调用方均不 await），
// 链式 Promise 保证「按提交顺序逐条写完」。
let writeChain = Promise.resolve();

// 追加一条用量记录（kind 缺省 'chat'）。API 为 async：调用方不 await 也安全
//（appendOne 内部全捕获，浮动的 Promise 不会产生未处理拒绝）。
export function appendUsage(sessionKey, record) {
  writeChain = writeChain.then(() => appendOne(sessionKey, record));
  return writeChain;
}

async function appendOne(sessionKey, record) {
  try {
    const dir = config.usageDir;
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${sessionKey}.jsonl`), JSON.stringify({ ...record, kind: record.kind ?? 'chat' }) + '\n');
  } catch (err) {
    logger.warn(`用量记录失败(${sessionKey}): ${err.message}`);
  }
}

// 汇总会话用量：读全文件逐行累计调用次数与各 token 字段（缓存命中单独计）。
// 文件不存在（尚未产生调用）返回全 0；损坏行跳过；字段缺失按 0；读失败仅 WARN 返回全 0。
export async function readUsageStats(sessionKey) {
  const stats = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0 };
  try {
    const text = await readFile(join(config.usageDir, `${sessionKey}.jsonl`), 'utf8');
    for (const line of text.split('\n')) {
      if (line === '') continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // 损坏行跳过：不因单行坏数据丢掉整个会话用量
      }
      stats.calls += 1;
      stats.promptTokens += rec.prompt_tokens ?? 0;
      stats.completionTokens += rec.completion_tokens ?? 0;
      stats.totalTokens += rec.total_tokens ?? 0;
      stats.cacheHitTokens += rec.prompt_cache_hit_tokens ?? 0;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`用量读取失败(${sessionKey}): ${err.message}`);
  }
  return stats;
}
