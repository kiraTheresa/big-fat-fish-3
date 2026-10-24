// mock OneBot 服务器自测（node:test + ws 客户端），不依赖真实 NapCat / QQ。
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startMockServer } from './mock-onebot.js';

const servers = [];
const sockets = [];

async function startServer(opts = {}) {
  const server = await startMockServer(opts);
  servers.push(server);
  return server;
}

function connect(url, headers = {}) {
  const ws = new WebSocket(url, { headers });
  sockets.push(ws);
  return ws;
}

after(async () => {
  for (const ws of sockets) ws.terminate();
  for (const server of servers) await server.close();
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function onceOpen(ws) {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function onceClosed(ws) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    ws.once('close', resolve);
    ws.once('error', resolve);
  });
}

function nextMessage(ws, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`no message within ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    };
    ws.once('message', onMessage);
  });
}

async function waitUntil(cond, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await delay(20);
  }
}

describe('mock OneBot 11 server', () => {
  it('accepts a client with the correct bearer token and keeps it open', { timeout: 5000 }, async () => {
    const server = await startServer({ token: 'secret-token' });
    assert.ok(Number.isInteger(server.port) && server.port > 0);
    assert.equal(server.url, `ws://localhost:${server.port}`);

    const ws = connect(server.url, { Authorization: 'Bearer secret-token' });
    await onceOpen(ws);
    await server.waitForConnectionCount(1);

    await delay(150);
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.equal(server.connections, 1);
    assert.equal(server.frames.length, 0);
  });

  it('immediately closes a client with a wrong bearer token', { timeout: 5000 }, async () => {
    const server = await startServer({ token: 'secret-token' });
    const ws = connect(server.url, { Authorization: 'Bearer wrong-token' });

    await onceClosed(ws);
    await waitUntil(() => server.connections === 0);
  });

  it('auto-responds ok with echo and numeric message_id', { timeout: 5000 }, async () => {
    const server = await startServer();
    const ws = connect(server.url);
    await onceOpen(ws);

    const pending = nextMessage(ws);
    ws.send(JSON.stringify({ action: 'send_msg', params: {}, echo: '1' }));
    const resp = JSON.parse(await pending);

    assert.equal(resp.status, 'ok');
    assert.equal(resp.retcode, 0);
    assert.equal(resp.echo, '1');
    assert.equal(resp.wording, '');
    assert.equal(typeof resp.data.message_id, 'number');
  });

  it('failNextCall makes the next action frame fail with given retcode/wording', { timeout: 5000 }, async () => {
    const server = await startServer();
    const ws = connect(server.url);
    await onceOpen(ws);

    server.failNextCall(1404, 'action not found');
    let pending = nextMessage(ws);
    ws.send(JSON.stringify({ action: 'get_version_info', params: {}, echo: 'a' }));
    let resp = JSON.parse(await pending);
    assert.equal(resp.status, 'failed');
    assert.equal(resp.retcode, 1404);
    assert.equal(resp.wording, 'action not found');
    assert.equal(resp.data, null);
    assert.equal(resp.echo, 'a');

    // 仅影响“下一个” action 帧：其后恢复 ok
    pending = nextMessage(ws);
    ws.send(JSON.stringify({ action: 'get_version_info', params: {}, echo: 'b' }));
    resp = JSON.parse(await pending);
    assert.equal(resp.status, 'ok');
    assert.equal(resp.retcode, 0);
    assert.equal(resp.echo, 'b');
  });

  it('failNextCall defaults to retcode 1400 and wording "mock failure"', { timeout: 5000 }, async () => {
    const server = await startServer();
    const ws = connect(server.url);
    await onceOpen(ws);

    server.failNextCall();
    const pending = nextMessage(ws);
    ws.send(JSON.stringify({ action: 'send_msg', params: {}, echo: 'd' }));
    const resp = JSON.parse(await pending);
    assert.equal(resp.retcode, 1400);
    assert.equal(resp.wording, 'mock failure');
  });

  it('records every parsed JSON frame and ignores non-JSON input', { timeout: 5000 }, async () => {
    const server = await startServer();
    const ws = connect(server.url);
    await onceOpen(ws);

    const received = [];
    ws.on('message', (data) => received.push(data.toString()));

    ws.send(JSON.stringify({ action: 'send_msg', params: { group_id: 123 }, echo: 'e1' }));
    ws.send(JSON.stringify({ post_type: 'message', raw_message: 'ping' }));
    ws.send('not-json{{');

    const actionFrame = await server.waitForFrame((f) => f.echo === 'e1');
    assert.deepEqual(actionFrame, { action: 'send_msg', params: { group_id: 123 }, echo: 'e1' });
    await server.waitForFrame((f) => f.raw_message === 'ping');
    await delay(100);

    assert.equal(server.frames.length, 2); // 坏帧不入记录、服务不崩溃
    assert.equal(received.length, 1); // 事件帧与坏帧均不触发应答
    assert.equal(JSON.parse(received[0]).echo, 'e1');
  });

  it('waitForFrame also resolves for frames arriving later', { timeout: 5000 }, async () => {
    const server = await startServer();
    const ws = connect(server.url);
    await onceOpen(ws);

    const pending = server.waitForFrame((f) => f.action === 'ping_later');
    ws.send(JSON.stringify({ action: 'ping_later', echo: 'later' }));
    const frame = await pending;
    assert.equal(frame.echo, 'later');
  });

  it('waitForConnectionCount resolves once enough clients connected', { timeout: 5000 }, async () => {
    const server = await startServer();
    const pending = server.waitForConnectionCount(1);
    const ws = connect(server.url);
    await onceOpen(ws);
    await pending;
    assert.equal(server.connections, 1);
  });

  it('injectEvent delivers the same JSON event to every connected client', { timeout: 5000 }, async () => {
    const server = await startServer();
    const wsA = connect(server.url);
    const wsB = connect(server.url);
    await onceOpen(wsA);
    await onceOpen(wsB);
    await server.waitForConnectionCount(2);

    const pendingA = nextMessage(wsA);
    const pendingB = nextMessage(wsB);
    const event = {
      post_type: 'message',
      message_type: 'group',
      group_id: 123,
      raw_message: 'ping',
    };
    server.injectEvent(event);

    assert.deepEqual(JSON.parse(await pendingA), event);
    assert.deepEqual(JSON.parse(await pendingB), event);
  });

  it('sendRaw delivers raw non-JSON text', { timeout: 5000 }, async () => {
    const server = await startServer();
    const ws = connect(server.url);
    await onceOpen(ws);

    const pending = nextMessage(ws);
    server.sendRaw('this is not json');
    assert.equal(await pending, 'this is not json');
  });

  it('setAutoRespond(false) silences automatic ok responses', { timeout: 5000 }, async () => {
    const server = await startServer();
    const ws = connect(server.url);
    await onceOpen(ws);

    const received = [];
    ws.on('message', (data) => received.push(data.toString()));

    server.setAutoRespond(false);
    ws.send(JSON.stringify({ action: 'send_msg', params: {}, echo: 'quiet' }));
    await server.waitForFrame((f) => f.echo === 'quiet');
    await delay(150);
    assert.equal(received.length, 0);
  });

  it('disconnectClients closes all client connections from the server side', { timeout: 5000 }, async () => {
    const server = await startServer();
    const ws = connect(server.url);
    await onceOpen(ws);

    server.disconnectClients();
    await onceClosed(ws);
    await waitUntil(() => server.connections === 0);
  });
});
