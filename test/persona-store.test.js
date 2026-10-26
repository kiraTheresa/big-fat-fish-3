// Task 3 验证（add-self-evolving-persona spec「人设存储」）：种子落盘、append 行格式
// 与审计、超限环形淘汰、patch 成功/分文件超限判定与 memory 兜底裁剪、reset、
// readHistory 截取、容错（history.jsonl ENOENT、会话目录被普通文件占据时不抛仅 WARN）。
// 提炼器三件套改造适配：applyPersonaPatch 返回 { character, memory }（各文件是否
// 落盘）——character 超限仅拒该文件、memory 超限从最旧非锁定行裁剪（锁定行永不删）、
// 全锁定仍超限才拒绝；锁定行函数（isLockedLine/extractLockedLines/
// patchKeepsLockedLines）自 distiller 搬家至此（分层单向 distiller → store）。
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

  // 上面的独立 SEED 常量就是可随仓库交付的断言依据，不依赖被忽略的 IDE 文件。

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

test('appendCharacter：钦定行追加种子尾部（空行分隔、种子原样保留）+ character-append 审计', async () => {
  const key = 'g-char-append';
  assert.equal(await personaStore.appendCharacter(key, '说话要傲娇一点'), true);
  const char = await readFile(file(key, 'character.md'), 'utf8');
  // 钦定行格式：- [YYYY-MM-DD HH:mm] 内容（无昵称前缀——性格是 Bot 自身属性非用户事实）
  assert.match(char, /\n\n- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 说话要傲娇一点\n$/, '空行分隔 + 尾部钦定行');
  assert.ok(char.startsWith('# 大肥鱼'), '种子标题保留');
  assert.ok(char.includes('- 不会的就承认不会，不装懂'), '种子末行保留（段落空行不粘连）');
  // getPersona 可读回（聊天注入与 /persona 查看的可见性）
  const persona = await personaStore.getPersona(key);
  assert.ok(persona.character.includes('说话要傲娇一点'), '读取方可见到钦定行');
  const hist = await personaStore.readHistory(key, 10);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].kind, 'character-append');
  assert.equal(hist[0].summary, '说话要傲娇一点');
  assert.ok(Number.isInteger(hist[0].time), '审计 time 为毫秒时间戳');
});

test('appendCharacter 连续追加：钦定行区块紧凑排列（不重复插空行）', async () => {
  const key = 'g-char-cont';
  // 种子本身 > 200 上限（追加第二条会触发环形淘汰删掉第一条），先 patch 成小底稿
  await personaStore.applyPersonaPatch(key, { character: '# 小鱼' });
  assert.equal(await personaStore.appendCharacter(key, '第一条性格'), true);
  assert.equal(await personaStore.appendCharacter(key, '第二条性格'), true);
  const lines = (await readFile(file(key, 'character.md'), 'utf8')).split('\n');
  const locked = lines.filter((l) => l.startsWith('- ['));
  assert.equal(locked.length, 2, '两条钦定行');
  // 连续钦定行相邻无空行（尾部已是钦定行则直接续行）
  assert.equal(lines.indexOf(locked[1]) - lines.indexOf(locked[0]), 1, '连续钦定行间无空行');
});

test('appendCharacter 超限环形淘汰：最旧钦定行被删、散文底稿永不删、最新钦定行保留', async () => {
  const key = 'g-char-evict';
  // 种子本身 ~460 字节 > 200 上限：先 patch 成小底稿，钦定行淘汰才能在可控数据下触发
  await personaStore.applyPersonaPatch(key, { character: '# 小鱼\n\n爱睡觉。' });
  for (const t of ['性格一', '性格二', '性格三', '性格四', '性格五', '性格六', '性格七']) {
    assert.equal(await personaStore.appendCharacter(key, t), true);
  }
  const char = await readFile(file(key, 'character.md'), 'utf8');
  assert.ok(char.includes('爱睡觉'), '散文底稿行永不淘汰（环形只删钦定行）');
  assert.ok(!char.includes('性格一') && !char.includes('性格二'), '最旧钦定行被环形淘汰');
  assert.ok(char.includes('性格七'), '最新钦定行保留');
  assert.ok(Buffer.byteLength(char, 'utf8') <= 200, `淘汰后不超限（实际 ${Buffer.byteLength(char, 'utf8')} 字节）`);
  // 审计 append-only，不随钦定行淘汰
  const hist = await personaStore.readHistory(key, 100);
  assert.equal(hist.filter((r) => r.kind === 'character-append').length, 7);
});

