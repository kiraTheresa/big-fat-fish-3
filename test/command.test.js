// 指令触发器测试（add-self-evolving-persona spec「指令触发器」+ 注册表化重构）：
// 注册表完整性（8 指令契约字段）、/help 由注册表自动生成（防手工列表漂移回归）、
// 全指令回复等价、权限三态（私聊放行 / 群白名单内 @ 放行 / 群白名单外 @ 拒绝）、
// 群聊 @ 门控（裸发已知/未知/无权限一律静默且无副作用，match 仍宽吞 '/' 前缀）、
// ADMIN_QQ 未配置全拒、remember 落盘联动、未知指令指引、'/' 空内容静默、
// /version 读 CHANGELOG（mock CHANGELOG_PATH）与缺失兜底、readMessagesSince 直测、
// index.js 注册顺序静态断言。
// 模式（同 persona-store.test.js）：先设 env → 动态 import（config 在 import 时求值 env），
// DATA_DIR/PERSONA_DIR/USAGE_DIR 注入同一 tmp 根，after 统一清理；不依赖真实
// OneBot/LLM——mock ctx 的 reply 只收集文本，sessionKey 与 dispatcher 同规则打标。
// CHANGELOG_PATH 例外：version.js 每次调用现读 env，故测试内临时改、finally 恢复即可。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = `tmp/test-command-${process.pid}`;
const DATA_DIR = join(ROOT, 'data');
const PERSONA_DIR = join(ROOT, 'personas');
const USAGE_DIR = join(ROOT, 'usage');

process.env.DATA_DIR = DATA_DIR;
process.env.PERSONA_DIR = PERSONA_DIR;
process.env.USAGE_DIR = USAGE_DIR;
process.env.ADMIN_QQ = '9001,9002'; // 群聊管理白名单（9003 故意不在名单内）

const commandModule = await import('../src/triggers/command.js');
const command = commandModule.default;
const { COMMANDS } = commandModule; // 注册表（/help 自动生成与完整性的断言对象）
const { getVersion } = await import('../src/version.js');
const { config } = await import('../src/config.js');
const { appendUsage } = await import('../src/store/usage-store.js');
const { applyPersonaPatch } = await import('../src/store/persona-store.js');
const { readMessagesSince } = await import('../src/store/message-store.js');

after(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

// ---- mock 事件与 ctx：reply 只收集文本（不触真实发送层；落盘断言直接读各 store 文件） ----
let messageSeq = 0;
function privateEvent(raw, userId, nickname = `私聊${userId}`) {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: userId,
    self_id: 10000,
    time: 1760004000 + ++messageSeq,
    message_id: -600000 + messageSeq,
    message: [{ type: 'text', data: { text: raw } }],
    raw_message: raw,
    sender: { nickname, card: '', role: '' },
  };
}
function groupEvent(raw, groupId, userId, nickname = `群友${userId}`, atBot = false) {
  const message = [];
  if (atBot) message.push({ type: 'at', data: { qq: '10000' } });
  message.push({ type: 'text', data: { text: raw } });
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    user_id: userId,
    self_id: 10000,
    time: 1760004000 + ++messageSeq,
    message_id: -600000 + messageSeq,
    message,
    raw_message: `${atBot ? '[@bot] ' : ''}${raw}`,
    sender: { nickname, card: '', role: 'member' },
  };
}

// 直接驱动 command.handle：sessionKey 打标与 dispatcher 同规则，reply 收集为数组
async function run(event) {
  const sessionKey = event.message_type === 'group' ? `g-${event.group_id}` : `p-${event.user_id}`;
  const replies = [];
  await command.handle({ event, sessionKey, reply: (text) => { replies.push(text); } });
  return replies;
}

const personaFile = (key, name) => join(PERSONA_DIR, key, name);
const stateFile = (key) => join(DATA_DIR, 'session-state', `${key}.json`);
const msgFile = (key) => join(DATA_DIR, 'messages', `${key}.jsonl`);

test('触发规则：/ 前缀命中（@bot 的 at 段剥离后仍命中）；非 / 前缀不命中', () => {
  assert.equal(command.name, 'command');
  assert.equal(command.match(privateEvent('/help', 7001)), true);
  assert.equal(command.match(groupEvent('/status', 1001, 9001, '管理员甲', true)), true, '@bot + 指令：at 段剥离后命中');
  assert.equal(command.match(privateEvent('你好呀', 7002)), false, '非 / 前缀不命中');
  assert.equal(command.match(groupEvent('今天吃啥', 1002, 9002)), false);
});

