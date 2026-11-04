// Task 2 验证：logger 统一输出格式 [HH:mm:ss] LEVEL 消息
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger, configureLogger } from '../src/utils/logger.js';

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

test('终端显示命中、工具与发送语义，默认隐藏无命中和队列细节，不打印元数据 JSON', () => {
  configureLogger({ level: 'INFO', sessionKey: '' });
  const lines = captureLog(() => {
    const context = { traceId: 'trace-123456789', sessionKey: 'g-123' };
    logger.event('chat.matched', { ...context, reason: 'nameCall' });
    logger.event('handler.started', { ...context, data: { trigger: 'chat' } });
    logger.event('handler.skipped', { ...context, reason: 'no_trigger' });
    logger.event('reply.queued', context);
    logger.event('tool.finished', { ...context, outcome: 'success', elapsedMs: 17, data: { name: 'search_memes', reused: true, arguments: 'DO_NOT_PRINT_ARGUMENTS' } });
    logger.event('reply.finished', { ...context, outcome: 'unknown', level: 'WARN', reason: 'ONEBOT_TIMEOUT' });
  });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /\[trace-12 g-123\].*chat 命中.*名字呼唤/);
  assert.match(lines[1], /search_memes.*复用已有结果，未重新执行.*17ms/);
  assert.match(lines[2], /结果未知.*平台确认超时/);
  assert.doesNotMatch(lines.join('\n'), /operationId|sessionKey|DO_NOT_PRINT_ARGUMENTS|\{/);
});

test('DEBUG 与会话筛选仅控制终端，其他会话失败仍显示', () => {
  configureLogger({ level: 'DEBUG', sessionKey: 'g-123' });
  try {
    const lines = captureLog(() => {
      logger.event('chat.not_matched', { level: 'DEBUG', sessionKey: 'g-123', reason: 'no_group_condition' });
      logger.event('chat.not_matched', { level: 'DEBUG', sessionKey: 'g-456', reason: 'no_group_condition' });
      logger.event('tool.finished', { sessionKey: 'g-456', level: 'WARN', outcome: 'failed', data: { name: 'draw', error: 'Bearer private-key' } });
    });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /chat 未命中.*未满足已启用/);
    assert.match(lines[1], /g-456.*draw.*\[REDACTED\]/);
    assert.doesNotMatch(lines.join('\n'), /private-key/);
  } finally { configureLogger({ level: 'INFO', sessionKey: '' }); }
});