test('applyPersonaPatch 成功：整文件替换 + persona-patch 审计简述', async () => {
  const key = 'g-patch';
  await personaStore.getPersona(key); // 先落种子，验证 patch 是替换而非追加
  const character = '# 新人设\n\n变机灵了一点。';
  const memory = '- [2026-10-25 21:30] 阿鱼: 记住了';
  // 新返回值形状（提炼器三件套改造）：{ character, memory } 各文件是否落盘
  assert.deepEqual(await personaStore.applyPersonaPatch(key, { character, memory }), { character: true, memory: true });
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

test('applyPersonaPatch 分文件：character 超限仅拒该文件，memory 照常落盘（不再连坐）', async () => {
  const key = 'g-patch-char-reject';
  await personaStore.getPersona(key); // 落种子作为 character「不变」基线
  const beforeChar = await readFile(file(key, 'character.md'), 'utf8');
  const beforeHistCount = (await personaStore.readHistory(key, 100)).length;

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  let result;
  try {
    // character 超限（~460 字节 > 200），memory 合规：旧「整体拒绝」会连坐 memory，
    // 新策略分文件——memory 照常落盘（否则水位卡死 → 调度器重试烧钱死循环）
    result = await personaStore.applyPersonaPatch(key, {
      character: '# 小改\n' + '长'.repeat(150),
      memory: '- [2026-10-25 21:30] 阿鱼: 记住了',
    });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(result, { character: false, memory: true }, '各文件独立判定：仅 character 被拒');
  assert.ok(logs.some((l) => l.includes('WARN') && l.includes('character 超限拒绝')), `超限应 WARN：${logs.join(' | ')}`);
  assert.equal(await readFile(file(key, 'character.md'), 'utf8'), beforeChar, 'character 超限：保持旧文件');
  assert.equal(
    await readFile(file(key, 'memory.md'), 'utf8'),
    '- [2026-10-25 21:30] 阿鱼: 记住了',
    'memory 不被连坐，正常落盘'
  );
  const hist = await personaStore.readHistory(key, 100);
  assert.equal(hist.length, beforeHistCount + 1, 'memory 落盘产生审计');
  const last = hist[hist.length - 1];
  assert.equal(last.kind, 'persona-patch');
  assert.ok(
    last.summary.includes('更新 memory.md') && last.summary.includes('character 超限拒绝'),
    `审计应如实反映实际落盘情况：${last.summary}`
  );
});

test('applyPersonaPatch memory 超限：兜底裁剪删最旧非锁定行、锁定行全保留；全锁定极端拒绝', async () => {
  const key = 'g-patch-mem-trim';
  await personaStore.getPersona(key); // 落种子：memory.md 为空

  // 补丁 memory：最旧非锁定行（头部）+ 锁定行 + 较新非锁定行，总量 > 200
  const oldLine = '- ' + '旧'.repeat(60); // 182 字节（单行即接近上限）
  const locked = '- [2026-10-25 21:30] 阿鱼: 锁定记忆';
  const freshLine = '- 新条目';
  const result = await personaStore.applyPersonaPatch(key, {
    character: '# 小改',
    memory: [oldLine, locked, freshLine].join('\n'),
  });
  assert.deepEqual(result, { character: true, memory: true }, '裁剪至合规后落盘：两文件都成功');
  const mem = await readFile(file(key, 'memory.md'), 'utf8');
  assert.ok(!mem.includes('旧'), '最旧非锁定行被裁剪');
  assert.ok(mem.includes(locked), '锁定行（/remember 钦定）永不删');
  assert.ok(mem.includes(freshLine), '较新非锁定行保留');
  assert.ok(Buffer.byteLength(mem, 'utf8') <= 200, `裁剪后实际落盘不超限（实际 ${Buffer.byteLength(mem, 'utf8')} 字节）`);
  const hist = await personaStore.readHistory(key, 100);
  const last = hist[hist.length - 1];
  assert.ok(last.summary.includes('裁剪 1 条'), `审计应记裁剪条数：${last.summary}`);

  // 极端：删光非锁定行仍超限（锁定行自身超限）→ memory 拒绝落盘、character 不受影响
  const beforeMem = await readFile(file(key, 'memory.md'), 'utf8');
  const lockedOnly = Array.from(
    { length: 6 },
    (_, i) => `- [2026-10-25 21:${String(30 + i)}] 阿鱼: 锁定记忆${i}` // 6 行 ≈ 240 字节 > 200
  ).join('\n');
  assert.ok(Buffer.byteLength(lockedOnly, 'utf8') > 200, '前置：全锁定内容确实超限');
  const result2 = await personaStore.applyPersonaPatch(key, { character: '# 再改', memory: lockedOnly });
  assert.deepEqual(result2, { character: true, memory: false }, '全锁定仍超限：memory 拒绝、character 不连坐');
  assert.equal(await readFile(file(key, 'memory.md'), 'utf8'), beforeMem, 'memory 保持旧文件');
  assert.equal(await readFile(file(key, 'character.md'), 'utf8'), '# 再改', 'character 正常落盘');
});

test('resetPersona：恢复种子、清空记忆、审计 persona-reset', async () => {
  const key = 'g-reset';
  await personaStore.getPersona(key);
  await personaStore.appendMemory(key, '阿鱼', '临时代码记忆');
  // 只提供 character：新返回值形状下 memory 未提供即未落盘（false）
  assert.deepEqual(await personaStore.applyPersonaPatch(key, { character: '# 被改坏的人设' }), { character: true, memory: false });
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
