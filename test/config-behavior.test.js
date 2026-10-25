// upgrade-chat-pipeline Task 1 验证：config.json 行为开关层
// 覆盖：文件缺失/损坏回退默认、字段覆盖、部分覆盖不吞兄弟字段默认值
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 行为开关全默认快照（与 src/config.js 的 DEFAULT_BEHAVIOR 逐字段对齐）
const DEFAULT_BEHAVIOR = {
  trigger: {
    at: { enabled: true },
    nameCall: { enabled: true, aliases: ['大肥鱼', '肥鱼'] },
    replyQuote: { enabled: true },
  },
  reply: {
    delay: { enabled: true, minMs: 2000, maxMs: 8000 },
    split: { enabled: true, separator: '||' },
    quote: { enabled: true },
  },
  context: { budgetBytes: 12000 },
};

// CONFIG_PATH 在模块加载时读取：每个用例注入路径 + 唯一 query 的动态 import 拿全新模块实例
// （与 test/config.test.js 的 loadFreshConfig 同一模式）
async function loadBehaviorConfig(caseName, configPath) {
  const saved = process.env.CONFIG_PATH;
  if (configPath === undefined) delete process.env.CONFIG_PATH;
  else process.env.CONFIG_PATH = configPath;
  try {
    const mod = await import(`../src/config.js?behavior=${caseName}`);
    return mod.config.behavior;
  } finally {
    if (saved === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = saved;
  }
}

// monkey-patch console.log 捕获模块加载期的 WARN（与 test/logger.test.js 的 captureLog 同一模式）
async function loadWithLogCapture(caseName, configPath) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const behavior = await loadBehaviorConfig(caseName, configPath);
    return { behavior, lines };
  } finally {
    console.log = original;
  }
}

// 每个用例独立的临时目录：写完 config.json 统一清理
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'bff-config-'));
}

test('文件缺失：CONFIG_PATH 指向不存在的文件，行为开关全默认且不记 WARN', async () => {
  const dir = makeTempDir();
  try {
    const { behavior, lines } = await loadWithLogCapture('missing', join(dir, 'absent.json'));
    assert.deepEqual(behavior, DEFAULT_BEHAVIOR);
    // ENOENT 属正常场景（用户未创建 config.json），静默回退
    assert.equal(lines.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文件损坏：非法 JSON 记 WARN 并回退全默认', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, '{ "trigger": {', 'utf8');
    const { behavior, lines } = await loadWithLogCapture('corrupt', path);
    assert.deepEqual(behavior, DEFAULT_BEHAVIOR);
    assert.ok(
      lines.some((line) => line.includes('WARN') && line.includes('config.json')),
      `应输出含 config.json 的 WARN 日志，实际: ${JSON.stringify(lines)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('顶层非对象：合法 JSON 但结构不可作配置，同样记 WARN 回退全默认', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'array-top.json');
    writeFileSync(path, '[1, 2]', 'utf8');
    const { behavior, lines } = await loadWithLogCapture('array-top', path);
    assert.deepEqual(behavior, DEFAULT_BEHAVIOR);
    assert.ok(
      lines.some((line) => line.includes('WARN') && line.includes('config.json')),
      `顶层非对象应输出 WARN，实际: ${JSON.stringify(lines)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('字段覆盖：config.json 中 budgetBytes 覆盖默认值', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'override.json');
    writeFileSync(path, JSON.stringify({ context: { budgetBytes: 5000 } }), 'utf8');
    const behavior = await loadBehaviorConfig('override', path);
    assert.equal(behavior.context.budgetBytes, 5000);
    // 未覆盖的分组保持默认
    assert.deepEqual(behavior.trigger, DEFAULT_BEHAVIOR.trigger);
    assert.deepEqual(behavior.reply, DEFAULT_BEHAVIOR.reply);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('部分覆盖：仅写 trigger.nameCall.enabled:false，其余字段全默认', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'partial.json');
    writeFileSync(path, JSON.stringify({ trigger: { nameCall: { enabled: false } } }), 'utf8');
    const behavior = await loadBehaviorConfig('partial', path);
    assert.equal(behavior.trigger.nameCall.enabled, false);
    // 同子对象未写的 aliases 保留默认，不被吞成 undefined
    assert.deepEqual(behavior.trigger.nameCall.aliases, ['大肥鱼', '肥鱼']);
    // 同层兄弟字段保留默认
    assert.equal(behavior.trigger.replyQuote.enabled, true);
    assert.deepEqual(behavior.reply, DEFAULT_BEHAVIOR.reply);
    assert.equal(behavior.context.budgetBytes, 12000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('at 开关：仅写 trigger.at.enabled:false，@条件关而兄弟条件默认开（Task 2 等价回归的开关面）', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'at-off.json');
    writeFileSync(path, JSON.stringify({ trigger: { at: { enabled: false } } }), 'utf8');
    const behavior = await loadBehaviorConfig('at-off', path);
    assert.equal(behavior.trigger.at.enabled, false);
    // 兄弟条件开关不被吞（nameCall/replyQuote 保持默认开）
    assert.equal(behavior.trigger.nameCall.enabled, true);
    assert.equal(behavior.trigger.replyQuote.enabled, true);
    assert.deepEqual(behavior.reply, DEFAULT_BEHAVIOR.reply);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('部分子对象覆盖不吞兄弟字段：仅改 reply.split.separator，同层与其余分组保持默认', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'sibling.json');
    writeFileSync(path, JSON.stringify({ reply: { split: { separator: '##' } } }), 'utf8');
    const behavior = await loadBehaviorConfig('sibling', path);
    assert.equal(behavior.reply.split.separator, '##');
    // 被部分覆盖的子对象内未写字段保留默认
    assert.equal(behavior.reply.split.enabled, true);
    // 兄弟字段默认值不被吞掉
    assert.deepEqual(behavior.reply.delay, { enabled: true, minMs: 2000, maxMs: 8000 });
    assert.deepEqual(behavior.reply.quote, { enabled: true });
    assert.deepEqual(behavior.trigger, DEFAULT_BEHAVIOR.trigger);
    assert.deepEqual(behavior.context, { budgetBytes: 12000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
