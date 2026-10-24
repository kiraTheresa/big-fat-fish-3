// Task 3 验证（add-self-evolving-persona spec「人设存储」）：种子落盘、append 行格式
// 与审计、超限环形淘汰、patch 成功/超限整体拒绝、reset、readHistory 截取、容错
// （history.jsonl ENOENT、会话目录被普通文件占据时不抛仅 WARN）。
// 模式（同 store.test.js）：先设 env → 动态 import（config 在 import 时求值 env）；
// PERSONA_DIR 注入 tmp 临时目录，PERSONA_MAX_BYTES 调小到 200 让淘汰/拒绝在少量
// 数据下即可触发；各用例独立 sessionKey 互不干扰，after 统一清理。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PERSONA_DIR = 'tmp/test-persona';
process.env.PERSONA_DIR = PERSONA_DIR;
process.env.PERSONA_MAX_BYTES = '200';

const personaStore = await import('../src/store/persona-store.js');

// 独立预言：种子全文（与 spec 附录一字不差；引号是半角直引号）
const SEED = [
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

const file = (key, name) => join(PERSONA_DIR, key, name);

after(async () => {
  await rm(PERSONA_DIR, { recursive: true, force: true });
});

test('种子生成：首次 getPersona 落盘并返回种子，二次调用不重复落盘', async () => {
  const key = 'g-seed';
  const first = await personaStore.getPersona(key);
  assert.equal(first.character, SEED);
  assert.equal(first.memory, '');
  assert.equal(await readFile(file(key, 'character.md'), 'utf8'), SEED, 'character.md 落种子');
  assert.equal(await readFile(file(key, 'memory.md'), 'utf8'), '', 'memory.md 初始为空文件');
  await assert.rejects(readFile(file(key, 'history.jsonl')), (err) => err.code === 'ENOENT', '落种子本身不产生审计');

  const second = await personaStore.getPersona(key);
  assert.deepEqual(second, { character: SEED, memory: '' });
  assert.equal(await readFile(file(key, 'character.md'), 'utf8'), SEED, '二次调用文件内容不变');

  // 一字不差核对：落盘种子与 spec 附录围栏内容逐字节相等
  const specText = await readFile(new URL('../.trae/specs/add-self-evolving-persona/spec.md', import.meta.url), 'utf8');
  const fence = specText.match(/```markdown\n([\s\S]*?)\n```/);
  assert.ok(fence, 'spec 附录种子围栏应存在');
  assert.equal(first.character, fence[1], '种子应与 spec 附录一字不差');
});

test('appendMemory：行格式 `- [YYYY-MM-DD HH:mm] 昵称: 内容`，追加 memory-append 审计', async () => {
  const key = 'g-append';
  assert.equal(await personaStore.appendMemory(key, '阿鱼', '我周四打羽毛球'), true);
  const mem = await readFile(file(key, 'memory.md'), 'utf8');
  assert.match(mem, /^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 阿鱼: 我周四打羽毛球\n$/, '本地时区时间戳行格式');
  const hist = await personaStore.readHistory(key, 10);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].kind, 'memory-append');
  assert.equal(hist[0].summary, '阿鱼: 我周四打羽毛球');
  assert.ok(Number.isInteger(hist[0].time), '审计 time 为毫秒时间戳');
});

test('appendMemory 审计摘要超 50 字截断为前 50 字', async () => {
  const key = 'g-truncate';
  const longText = '长'.repeat(47); // 「阿鱼: 」4 字 + 47 字 = 51 字，应截为前 50 字
  assert.equal(await personaStore.appendMemory(key, '阿鱼', longText), true);
  const hist = await personaStore.readHistory(key, 10);
  assert.equal(hist[0].summary.length, 50);
  assert.equal(hist[0].summary, `阿鱼: ${longText}`.slice(0, 50));
});

test('超限环形淘汰：追加多条后总量不超限，最旧被删、最新保留，审计不淘汰', async () => {
  const key = 'g-evict';
  const texts = ['第一条记忆', '第二条记忆', '第三条记忆', '第四条记忆', '第五条记忆', '第六条记忆', '第七条记忆'];
  for (const text of texts) {
    assert.equal(await personaStore.appendMemory(key, '阿鱼', text), true);
  }
  const mem = await readFile(file(key, 'memory.md'), 'utf8');
  const size = Buffer.byteLength(mem, 'utf8');
  assert.ok(size <= 200, `淘汰后不超限（实际 ${size} 字节）`);
  const lines = mem.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 4, '每行约 45 字节，200 上限下恰好保留 4 条');
  assert.ok(!mem.includes('第一条'), '最旧条目被环形淘汰');
  assert.ok(lines[lines.length - 1].includes('第七条'), '最新条目保留且在尾部');
  // 审计 append-only，不随记忆淘汰
  const hist = await personaStore.readHistory(key, 100);
  assert.equal(hist.filter((r) => r.kind === 'memory-append').length, texts.length);
});

