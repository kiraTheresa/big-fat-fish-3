// Task 2 验证：logger 统一输出格式 [HH:mm:ss] LEVEL 消息
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../src/utils/logger.js';

const PATTERN = /^\[\d{2}:\d{2}:\d{2}\] (INFO|WARN|ERROR) /;

// monkey-patch console.log 捕获 logger 输出（三级日志均走 console.log）
function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('logger 三级日志均为 [HH:mm:ss] LEVEL 消息 格式', () => {
  const cases = [
    ['info', 'INFO', '连接已建立'],
    ['warn', 'WARN', '发送失败，继续下一条'],
    ['error', 'ERROR', '调用超时'],
  ];
  for (const [method, level, message] of cases) {
    const lines = captureLog(() => logger[method](message));
    assert.equal(lines.length, 1, `${method} 应恰好输出一行`);
    assert.match(lines[0], PATTERN);
    assert.ok(
      lines[0].endsWith(`] ${level} ${message}`),
      `${method} 输出应为 "[时间] ${level} ${message}"，实际: ${lines[0]}`,
    );
  }
});
