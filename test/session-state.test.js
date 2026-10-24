// Task 4 验证（add-self-evolving-persona spec「会话状态」）：session-state——
// {DATA_DIR}/session-state/{sessionKey}.json 的读写契约：初始 {}、浅合并两键共存、
// writeChain 串行化（并发读-合-写不丢键）、损坏 JSON 兜底 {}、写失败仅 WARN 返回 false。
// 模式（同 store.test.js）：先设 env → 动态 import（config 在模块加载时求值，
// env 必须先于 store 模块 import），DATA_DIR 指向临时目录，after 清理。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_DIR = 'tmp/test-session-state';
process.env.DATA_DIR = DATA_DIR;

const { readState, updateState } = await import('../src/store/session-state.js');

const stateFile = (sessionKey) => join(DATA_DIR, 'session-state', `${sessionKey}.json`);

after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

test('初始 readState：文件不存在返回 {}', async () => {
  assert.deepEqual(await readState('g-fresh'), {});
});

test('updateState 写入与浅合并：先 resetAt 再 distillMark，两键共存且同键覆盖', async () => {
  assert.equal(await updateState('g-merge', { resetAt: 111 }), true);
  assert.deepEqual(await readState('g-merge'), { resetAt: 111 });

  // 浅合并：只带 distillMark 的 patch 不丢已有 resetAt
  assert.equal(await updateState('g-merge', { distillMark: 222 }), true);
  assert.deepEqual(await readState('g-merge'), { resetAt: 111, distillMark: 222 });

  // 同键覆盖：新值替换旧值
  assert.equal(await updateState('g-merge', { resetAt: 333 }), true);
  assert.deepEqual(await readState('g-merge'), { resetAt: 333, distillMark: 222 });
});

test('串行化：并发连续 updateState 不丢键（读-合-写按提交顺序完成）', async () => {
  const updates = [];
  for (let i = 0; i < 10; i++) {
    updates.push(updateState('g-concurrent', { resetAt: 1000 + i }));
    updates.push(updateState('g-concurrent', { distillMark: 2000 + i }));
  }
  assert.ok((await Promise.all(updates)).every((ok) => ok === true), '全部写成功');

  // 无串行化时，并发「读旧值→合并→写回」会以后写者的过期底稿覆盖先写者的键；
  // writeChain 保证最终两键均在，且各为最后一次提交值
  assert.deepEqual(await readState('g-concurrent'), { resetAt: 1009, distillMark: 2009 });
});

test('损坏 JSON：readState 返回 {}，后续 updateState 以 {} 为底重建文件', async () => {
  await mkdir(join(DATA_DIR, 'session-state'), { recursive: true });
  await writeFile(stateFile('g-corrupt'), '{ not valid json');
  assert.deepEqual(await readState('g-corrupt'), {});

  await updateState('g-corrupt', { resetAt: 42 });
  assert.deepEqual(await readState('g-corrupt'), { resetAt: 42 });
});

test('写失败：session-state 路径被普通文件占位 → updateState 返回 false 且仅 WARN 不抛', async () => {
  const blocker = join(DATA_DIR, 'session-state');
  await rm(blocker, { recursive: true, force: true }); // 移除真实目录，换成普通文件占位
  await writeFile(blocker, 'plain file blocker, not a directory');

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  let ok;
  try {
    ok = await updateState('g-blocked', { resetAt: 1 });
  } finally {
    console.log = originalLog;
  }

  assert.equal(ok, false, '写失败应返回 false');
  assert.ok(
    logs.some((line) => line.includes('WARN') && line.includes('会话状态')),
    `失败仅记 WARN：${logs.join(' | ')}`
  );

  await rm(blocker, { force: true }); // 恢复占位，交给 after 统一清理 DATA_DIR
});
