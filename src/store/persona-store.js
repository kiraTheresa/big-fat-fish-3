// 人设存储（add-self-evolving-persona spec「人设存储」）：按会话管理
// {personaDir}/{sessionKey}/（g-{group_id} / p-{user_id}，与消息库键一致）下三个文件：
// character.md（人格，首次访问落种子，全文见 spec 附录）、memory.md（事实记忆，初始
// 空文件）、history.jsonl（审计，一行一条 { time, kind, summary }）。
// 纪律（同 message-store）：所有写操作经 writeChain 串行化——含 appendMemory 的
// 「读-淘汰-写回」，防并发以过期底稿互相覆盖；任何失败仅记 WARN、绝不向上抛
// （调用方拿兜底值 / false）。personaDir / personaMaxBytes 在调用时读取（而非模块
// 加载时求值），保证测试 env 注入生效。
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// 种子人设全文（spec.md 附录，一字不差；引号是半角直引号，勿「顺手」改成全角）
const SEED_CHARACTER = [
  '# 大肥鱼',
  '',
  '你是一条呆呆傻傻的大肥鱼，QQ 群里和私聊里的吉祥物鱼。',
  '',
  '## 性格',
  '',
  '- 呆萌心大，反应慢半拍，但很真诚',
  '- 爱吃，总惦记火锅和奶茶',
  '- 被调侃也不生气，嘿嘿一笑就过去',
  '- 偶尔冒出奇怪的鱼生哲学',
  '',
  '## 说话方式',
  '',
  '- 简短口语化，自称"本鱼"',
  '- 句尾偶尔带"咕噜""啵"之类的气泡音',
  '- 不会的就承认不会，不装懂',
].join('\n');

// 写入串行化：getPersona 落种子、appendMemory 的「读-淘汰-写回」、patch、reset 会从
// chat / 指令 / distiller 等不同异步流到达，若并发执行，后写者会以过期底稿覆盖先写者
// （如两个 append 同时基于淘汰前旧内容各自写回，丢条目）。链式 Promise 保证按提交
// 顺序逐个完成。job 内部自兜底（失败 WARN 并返回兜底值），正常永不 reject；链上再
// 吞异常保险，保证链条永不断裂（返回调用方的仍是原始结果）。
let writeChain = Promise.resolve();

function runSerialized(job) {
  const result = writeChain.then(job);
  writeChain = result.catch(() => {});
  return result;
}

// 本地时区时间戳 YYYY-MM-DD HH:mm（零依赖内联实现，不引日期库）
function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sessionDir(sessionKey) {
  return join(config.personaDir, sessionKey);
}

// 读文件：不存在（ENOENT）返回 null，与「已落盘内容」区分；其他错误向上抛由调用方兜底
async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// 审计追加一行 { time, kind, summary }（JSONL，append-only 不淘汰）。仅由主写入已
// 成功的路径调用；失败只 WARN，不影响主操作的成功语义。
async function appendAudit(sessionKey, kind, summary) {
  await appendFile(
    join(sessionDir(sessionKey), 'history.jsonl'),
    JSON.stringify({ time: Date.now(), kind, summary }) + '\n'
  );
}

// 记忆条目落盘后的总字节数（行间 \n + 末尾 \n，与写回格式一致）
function memorySizeBytes(entries) {
  return Buffer.byteLength(entries.join('\n') + '\n', 'utf8');
}

// ---- getPersona：目录/文件不存在则先落种子，再返回 { character, memory } ----
export function getPersona(sessionKey) {
  return runSerialized(() => getPersonaOne(sessionKey));
}

async function getPersonaOne(sessionKey) {
  try {
    const dir = sessionDir(sessionKey);
    await mkdir(dir, { recursive: true });
    const character = await readIfExists(join(dir, 'character.md'));
    const memory = await readIfExists(join(dir, 'memory.md'));
    // 种子写入不检查大小上限：种子本身即受信任的基线内容
    if (character === null) await writeFile(join(dir, 'character.md'), SEED_CHARACTER);
    if (memory === null) await writeFile(join(dir, 'memory.md'), '');
    return {
      character: character ?? SEED_CHARACTER,
      memory: memory ?? '',
    };
  } catch (err) {
    logger.warn(`人设读取失败(${sessionKey}): ${err.message}`);
    return { character: SEED_CHARACTER, memory: '' }; // 兜底：读不到也要让人设可用
  }
}