test("'/' 单独一个字符：match 按前缀规则命中，但指令词为空 → 静默零回复", async () => {
  const event = groupEvent('/', 1101, 9001, '只戳君', true);
  assert.equal(command.match(event), true, 'spec 规则：以 / 开头即命中（命中即停，不落入 chat）');
  const replies = await run(event);
  assert.equal(replies.length, 0, '指令词为空：选择静默忽略（@bot 空指令不回未知指引，避免骚扰）');
});

test('群聊 @ 门控：裸发指令（未 @）一律静默——已知/未知/无权限零回复、零副作用', async () => {
  // 管理员裸发已知管理指令：不执行不回确认（寻址未明确，宁可漏响应不乱响应）
  const adminBare = await run(groupEvent('/reset', 1201, 9001, '管理员甲'));
  assert.equal(adminBare.length, 0, '管理员裸发 /reset 不得执行');
  await assert.rejects(readFile(stateFile('g-1201')), (err) => err.code === 'ENOENT', '未 @ 不得落盘 resetAt');

  // 白名单外裸发管理指令：不回权限错误（原先回「管理员可以用」的越界场景在此掐掉）
  const outsiderBare = await run(groupEvent('/reset', 1202, 9003, '路人乙'));
  assert.equal(outsiderBare.length, 0, '未 @ 的无权限指令静默');

  // 未知指令裸发：不回「不认识」指引（闲聊带 / 文本不再被骚扰式回应）
  const unknownBare = await run(groupEvent('/飞起来', 1203, 9001, '管理员甲'));
  assert.equal(unknownBare.length, 0, '未 @ 的未知指令静默');

  // 对照：@ 本鱼后管理员同指令正常执行（寻址明确才回应——门控放行后的既有路径）
  const atOk = await run(groupEvent('/reset', 1204, 9001, '管理员甲', true));
  assert.equal(atOk.length, 1, '@ 本鱼后指令正常执行');
  await assert.doesNotReject(readFile(stateFile('g-1204')), '@ 后 resetAt 正常落盘');
});

test('群聊 @ 门控：match 仍宽吞 \'/\' 前缀（未 @ 也命中——命中即停，防裸指令误入 chat）', () => {
  assert.equal(
    command.match(groupEvent('/help', 1301, 9001, '管理员甲')),
    true,
    '未 @ 的 \'/\' 消息 match 仍命中（@ 门控在 handle 内判定）'
  );
});

test('注册表完整性：7 个旧指令 + version 共 8 个，name 唯一、summary 非空、契约字段齐全', () => {
  assert.equal(COMMANDS.length, 8, '7 旧 + 1 新（version）');
  const names = COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, 8, 'name 不得重复（主流程按 name 精确匹配查表）');
  // 旧 7 个一个不少 + 新增 version：防迁移时静默丢指令
  for (const name of ['help', 'status', 'persona', 'memory', 'remember', 'reset', 'history', 'version']) {
    assert.ok(names.includes(name), `注册表应含 /${name}`);
  }
  for (const cmd of COMMANDS) {
    assert.equal(typeof cmd.adminOnly, 'boolean', `/${cmd.name} adminOnly 应为布尔（权限集中判定靠它）`);
    assert.equal(typeof cmd.handle, 'function', `/${cmd.name} handle 应为函数`);
    assert.ok(typeof cmd.summary === 'string' && cmd.summary.trim() !== '', `/${cmd.name} summary 非空（/help 自动生成靠它）`);
  }
});

test('/help：由注册表自动生成，逐行与注册表一致（防手工列表漂移回归）', async () => {
  const replies = await run(privateEvent('/help', 7101));
  assert.equal(replies.length, 1);
  const lines = replies[0].split('\n');
  assert.equal(lines[0], '本鱼会的指令：', '沿用现有开头文案');
  assert.equal(lines.length, COMMANDS.length + 1, '表头一行 + 每个注册表指令一行');
  // 逐行比对注册表（顺序即注册表顺序）：自动生成后 /help 条目与注册表严格一致，
  // 注册表增删指令而 /help 忘改时此处立刻报警（漂移回归）
  for (let i = 0; i < COMMANDS.length; i++) {
    const cmd = COMMANDS[i];
    const expected = `/${cmd.name} - ${cmd.summary}${cmd.adminOnly ? '（管理员）' : ''}`;
    assert.equal(lines[i + 1], expected, `/help 第 ${i + 1} 行应与注册表条目一致`);
  }
  assert.ok(replies[0].includes('管理员'), 'adminOnly 指令应有权限标注');
});

