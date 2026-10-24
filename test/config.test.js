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
});

test('env 覆盖：设置变量后加载全新模块实例，注入值生效', async () => {
  const config = await loadFreshConfig('overrides', {
    ONEBOT_WS_URL: 'ws://127.0.0.1:9999',
    ONEBOT_ACCESS_TOKEN: 'test-token',
    RECONNECT_DELAY_MS: '123',
    API_TIMEOUT_MS: '456',
    SEND_INTERVAL_MS: '10',
    DATA_DIR: 'data-test-tmp',
  });
  assert.equal(config.wsUrl, 'ws://127.0.0.1:9999');
  assert.equal(config.accessToken, 'test-token');
  assert.equal(config.reconnectDelayMs, 123);
  assert.equal(config.apiTimeoutMs, 456);
  assert.equal(config.sendIntervalMs, 10);
  assert.equal(config.dataDir, 'data-test-tmp');
});

test('num 辅助：env 值不可解析为整数时回退默认值', async () => {
  const config = await loadFreshConfig('invalid', {
    SEND_INTERVAL_MS: 'abc',
    RECONNECT_DELAY_MS: '',
  });
  assert.equal(config.sendIntervalMs, 1000);
  assert.equal(config.reconnectDelayMs, 5000);
});
