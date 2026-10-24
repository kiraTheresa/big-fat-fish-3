// Task 2 验证：config 默认值 + env 覆盖 + num() 回退
import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js 读取的全部环境变量键
const ENV_KEYS = [
  'ONEBOT_WS_URL',
  'ONEBOT_ACCESS_TOKEN',
  'RECONNECT_DELAY_MS',
  'API_TIMEOUT_MS',
  'SEND_INTERVAL_MS',
  'DATA_DIR',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'CHAT_TIMEOUT_MS',
  'CHAT_CONTEXT_LINES',
  'CHAT_COOLDOWN_MS',
  'ADMIN_QQ',
  'PERSONA_DIR',
  'PERSONA_MAX_BYTES',
  'DISTILL_SILENCE_MS',
  'DISTILL_BATCH_SIZE',
  'DISTILL_INTERVAL_MS',
  'USAGE_DIR',
];

// ESM 模块按完整 URL 缓存：同一路径第二次 import 拿到的是缓存对象。
// 带唯一 query 的 URL 被视为不同模块，加载后得到全新模块实例（config 重新求值）。
async function loadFreshConfig(caseName, overrides = {}) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    if (key in overrides) process.env[key] = overrides[key];
    else delete process.env[key];
  }
  try {
    const mod = await import(`../src/config.js?case=${caseName}`);
    return mod.config;
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('默认值：未设置相关 env 时返回全部默认值', async () => {
  const config = await loadFreshConfig('defaults');
  assert.equal(config.wsUrl, 'ws://localhost:3001');
  assert.equal(config.accessToken, '');
  assert.equal(config.reconnectDelayMs, 5000);
  assert.equal(config.apiTimeoutMs, 15000);
  assert.equal(config.sendIntervalMs, 1000);
  assert.equal(config.dataDir, 'data');
  // AIChat（add-aichat-mvp spec）
  assert.equal(config.deepseekApiKey, '');
  assert.equal(config.deepseekBaseUrl, 'https://api.deepseek.com');
  assert.equal(config.deepseekModel, 'deepseek-chat');
  assert.equal(config.chatTimeoutMs, 60000);
  assert.equal(config.chatContextLines, 20);
  assert.equal(config.chatCooldownMs, 5000);
  // 自进化人设（add-self-evolving-persona spec）
  assert.deepEqual(config.adminQq, []);
  assert.equal(config.personaDir, 'data/personas');
  assert.equal(config.personaMaxBytes, 4096);
  assert.equal(config.distillSilenceMs, 600000);
  assert.equal(config.distillBatchSize, 50);
  assert.equal(config.distillIntervalMs, 60000);
  assert.equal(config.usageDir, 'data/usage');
});

test('env 覆盖：设置变量后加载全新模块实例，注入值生效', async () => {
  const config = await loadFreshConfig('overrides', {
    ONEBOT_WS_URL: 'ws://127.0.0.1:9999',
    ONEBOT_ACCESS_TOKEN: 'test-token',
    RECONNECT_DELAY_MS: '123',
    API_TIMEOUT_MS: '456',
    SEND_INTERVAL_MS: '10',
    DATA_DIR: 'data-test-tmp',
    DEEPSEEK_API_KEY: 'sk-test',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:1234',
    DEEPSEEK_MODEL: 'deepseek-reasoner',
    CHAT_TIMEOUT_MS: '789',
    CHAT_CONTEXT_LINES: '5',
    CHAT_COOLDOWN_MS: '100',
    ADMIN_QQ: '111,222',
    PERSONA_DIR: 'data/personas-tmp',
    PERSONA_MAX_BYTES: '2048',
    DISTILL_SILENCE_MS: '120000',
    DISTILL_BATCH_SIZE: '10',
    DISTILL_INTERVAL_MS: '5000',
    USAGE_DIR: 'data/usage-tmp',
  });
  assert.equal(config.wsUrl, 'ws://127.0.0.1:9999');
  assert.equal(config.accessToken, 'test-token');
  assert.equal(config.reconnectDelayMs, 123);
  assert.equal(config.apiTimeoutMs, 456);
  assert.equal(config.sendIntervalMs, 10);
  assert.equal(config.dataDir, 'data-test-tmp');
  assert.equal(config.deepseekApiKey, 'sk-test');
  assert.equal(config.deepseekBaseUrl, 'http://127.0.0.1:1234');
  assert.equal(config.deepseekModel, 'deepseek-reasoner');
  assert.equal(config.chatTimeoutMs, 789);
  assert.equal(config.chatContextLines, 5);
  assert.equal(config.chatCooldownMs, 100);
  assert.deepEqual(config.adminQq, ['111', '222']);
  assert.equal(config.personaDir, 'data/personas-tmp');
  assert.equal(config.personaMaxBytes, 2048);
  assert.equal(config.distillSilenceMs, 120000);
  assert.equal(config.distillBatchSize, 10);
  assert.equal(config.distillIntervalMs, 5000);
  assert.equal(config.usageDir, 'data/usage-tmp');
});

test('num 辅助：env 值不可解析为整数时回退默认值', async () => {
  const config = await loadFreshConfig('invalid', {
    SEND_INTERVAL_MS: 'abc',
    RECONNECT_DELAY_MS: '',
  });
  assert.equal(config.sendIntervalMs, 1000);
  assert.equal(config.reconnectDelayMs, 5000);
});

test('ADMIN_QQ 解析：逗号分隔转数组，空串与空白项被过滤', async () => {
  const config = await loadFreshConfig('admin-qq', {
    ADMIN_QQ: '123,, 456 ,',
  });
  assert.deepEqual(config.adminQq, ['123', '456']);
});