// ---- appendMemory：追加 `- [YYYY-MM-DD HH:mm] 昵称: 内容`，超限环形淘汰最旧 ----
export function appendMemory(sessionKey, speaker, text) {
  return runSerialized(() => appendMemoryOne(sessionKey, speaker, text));
}

async function appendMemoryOne(sessionKey, speaker, text) {
  try {
    const dir = sessionDir(sessionKey);
    await mkdir(dir, { recursive: true });
    const line = `- [${formatTimestamp(new Date())}] ${speaker}: ${text}`;
    const existing = (await readIfExists(join(dir, 'memory.md'))) ?? '';
    const entries = existing.split('\n').filter((l) => l !== '');
    entries.push(line);
    // 环形淘汰：追加后超过 personaMaxBytes 则从最旧的 `- [` 开头行开始删除，直至
    // 不超限再写回；刚追加的最新行永不淘汰（单行即超限时宁可暂时超限也不丢新记忆）
    while (memorySizeBytes(entries) > config.personaMaxBytes) {
      const oldest = entries.findIndex((l, i) => i !== entries.length - 1 && l.startsWith('- ['));
      if (oldest === -1) break; // 除最新行外已无可淘汰条目
      entries.splice(oldest, 1);
    }
    await writeFile(join(dir, 'memory.md'), entries.join('\n') + '\n');
  } catch (err) {
    logger.warn(`记忆追加失败(${sessionKey}): ${err.message}`);
    return false;
  }
  try {
    await appendAudit(sessionKey, 'memory-append', `${speaker}: ${text}`.slice(0, 50));
  } catch (err) {
    logger.warn(`审计追加失败(${sessionKey}): ${err.message}`);
  }
  return true;
}

// ---- applyPersonaPatch：对提供字段整文件替换；任一超限整体拒绝 ----
export function applyPersonaPatch(sessionKey, patch) {
  return runSerialized(() => applyPatchOne(sessionKey, patch));
}

async function applyPatchOne(sessionKey, patch) {
  let files;
  try {
    // 只认字符串字段；一个都没有则无事可做
    files = [];
    if (patch && typeof patch.character === 'string') files.push(['character.md', patch.character]);
    if (patch && typeof patch.memory === 'string') files.push(['memory.md', patch.memory]);
    if (files.length === 0) return false;
    // 超限整体拒绝：任一字段替换后超过 personaMaxBytes 则完全不落盘（宁可不改也不半改）
    if (files.some(([, content]) => Buffer.byteLength(content, 'utf8') > config.personaMaxBytes)) {
      logger.warn(`人设补丁超限拒绝(${sessionKey}): 上限 ${config.personaMaxBytes} 字节`);
      return false;
    }
    const dir = sessionDir(sessionKey);
    await mkdir(dir, { recursive: true });
    for (const [name, content] of files) {
      await writeFile(join(dir, name), content);
    }
  } catch (err) {
    logger.warn(`人设补丁失败(${sessionKey}): ${err.message}`);
    return false;
  }
  try {
    await appendAudit(sessionKey, 'persona-patch', `更新 ${files.map(([name]) => name).join('、')}`);
  } catch (err) {
    logger.warn(`审计追加失败(${sessionKey}): ${err.message}`);
  }
  return true;
}

// ---- resetPersona：character.md 恢复种子、memory.md 清空 ----
export function resetPersona(sessionKey) {
  return runSerialized(() => resetPersonaOne(sessionKey));
}

async function resetPersonaOne(sessionKey) {
  try {
    const dir = sessionDir(sessionKey);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'character.md'), SEED_CHARACTER);
    await writeFile(join(dir, 'memory.md'), '');
  } catch (err) {
    logger.warn(`人设重置失败(${sessionKey}): ${err.message}`);
    return false;
  }
  try {
    await appendAudit(sessionKey, 'persona-reset', '恢复种子人设');
  } catch (err) {
    logger.warn(`审计追加失败(${sessionKey}): ${err.message}`);
  }
  return true;
}

// ---- readHistory：尾部 limit 条审计记录；文件不存在返回 []（纯读，不入写链） ----
export async function readHistory(sessionKey, limit) {
  try {
    const text = await readFile(join(sessionDir(sessionKey), 'history.jsonl'), 'utf8');
    const records = [];
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // 损坏行跳过：不因单行坏数据丢掉整个审计历史
      }
    }
    return limit ? records.slice(-limit) : records;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    logger.warn(`审计读取失败(${sessionKey}): ${err.message}`);
    return [];
  }
}
