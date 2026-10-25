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

// ---- /remember 锁定条目判定（add-self-evolving-persona spec「/remember 锁定条目校验」）----
// appendMemory（/remember 指令唯一落盘路径）写入行固定以 `- [YYYY-MM-DD HH:mm]` 开头，
// 即用户显式钦定的事实。提炼是 LLM 重写，可能顺手「精简」掉这些行——用户亲手教的
// 记忆权重高于模型整理。谓词安家 store 层：applyPersonaPatch 的 memory 兜底裁剪与
// distiller 的补丁校验都要用，而依赖必须单向（distiller → store，store 不得反向
// import distiller），故实现在此导出、distiller re-export 保持旧调用路径兼容。
export function isLockedLine(line) {
  // `startsWith('- [')` 同时排除空行与普通 `- ` 条目（无时间戳方括号）
  return line.startsWith('- [');
}

// 提取 memory 全部锁定行（保持原顺序）
export function extractLockedLines(memory) {
  return memory.split('\n').filter((line) => isLockedLine(line));
}

// 补丁 memory 必须逐行原文包含现 memory 的全部锁定行；空锁定恒通过（不阻塞新会话
// 首次提炼）。行级原文匹配：改写时间戳/说话人/内容或截断成子串都不算保留。
export function patchKeepsLockedLines(currentMemory, patchMemory) {
  return extractLockedLines(currentMemory).every((line) => patchMemory.includes(line));
}

// ---- applyPersonaPatch：对提供字段整文件替换；分文件判定，memory 超限兜底裁剪 ----
// 返回 { character, memory }（各文件是否实际落盘）而非单一 boolean。旧「任一超限
// 整体拒绝」策略曾致水位永久卡死：LLM 稳定产出超限补丁 → 整体拒 → 水位不动 →
// 调度器每 60s 真调一次 LLM 再被拒（确定性失败烧钱死循环，群 g-741883823 的
// character.md 曾涨到 4060/4096）。新策略按文件独立判定：
// - character 超限：仅拒绝该文件（保持旧文）——人格被程序截断会不伦不类，宁可不改，
//   但不再连坐 memory；
// - memory 超限：程序化裁剪——按行拆分，从最旧的非锁定行开始删除（锁定行永不删；
//   行序即时间序，头部最旧），删至 ≤ personaMaxBytes 再落盘；删光非锁定行仍超限
//   （剩余全为锁定行的极端）才拒绝落盘——宁拒不丢用户钦定记忆。
export function applyPersonaPatch(sessionKey, patch) {
  return runSerialized(() => applyPatchOne(sessionKey, patch));
}

// memory 兜底裁剪（纯函数）：超限时从最旧非锁定行删起，返回 { text, removed }；
// 只剩锁定行仍超限返回 null（调用方据此拒绝落盘）。
function trimMemoryToLimit(content, maxBytes) {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return { text: content, removed: 0 };
  const lines = content.split('\n');
  let removed = 0;
  while (Buffer.byteLength(lines.join('\n'), 'utf8') > maxBytes) {
    // 从头部（最旧）找第一个非锁定行删除；空行同样非锁定、可删（也省字节）
    const oldest = lines.findIndex((line) => !isLockedLine(line));
    if (oldest === -1) return null; // 余行全锁定：无可再删
    lines.splice(oldest, 1);
    removed += 1;
  }
  return { text: lines.join('\n'), removed };
}

async function applyPatchOne(sessionKey, patch) {
  const result = { character: false, memory: false };
  // 只认字符串字段；一个都没有则无事可做（双 false，与旧 false 语义一致）
  const charContent = patch && typeof patch.character === 'string' ? patch.character : null;
  const memContent = patch && typeof patch.memory === 'string' ? patch.memory : null;
  if (charContent === null && memContent === null) return result;

  // 逐文件决定落盘内容（先算后写）：任一文件的拒绝/裁剪不影响另一文件
  const notes = []; // 审计括注：如实反映「实际落盘情况」
  const writes = []; // [文件名, 落盘内容]
  if (charContent !== null) {
    const size = Buffer.byteLength(charContent, 'utf8');
    if (size > config.personaMaxBytes) {
      logger.warn(`人设补丁 character 超限拒绝(${sessionKey}): ${size} > ${config.personaMaxBytes} 字节，保持旧文件`);
      notes.push('character 超限拒绝');
    } else {
      writes.push(['character.md', charContent]);
    }
  }
  if (memContent !== null) {
    const trimmed = trimMemoryToLimit(memContent, config.personaMaxBytes);
    if (trimmed === null) {
      const size = Buffer.byteLength(memContent, 'utf8');
      logger.warn(`人设补丁 memory 裁剪后仍超限拒绝(${sessionKey}): ${size} > ${config.personaMaxBytes} 字节且余行均锁定，保持旧文件`);
      notes.push('memory 超限拒绝');
    } else {
      if (trimmed.removed > 0) {
        logger.warn(
          `人设补丁 memory 超限(${sessionKey}): 从最旧非锁定行裁剪 ${trimmed.removed} 行至 ${Buffer.byteLength(trimmed.text, 'utf8')} 字节`
        );
        notes.push(`memory 裁剪 ${trimmed.removed} 条`);
      }
      writes.push(['memory.md', trimmed.text]);
    }
  }

  try {
    const dir = sessionDir(sessionKey);
    await mkdir(dir, { recursive: true });
    for (const [name, content] of writes) {
      await writeFile(join(dir, name), content);
      result[name === 'character.md' ? 'character' : 'memory'] = true;
    }
  } catch (err) {
    logger.warn(`人设补丁失败(${sessionKey}): ${err.message}`);
    return result; // 写入异常时，已写成功的文件照实反映
  }

  // 审计仅在有文件实际落盘时记（零落盘 = 无事发生，不产生审计行）
  if (writes.length > 0) {
    const names = writes.map(([name]) => name).join('、');
    const summary = notes.length > 0 ? `更新 ${names}（${notes.join('、')}）` : `更新 ${names}`;
    try {
      await appendAudit(sessionKey, 'persona-patch', summary);
    } catch (err) {
      logger.warn(`审计追加失败(${sessionKey}): ${err.message}`);
    }
  }
  return result;
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