test('applyPersonaPatch 成功：整文件替换 + persona-patch 审计简述', async () => {
  const key = 'g-patch';
  await personaStore.getPersona(key); // 先落种子，验证 patch 是替换而非追加
  const character = '# 新人设\n\n变机灵了一点。';
  const memory = '- [2026-10-25 21:30] 阿鱼: 记住了';
  assert.equal(await personaStore.applyPersonaPatch(key, { character, memory }), true);
  assert.equal(await readFile(file(key, 'character.md'), 'utf8'), character, 'character.md 整文件替换');
  assert.equal(await readFile(file(key, 'memory.md'), 'utf8'), memory, 'memory.md 整文件替换');
  const hist = await personaStore.readHistory(key, 10);
  const last = hist[hist.length - 1];
  assert.equal(last.kind, 'persona-patch');
  assert.ok(
    last.summary.includes('character.md') && last.summary.includes('memory.md'),
    `审计应简述改了哪些文件：${last.summary}`
  );
});

test('applyPersonaPatch 超限整体拒绝：WARN、不落盘、返回 false、无审计', async () => {
  const key = 'g-patch-reject';
  await personaStore.getPersona(key); // 落种子作为「不变」基线
  const beforeChar = await readFile(file(key, 'character.md'), 'utf8');
  const beforeMem = await readFile(file(key, 'memory.md'), 'utf8');
  const beforeHist = await personaStore.readHistory(key, 100);

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  let ok;
  try {
    // memory 超限（450 字节 > 200），character 本身不超限 → 验证「整体拒绝」连不超限字段也不落盘
    ok = await personaStore.applyPersonaPatch(key, { character: '# 小改', memory: '喵'.repeat(150) });
  } finally {
    console.log = originalLog;
  }
  assert.equal(ok, false);
  assert.ok(logs.some((l) => l.includes('WARN') && l.includes('超限')), `超限应 WARN：${logs.join(' | ')}`);
  assert.equal(await readFile(file(key, 'character.md'), 'utf8'), beforeChar, '整体拒绝：character.md 不变');
  assert.equal(await readFile(file(key, 'memory.md'), 'utf8'), beforeMem, '整体拒绝：memory.md 不变');
  assert.equal((await personaStore.readHistory(key, 100)).length, beforeHist.length, '拒绝不产生审计');
});

test('resetPersona：恢复种子、清空记忆、审计 persona-reset', async () => {
  const key = 'g-reset';
  await personaStore.getPersona(key);
  await personaStore.appendMemory(key, '阿鱼', '临时代码记忆');
  assert.equal(await personaStore.applyPersonaPatch(key, { character: '# 被改坏的人设' }), true);
  assert.equal(await personaStore.resetPersona(key), true);
  assert.equal(await readFile(file(key, 'character.md'), 'utf8'), SEED, 'character.md 恢复种子');
  assert.equal(await readFile(file(key, 'memory.md'), 'utf8'), '', 'memory.md 清空');
  const hist = await personaStore.readHistory(key, 10);
  const last = hist[hist.length - 1];
  assert.equal(last.kind, 'persona-reset');
  assert.equal(last.summary, '恢复种子人设');
});

test('readHistory：尾部 limit 条截取；文件不存在返回 []', async () => {
  const key = 'g-history';
  for (let i = 0; i < 3; i++) {
    assert.equal(await personaStore.appendMemory(key, '阿鱼', `事实${'一二三'[i]}`), true);
  }
  const all = await personaStore.readHistory(key, 10);
  assert.equal(all.length, 3);
  const tail = await personaStore.readHistory(key, 2);
  assert.deepEqual(tail, all.slice(-2), '截取尾部 2 条');
  assert.deepEqual(await personaStore.readHistory('g-never-exists', 5), [], 'history.jsonl 不存在返回 []');
});

test('读写容错：会话目录被普通文件占据时 getPersona 不抛，WARN 兜底返回种子', async () => {
  const key = 'g-blocker';
  await mkdir(PERSONA_DIR, { recursive: true });
  await writeFile(join(PERSONA_DIR, key), '占位普通文件'); // 会话目录位置被普通文件占据
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  let persona;
  try {
    persona = await personaStore.getPersona(key);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(persona, { character: SEED, memory: '' }, '读取失败应兜底返回种子，不抛');
  assert.ok(logs.some((l) => l.includes('WARN') && l.includes('人设读取失败')), `失败应仅 WARN：${logs.join(' | ')}`);
  assert.ok(!logs.some((l) => l.includes('ERROR')), '失败不得升级为 ERROR');
});
