import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fish-napcat-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, 'config');
  mkdirSync(configDir);
  const identity = '1234567890abcdef1234567890abcdef\n';
  writeFileSync(join(configDir, '.machine-id'), identity);
  writeFileSync(join(root, 'dbus-id'), 'old\n');
  return {
    root, configDir, identity,
    run(overrides = {}) {
      return spawnSync('bash', [resolve('scripts/napcat-init.sh')], {
        encoding: 'utf8',
        env: { ...process.env, ACCOUNT: '123456', ONEBOT_ACCESS_TOKEN: 'test-secret',
          NAPCAT_CONFIG_DIR: configDir, NAPCAT_MACHINE_ID_FILE: join(root, 'machine-id'),
          NAPCAT_DBUS_ID_FILE: join(root, 'dbus-id'), ...overrides },
      });
    },
    read(name = 'onebot11_123456.json') {
      return JSON.parse(readFileSync(join(configDir, name), 'utf8'));
    },
  };
}

test('NapCat init: creates default/account WS, restores identity, and is idempotent', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes('test-secret'));
  assert.deepEqual(f.read(), f.read('onebot11.json'));
  assert.equal(f.read().network.websocketServers[0].token, 'test-secret');
  for (const name of ['machine-id', 'dbus-id']) {
    assert.equal(readFileSync(join(f.root, name), 'utf8'), f.identity);
  }
  const first = f.read();
  assert.equal(f.run().status, 0);
  assert.deepEqual(f.read(), first);
});

test('NapCat init: adopts existing port, preserves unrelated settings, rotates token and keeps backup', (t) => {
  const f = fixture(t);
  const existing = { timeout: { baseTimeout: 1234 }, network: {
    httpServers: [{ name: 'other-http', port: 3000 }],
    websocketServers: [{ name: 'ws', port: '3001', token: 'old', enable: false },
      { name: 'other-ws', port: 3002 }],
  } };
  const target = join(f.configDir, 'onebot11_123456.json');
  writeFileSync(target, JSON.stringify(existing));
  assert.equal(f.run().status, 0);
  assert.equal(f.run({ ONEBOT_ACCESS_TOKEN: 'rotated' }).status, 0);
  const saved = f.read();
  assert.deepEqual(saved.timeout, existing.timeout);
  assert.deepEqual(saved.network.httpServers, existing.network.httpServers);
  assert.deepEqual(saved.network.websocketServers[0], existing.network.websocketServers[1]);
  assert.equal(saved.network.websocketServers.length, 2);
  assert.equal(saved.network.websocketServers[1].enable, true);
  assert.equal(saved.network.websocketServers[1].token, 'rotated');
  assert.deepEqual(JSON.parse(readFileSync(`${target}.before-fish-init`, 'utf8')), existing);
});

test('NapCat init: first login without ACCOUNT gets a default WS configuration', (t) => {
  const f = fixture(t);
  assert.equal(f.run({ ACCOUNT: '' }).status, 0);
  assert.equal(f.read('onebot11.json').network.websocketServers[0].enable, true);
});

test('NapCat init: malformed account config is not overwritten', (t) => {
  const f = fixture(t);
  const target = join(f.configDir, 'onebot11_123456.json');
  writeFileSync(target, '{broken');
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(target, 'utf8'), '{broken');
});

test('NapCat init: duplicate managed listeners fail without changing account config', (t) => {
  const f = fixture(t);
  const target = join(f.configDir, 'onebot11_123456.json');
  const raw = JSON.stringify({ network: { websocketServers: [
    { name: 'bot-core', port: 3001 }, { name: 'second', port: 3001 },
  ] } });
  writeFileSync(target, raw);
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(target, 'utf8'), raw);
});

test('NapCat init: empty token, invalid account or corrupt identity stops startup', (t) => {
  const f = fixture(t);
  assert.notEqual(f.run({ ONEBOT_ACCESS_TOKEN: '' }).status, 0);
  assert.notEqual(f.run({ ACCOUNT: '../invalid' }).status, 0);
  writeFileSync(join(f.configDir, '.machine-id'), 'broken\n');
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(join(f.configDir, '.machine-id'), 'utf8'), 'broken\n');
});