test('/persona：回复 character.md 全文（含种子标题「大肥鱼」）', async () => {
  const replies = await run(privateEvent('/persona', 7201));
  assert.equal(replies.length, 1);
  assert.ok(replies[0].includes('# 大肥鱼'), '含种子标题');
  assert.ok(replies[0].includes('吉祥物鱼'), '含种子正文');
});

test('/remember：原话即时落盘 memory.md（- [日期 昵称: 内容 行格式）并回复确认', async () => {
  const replies = await run(privateEvent('/remember 我周四打羽毛球', 7301, '阿鱼'));
  assert.equal(replies.length, 1);
  assert.ok(replies[0].includes('记住'), '回复应为简短确认');
  const mem = await readFile(personaFile('p-7301', 'memory.md'), 'utf8');
  assert.match(mem, /^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 阿鱼: 我周四打羽毛球\n$/, 'spec 行格式：- [YYYY-MM-DD HH:mm] 昵称: 内容');
});

test('/remember 无内容：回复用法提示，不落盘', async () => {
  const replies = await run(privateEvent('/remember', 7302));
  assert.equal(replies.length, 1);
  assert.ok(replies[0].includes('/remember'), '应提示 /remember 用法');
  await assert.rejects(readFile(personaFile('p-7302', 'memory.md')), (err) => err.code === 'ENOENT', '无内容不得产生记忆文件');
});

test('/memory：空记忆提示暂无；写入后可查到内容', async () => {
  const empty = await run(privateEvent('/memory', 7401));
  assert.equal(empty.length, 1);
  assert.ok(empty[0].includes('还没有'), '空记忆应提示暂无');

  await run(privateEvent('/remember 周四打羽毛球', 7402, '阿鱼'));
  const withMem = await run(privateEvent('/memory', 7402));
  assert.ok(withMem[0].includes('周四打羽毛球'), '应能查到刚记住的内容');
  assert.match(withMem[0], /- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/, '保留 memory.md 原行格式');
});

test('/status：人设/记忆字节数 + 用量汇总数字 + 待提炼条数 + resetAt 未生效标注', async () => {
  const key = 'p-7501';
  // 种下数据：3 次用量（每次 total 120 / 缓存命中 30）+ 2 条消息（distillMark 未置 → 全量计）
  for (let i = 0; i < 3; i++) {
    await appendUsage(key, { time: 1760004000 + i, kind: 'chat', model: 'deepseek-chat', prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 30 });
  }
  await mkdir(join(DATA_DIR, 'messages'), { recursive: true });
  await writeFile(msgFile(key), [
    JSON.stringify({ sessionKey: key, time: 1760004101, raw_message: '早' }),
    JSON.stringify({ sessionKey: key, time: 1760004102, raw_message: '晚' }),
  ].join('\n') + '\n', 'utf8');

  const replies = await run(privateEvent('/status', 7501));
  assert.equal(replies.length, 1);
  const text = replies[0];
  assert.match(text, /人设 \d+ 字节/, '应含人设字节数');
  assert.match(text, /记忆 \d+ 字节/, '应含记忆字节数');
  assert.ok(text.includes('3 次调用'), '应含调用次数');
  assert.ok(text.includes('共 360 tokens'), '应含总 tokens（3 × 120）');
  assert.ok(text.includes('缓存命中 90'), '应含缓存命中 tokens（3 × 30）');
  assert.ok(text.includes('待提炼消息 2 条'), '应含未提炼条数（distillMark 未置 → 全量统计）');
  assert.ok(text.includes('上下文未重置'), 'resetAt 未生效时的展示');
});

