// 消息存储（横切组件，bot-core-design §6）：按会话把入站消息快照追加写 JSONL，
// 一行一条：{dataDir}/messages/{sessionKey}.jsonl；出站回复以 bot:true 标记回存
// （add-aichat-mvp spec：落实 §6.3「LLM 需要完整对话上下文」的预留条款）。
// 纪律（§6.3）：旁听者——只被分发层 fire-and-forget 调用，任何读写失败仅记 WARN、
// 绝不向上抛。dataDir 在调用时读取（而非模块加载时求值），保证测试 env 注入生效。
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { appendJsonl } from '../platform/persistence.js';

// 追加写串行化：入站快照与 bot 回复在同一事件流里几乎同时提交（fire-and-forget，
// 谁都不 await），若并发落盘，同会话两行的先后不可控（多轮上下文会拿到错序角色）。
// 链式 Promise 保证「按提交顺序逐条写完」，对调用方仍是即发即忘、失败只记 WARN。
let writeChain = Promise.resolve();

// Session identifiers originate in untrusted protocol frames and the admin API.
// Keep filenames within messages/, even when callers bypass the dispatcher.
const isSafeSessionKey = (key) => typeof key === 'string' && /^[gp]-[A-Za-z0-9_-]{1,64}$/.test(key);

export function appendMessage(snapshot) {
  if (!isSafeSessionKey(snapshot?.sessionKey)) return Promise.resolve();
  let stored;
  try { stored = { ...structuredClone(snapshot), receivedAt: snapshot.receivedAt ?? Date.now(), recordId: randomUUID() }; }
  catch (err) { logger.warn(`消息存储失败: ${err.message}`); return Promise.resolve(); }
  writeChain = writeChain.then(() => appendOne(stored));
  return writeChain;
}

async function appendOne(snapshot) {
  try {
    const dir = join(config.dataDir, 'messages');
    await appendJsonl(join(dir, `${snapshot.sessionKey}.jsonl`), snapshot);
  } catch (err) {
    logger.warn(`消息存储失败: ${err.message}`);
  }
}

// 读某会话最近 limit 条记录（尾部截取），供 AIChat 构造上下文。
// 文件不存在（会话尚未落盘）返回 []；单行损坏跳过不炸整体；读失败仅记 WARN。
export async function readRecentMessages(sessionKey, limit) {
  if (!isSafeSessionKey(sessionKey) || !Number.isFinite(limit) || limit <= 0) return [];
  await writeChain;
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

// 读时间水位 sinceTime 之后的消息（尾部最多 limit 条，升序），供 distiller 取
// 「待提炼增量」与 /status 统计未提炼条数（add-self-evolving-persona Task 8 预留，
// Task 6 的 /status 先行使用）。项目数据量小，直接全读后过滤（无需尾部动态扩读）：
// JSONL 追加写天然按时间升序，过滤 rec.time > sinceTime（严格大于，水位本身不重复
// 处理）后取尾部 limit 条即得。文件不存在返回 []；损坏行跳过；读失败仅记 WARN。
// include 在截取前过滤；oldest 供群聊活跃窗口按最早未处理消息分批，避免丢掉积压。
export async function readMessagesSince(sessionKey, sinceTime, limit, include = () => true, { oldest = false } = {}) {
  if (!isSafeSessionKey(sessionKey) || !Number.isFinite(limit) || limit <= 0) return [];
  await writeChain;
  try {
    const file = join(config.dataDir, 'messages', `${sessionKey}.jsonl`);
    const text = await readFile(file, 'utf8');
    const records = [];
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // 损坏行跳过：不因单行坏数据丢掉整个水位区间
      }
    }
    const filtered = records.filter((rec) => (rec.time ?? 0) > sinceTime && include(rec));
    return oldest ? filtered.slice(0, limit) : filtered.slice(-limit);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    logger.warn(`消息读取失败: ${err.message}`);
    return [];
  }
}

export function flushMessageStore() { return writeChain; }
