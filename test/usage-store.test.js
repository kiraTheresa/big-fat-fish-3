// Task 4 验证（add-self-evolving-persona spec「用量观测」）：usage-store——
// {USAGE_DIR}/{sessionKey}.jsonl 的追加与汇总：落盘行格式（kind 缺省补 chat）、
// readUsageStats 逐行累计（含 distill、缺字段按 0）、文件不存在全 0、损坏行跳过、
// fire-and-forget 不 await 也安全。
// 模式（同 store.test.js）：先设 env → 动态 import（config 在模块加载时求值，
// env 必须先于 store 模块 import），USAGE_DIR 指向临时目录，after 清理。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const USAGE_DIR = 'tmp/test-usage';
process.env.USAGE_DIR = USAGE_DIR;

const { appendUsage, readUsageStats } = await import('../src/store/usage-store.js');

const usageFile = (sessionKey) => join(USAGE_DIR, `${sessionKey}.jsonl`);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(async () => {
  await rm(USAGE_DIR, { recursive: true, force: true });
});

test('appendUsage 落盘格式：一行一条 JSON，kind 缺省补 chat，字段原样保留', async () => {
  await appendUsage('g-fmt', {
    time: 1760001000, model: 'deepseek-chat',
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 4,
  });
  await appendUsage('g-fmt', { time: 1760002000, kind: 'distill', model: 'deepseek-chat', prompt_tokens: 100 });

  const lines = (await readFile(usageFile('g-fmt'), 'utf8')).split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 2, '两次 append 恰好两行');
  assert.deepEqual(JSON.parse(lines[0]), {
    time: 1760001000, kind: 'chat', model: 'deepseek-chat',
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 4,
  });
  assert.deepEqual(JSON.parse(lines[1]), { time: 1760002000, kind: 'distill', model: 'deepseek-chat', prompt_tokens: 100 });
});

test('readUsageStats 累计：多条、含 kind distill、缺字段按 0', async () => {
  await appendUsage('g-sum', { time: 1, kind: 'chat', model: 'm', prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, prompt_cache_hit_tokens: 5 });
  await appendUsage('g-sum', { time: 2, kind: 'distill', model: 'm', prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  await appendUsage('g-sum', { time: 3, model: 'm' }); // 极简记录：token 字段全缺，仍计一次调用
  assert.deepEqual(await readUsageStats('g-sum'), {
    calls: 3, promptTokens: 11, completionTokens: 22, totalTokens: 33, cacheHitTokens: 5,
  });
});

test('文件不存在：readUsageStats 返回全 0', async () => {
  assert.deepEqual(await readUsageStats('g-never'), {
    calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0,
  });
});

test('损坏行跳过：仅累计可解析行', async () => {
  await mkdir(USAGE_DIR, { recursive: true });
  await writeFile(usageFile('g-bad'), [
    JSON.stringify({ time: 1, kind: 'chat', model: 'm', prompt_tokens: 7, total_tokens: 9 }),
    '<<<garbage line>>>',
    '',
    JSON.stringify({ time: 2, kind: 'chat', model: 'm', completion_tokens: 3, total_tokens: 4 }),
  ].join('\n') + '\n');
  assert.deepEqual(await readUsageStats('g-bad'), {
    calls: 2, promptTokens: 7, completionTokens: 3, totalTokens: 13, cacheHitTokens: 0,
  });
});

test('fire-and-forget：不 await 提交也安全，最终完整落盘', async () => {
  appendUsage('g-ff', { time: 1760003000, model: 'deepseek-chat', total_tokens: 8 }); // 故意不 await

  // 落盘是异步的：轮询等待文件出现，并校验唯一一行的完整形状
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      const text = await readFile(usageFile('g-ff'), 'utf8');
      assert.deepEqual(JSON.parse(text.trimEnd()), { time: 1760003000, kind: 'chat', model: 'deepseek-chat', total_tokens: 8 });
      return;
    } catch (err) {
      if (err.code !== 'ENOENT' || Date.now() > deadline) throw err;
      await delay(10);
    }
  }
});