test('/reset 权限三态：私聊放行并落盘 resetAt；群白名单内放行；群白名单外拒绝且无副作用', async () => {
  // 私聊：放行 → session-state 落盘 resetAt（秒级，与消息 JSONL time 同量纲）
  const priv = await run(privateEvent('/reset', 7601));
  assert.equal(priv.length, 1);
  assert.ok(priv[0].includes('清空'), '放行应回复确认');
  const privState = JSON.parse(await readFile(stateFile('p-7601'), 'utf8'));
  assert.ok(Number.isInteger(privState.resetAt), 'resetAt 已落盘');
  const nowSec = Math.floor(Date.now() / 1000);
  assert.ok(
    Math.abs(privState.resetAt - nowSec) <= 60,
    'resetAt 应为秒级时间戳（误存毫秒会把 reset 后全部历史恒滤掉）'
  );
  // /status 展示已重置会话：秒级 → ×1000 换算后格式化为本年份（防 1970 回归）
  const status = await run(privateEvent('/status', 7601));
  assert.ok(
    status[0].includes(`上下文重置于 ${new Date().getFullYear()}-`),
    '已重置会话的 /status 应展示本年份的可读时间（秒级换算毫秒后格式化）'
  );

  // 群聊白名单内（9001 ∈ ADMIN_QQ，@ 本鱼）：放行并落盘
  const grp = await run(groupEvent('/reset', 2001, 9001, '管理员甲', true));
  assert.equal(grp.length, 1);
  assert.ok(!grp[0].includes('管理员可以用'), '白名单内不得回无权限提示');
  const grpState = JSON.parse(await readFile(stateFile('g-2001'), 'utf8'));
  assert.ok(Number.isInteger(grpState.resetAt), '群聊白名单内 resetAt 已落盘');

  // 群聊白名单外（9003 ∉，@ 本鱼）：拒绝 → 提示且无任何副作用
  const denied = await run(groupEvent('/reset', 2002, 9003, '路人乙', true));
  assert.equal(denied.length, 1);
  assert.ok(denied[0].includes('管理员'), '应回无权限提示');
  await assert.rejects(readFile(stateFile('g-2002')), (err) => err.code === 'ENOENT', '拒绝时不得落盘任何状态');
});

test('/reset 权限：ADMIN_QQ 未配置（adminQq=[]）时群聊管理指令一律拒绝', async () => {
  const saved = config.adminQq;
  config.adminQq = []; // 临时改写（沿袭 chat.test.js 的 config 变更法），用毕恢复
  try {
    const denied = await run(groupEvent('/reset', 2101, 9001, '管理员甲', true)); // 白名单里的常客也一律拒绝
    assert.equal(denied.length, 1);
    assert.ok(denied[0].includes('管理员'), '未配置白名单：群聊管理指令一律拒绝');
    await assert.rejects(readFile(stateFile('g-2101')), (err) => err.code === 'ENOENT', '拒绝不得有副作用');
  } finally {
    config.adminQq = saved;
  }
});

test('/persona reset（管理）：私聊放行恢复种子人设并审计；群白名单外拒绝', async () => {
  // 先把人设改坏 + 留下临时记忆，验证 reset 的恢复力
  await applyPersonaPatch('p-7701', { character: '# 被改坏的人设', memory: '- [2026-10-25 10:00] 甲: 临时记忆' });
  const replies = await run(privateEvent('/persona reset', 7701));
  assert.equal(replies.length, 1);
  assert.ok(replies[0].includes('大肥鱼'), '恢复确认文案');
  const character = await readFile(personaFile('p-7701', 'character.md'), 'utf8');
  assert.ok(character.startsWith('# 大肥鱼'), 'character.md 恢复种子');
  assert.equal(await readFile(personaFile('p-7701', 'memory.md'), 'utf8'), '', 'memory.md 清空');
  const hist = await readFile(personaFile('p-7701', 'history.jsonl'), 'utf8');
  assert.ok(hist.includes('persona-reset'), 'reset 应记审计');

  // 群白名单外拒绝（@ 本鱼：寻址明确，权限判定照常）
  const denied = await run(groupEvent('/persona reset', 2201, 9003, '路人乙', true));
  assert.equal(denied.length, 1);
  assert.ok(denied[0].includes('管理员'), '群白名单外 /persona reset 应拒绝');
});

test('/history（管理）：空审计提示；有记录时每条一行（时间 + kind + summary）', async () => {
  const empty = await run(privateEvent('/history', 7801));
  assert.equal(empty.length, 1);
  assert.ok(empty[0].includes('审计'), '空审计应提示');

  // /remember 会追加 memory-append 审计
  await run(privateEvent('/remember 审计样本', 7802, '甲'));
  const withRec = await run(privateEvent('/history', 7802));
  assert.equal(withRec.length, 1);
  assert.ok(withRec[0].includes('memory-append'), '应含 kind');
  assert.ok(withRec[0].includes('审计样本'), '应含 summary');
  assert.match(withRec[0], /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/, '每条含格式化时间');
});

test('/history 权限（adminOnly）：群白名单外拒绝回无权限提示（私聊放行见上）', async () => {
  const denied = await run(groupEvent('/history', 2301, 9003, '路人乙', true));
  assert.equal(denied.length, 1);
  assert.ok(denied[0].includes('管理员'), '群白名单外 /history 应拒绝');
});

