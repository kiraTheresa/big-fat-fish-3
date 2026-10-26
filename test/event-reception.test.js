import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dataDir = await mkdtemp(join(tmpdir(), 'fish-inbox-'));
process.env.DATA_DIR = dataDir;
const { config } = await import('../src/config.js');
const { dispatch } = await import('../src/dispatch/dispatcher.js');
const { register } = await import('../src/dispatch/registry.js');
const { readEvents, appendEvent, flushEventStore, getEventStats } = await import('../src/store/event-store.js');
const { readRecentMessages, appendMessage, flushMessageStore } = await import('../src/store/message-store.js');
let triggered = 0;
register({ name: 'all-message-probe', match: () => true, handle: () => { triggered++; } });
after(async () => { await flushEventStore(); await flushMessageStore(); await rm(dataDir, { recursive: true, force: true }); });

const message = (segments) => ({ post_type: 'message', message_type: 'group', group_id: 321, user_id: 654, message: segments, time: 10 });

test('standard notice/request/meta events, extensions and sent messages persist without dispatch', async () => {
  const noticeTypes = ['group_upload', 'group_admin', 'group_decrease', 'group_increase', 'group_ban', 'friend_add', 'group_recall', 'friend_recall'];
  const events = [
    ...noticeTypes.map((notice_type) => ({ post_type: 'notice', notice_type, group_id: 999, file: { id: 'a', url: 'https://invalid.example/file' } })),
    ...['poke', 'lucky_king', 'honor'].map((sub_type) => ({ post_type: 'notice', notice_type: 'notify', sub_type })),
    ...['friend', 'group'].map((request_type) => ({ post_type: 'request', request_type, flag: 'do-not-approve' })),
    ...['lifecycle', 'heartbeat'].map((meta_event_type) => ({ post_type: 'meta_event', meta_event_type, interval: 1000, status: { online: true } })),
    { ...message('bot echo'), post_type: 'message_sent' },
    { post_type: 'custom_extension', data: { untouched: true } },
  ];
  for (const event of events) await dispatch(event);
  await flushEventStore();
  const { items } = await readEvents({ limit: 100 });
  assert.equal(items.length, events.length);
  assert.deepEqual(items.map((row) => row.event), events.toReversed());
  assert.ok(items.every((row) => row.handling === 'received_only'));
  assert.equal(triggered, 0);
  assert.deepEqual(await readRecentMessages('g-999', 100), []);
  assert.deepEqual(await readRecentMessages('g-321', 100), []);
});

test('new media and unknown segments retain payload and never enter chat processing/history', async () => {
  const event = message([{ type: 'text', data: { text: 'please see this' } }, { type: 'record', data: { file: 'audio', url: 'https://invalid.example/audio' } }, { type: 'extension', data: { nested: [1] } }]);
  await dispatch(event);
  const { items } = await readEvents({ postType: 'message', sessionKey: 'g-321' });
  assert.deepEqual(items[0].event, event);
  assert.deepEqual(items[0].segments, event.message);
  assert.equal(items[0].handling, 'received_only');
  assert.equal(triggered, 0);
  assert.deepEqual(await readRecentMessages('g-321', 100), []);
});

test('existing text CQ message stays processable and normalized segments persist in history', async () => {
  await dispatch(message('[CQ:at,qq=7]hello'));
  assert.equal(triggered, 1);
  const rows = await readRecentMessages('g-321', 100);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].message, [{ type: 'at', data: { qq: '7' } }, { type: 'text', data: { text: 'hello' } }]);
  assert.equal(rows[0].raw_message, '[CQ:at,qq=7]hello');
});

test('malformed messages are inspectable, rejected as handler input, and path traversal cannot write', async () => {
  await dispatch({ ...message([null, { type: 'text', data: {} }]), group_id: '../escape' });
  await dispatch(null);
  assert.equal(triggered, 1);
  const { items } = await readEvents({ limit: 1 });
  assert.equal(items[0].handling, 'malformed');
  assert.ok(items[0].issues.includes('invalid_group_id'));
  await appendMessage({ sessionKey: '../outside', raw_message: 'bad' });
  await assert.rejects(readFile(join(dataDir, 'outside.jsonl')), { code: 'ENOENT' });
  assert.deepEqual(await readRecentMessages('../outside', 10), []);
});

test('pagination uses stable cursors across writes and filters, with corrupt rows skipped', async () => {
  for (let n = 0; n < 5; n++) await appendEvent({ postType: 'notice', sessionKey: 'g-888', event: { n } });
  await appendFile(join(dataDir, 'events', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'not-json\nnull\n[]\n');
  const first = await readEvents({ limit: 2, postType: 'notice', sessionKey: 'g-888' });
  assert.deepEqual(first.items.map((row) => row.event.n), [4, 3]);
  await appendEvent({ postType: 'notice', sessionKey: 'g-888', event: { n: 5 } });
  const second = await readEvents({ limit: 2, postType: 'notice', sessionKey: 'g-888', before: first.nextCursor });
  assert.deepEqual(second.items.map((row) => row.event.n), [2, 1]);
  const third = await readEvents({ limit: 2, postType: 'notice', sessionKey: 'g-888', before: second.nextCursor });
  assert.deepEqual(third.items.map((row) => row.event.n), [0]);
  assert.equal(third.nextCursor, null);
  assert.deepEqual(await readEvents({ before: 'invalid' }), { items: [], nextCursor: null });
});

test('inbox snapshots caller mutations and survives failed storage before later successful writes', async () => {
  const raw = { postType: 'notice', event: { payload: { before: true } } };
  const pending = appendEvent(raw);
  raw.event.payload.before = false;
  const saved = await pending;
  assert.equal(saved.event.payload.before, true);
  const blocker = join(dataDir, 'blocker');
  await writeFile(blocker, 'not directory');
  config.dataDir = blocker;
  try { assert.equal(await appendEvent({ postType: 'notice' }), null); }
  finally { config.dataDir = dataDir; }
  assert.ok(await appendEvent({ postType: 'notice', event: { recovered: true } }));
  const stats = getEventStats();
  assert.equal(stats.scope, 'process');
  assert.equal(stats.failed, 1);
  assert.ok(stats.postTypes.notice > 0);
  assert.equal(stats.sessions['g-888'], 6);
});

test('daily UTC files paginate across day boundaries and ignore unrelated filenames', async () => {
  const isolated = join(dataDir, 'multi-day');
  await mkdir(join(isolated, 'events'), { recursive: true });
  for (const [date, numbers] of [['2026-10-24', [1, 2]], ['2026-10-25', [3, 4]], ['2026-10-26', [5, 6]]]) {
    await writeFile(join(isolated, 'events', `${date}.jsonl`), numbers.map((n) => JSON.stringify({ id: `row-${n}`, postType: 'notice', event: { n } })).join('\n') + '\n');
  }
  await writeFile(join(isolated, 'events', 'not-a-day.jsonl'), '{"id":"stray","event":{"n":999}}\n');
  config.dataDir = isolated;
  try {
    const first = await readEvents({ limit: 3 });
    assert.deepEqual(first.items.map((row) => row.event.n), [6, 5, 4]);
    const second = await readEvents({ limit: 3, before: first.nextCursor });
    assert.deepEqual(second.items.map((row) => row.event.n), [3, 2, 1]);
    assert.equal(second.nextCursor, null);
    await rm(join(isolated, 'events', '2026-10-24.jsonl'));
    assert.deepEqual(await readEvents({ before: 'row-2' }), { items: [], nextCursor: null });
  } finally { config.dataDir = dataDir; }
});
