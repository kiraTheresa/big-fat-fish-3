// Task 5 验证（spec G3/G4 的注册表部分）：register / getTriggers 保序、重名抛错。
// registry 不依赖 config/env，直接静态 import；node:test 每文件独立进程，注册状态不外泄。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, getTriggers } from '../src/dispatch/registry.js';

test('register / getTriggers：按注册顺序返回（命中即停依赖此顺序）', () => {
  const first = { name: 'reg-order-first', match: () => false, handle: () => {} };
  const second = { name: 'reg-order-second', match: () => false, handle: () => {} };
  register(first);
  register(second);

  const triggers = getTriggers();
  assert.ok(triggers.includes(first), '注册后应可从 getTriggers 取回');
  assert.ok(triggers.includes(second), '注册后应可从 getTriggers 取回');
  assert.ok(triggers.indexOf(first) < triggers.indexOf(second), '应保持注册顺序');
});

test('重名抛错：同名触发器 register 时 throw，且不污染原注册表', () => {
  const original = { name: 'reg-dup', match: () => false, handle: () => {} };
  register(original);

  assert.throws(
    () => register({ name: 'reg-dup', match: () => false, handle: () => {} }),
    /重名/
  );

  const same = getTriggers().filter((t) => t.name === 'reg-dup');
  assert.equal(same.length, 1, '重名注册失败后注册表不应多出条目');
  assert.equal(same[0], original, '注册表应保留首次注册的触发器');
});