test('/version：读 CHANGELOG 顶部版本；文件缺失显示 unknown（安静兜底）', async () => {
  const saved = process.env.CHANGELOG_PATH;
  try {
    // 正常路径：mock CHANGELOG_PATH 指向临时 CHANGELOG（version.js 每次现读 env，改完即生效）
    const changelog = join(ROOT, 'CHANGELOG.md');
    await writeFile(changelog, [
      '# Changelog',
      '',
      '## [9.9.9] - 2026-10-25',
      '',
      '### feat',
      '',
      '- 测试用条目',
      '',
      '## [0.1.0] - 2026-01-01',
      '',
    ].join('\n'), 'utf8');
    process.env.CHANGELOG_PATH = changelog;
    const replies = await run(privateEvent('/version', 7961));
    assert.equal(replies.length, 1);
    assert.equal(replies[0], '本鱼版本：9.9.9', '取顶部第一个 [x.y.z] 标题');

    // 文件缺失：getVersion 安静兜底返回 unknown，指令照常回复不抛不吵
    process.env.CHANGELOG_PATH = join(ROOT, 'CHANGELOG-not-exists.md');
    const missing = await run(privateEvent('/version', 7962));
    assert.equal(missing.length, 1);
    assert.equal(missing[0], '本鱼版本：unknown', '文件缺失兜底 unknown');
  } finally {
    // env 写回 undefined 会变成字符串 'undefined'，原值不存在时须 delete
    if (saved === undefined) delete process.env.CHANGELOG_PATH;
    else process.env.CHANGELOG_PATH = saved;
  }
});

test('getVersion 直测：多版本标题取首个；行首锚定不误匹配正文版本号；无标题回 unknown', async () => {
  const saved = process.env.CHANGELOG_PATH;
  try {
    const multi = join(ROOT, 'changelog-multi.md');
    await writeFile(multi, '# Changelog\n\n## [1.2.3] - 2026-05-01\n\n正文里提到 [0.9.0] 不算标题\n\n## [0.9.0] - 2026-04-01\n', 'utf8');
    process.env.CHANGELOG_PATH = multi;
    assert.equal(await getVersion(), '1.2.3', '自上而下第一个版本标题即当前版本（CHANGELOG 由新到旧）');

    const noVersion = join(ROOT, 'changelog-noversion.md');
    await writeFile(noVersion, '# 没有版本标题的更新日志\n', 'utf8');
    process.env.CHANGELOG_PATH = noVersion;
    assert.equal(await getVersion(), 'unknown', '无匹配标题兜底');
  } finally {
    if (saved === undefined) delete process.env.CHANGELOG_PATH;
    else process.env.CHANGELOG_PATH = saved;
  }
});

test('未知指令：回复简短指引（提示 /help）', async () => {
  const replies = await run(privateEvent('/飞起来', 7901));
  assert.equal(replies.length, 1);
  assert.ok(replies[0].includes('/help'), '指引应提示 /help');
});

test('readMessagesSince 直测：time 水位过滤（严格大于）、limit 截尾、损坏行跳过、ENOENT 返回 []', async () => {
  const key = 'g-msgsince';
  await mkdir(join(DATA_DIR, 'messages'), { recursive: true });
  await writeFile(msgFile(key), [
    JSON.stringify({ sessionKey: key, time: 100, raw_message: 'a' }),
    'not-json', // 损坏行：跳过不炸整体
    JSON.stringify({ sessionKey: key, time: 200, raw_message: 'b' }),
    JSON.stringify({ sessionKey: key, time: 300, raw_message: 'c' }),
    JSON.stringify({ sessionKey: key, time: 400, raw_message: 'd' }),
  ].join('\n') + '\n', 'utf8');

  assert.deepEqual((await readMessagesSince(key, 200, 10)).map((r) => r.time), [300, 400], '严格大于水位且升序');
  assert.deepEqual((await readMessagesSince(key, 0, 2)).map((r) => r.time), [300, 400], '命中超 limit 时保留尾部最新 limit 条');
  assert.deepEqual(await readMessagesSince('g-never-exists', 0, 10), [], '文件不存在返回 []');
});

test('index.js 注册顺序静态断言：register 顺序 ping → command → chat', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const names = [...source.matchAll(/register\((\w+)\)/g)].map((m) => m[1]);
  assert.ok(
    names.includes('ping') && names.includes('command') && names.includes('chat'),
    `应同时注册 ping/command/chat，实际：${names.join(' → ')}`
  );
  assert.ok(names.indexOf('ping') < names.indexOf('command'), 'ping 先于 command（ping 恒优先）');
  assert.ok(names.indexOf('command') < names.indexOf('chat'), 'command 先于 chat（命中即停：指令消息不得落入 LLM）');
});
