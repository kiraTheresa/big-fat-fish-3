import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCqMessage, normalizeOneBotEvent, messageToCq, STANDARD_SEGMENT_TYPES, getEventSessionKey } from '../src/protocol/onebot.js';

const group = (message) => ({ post_type: 'message', message_type: 'group', group_id: 123, user_id: 456, self_id: 789, message });

test('all 20 standard message segment types and unknown extensions retain complete payloads', () => {
  const segments = [...STANDARD_SEGMENT_TYPES, 'file', 'mface', 'future_extension'].map((type) => ({
    type, data: type === 'text' ? { text: 'hello' } : { url: 'https://invalid.example/a', nested: { a: [1, false, null] }, id: '42' }, extra: { provider: 'napcat' },
  }));
  const input = group(segments);
  const normalized = normalizeOneBotEvent(input);
  assert.deepEqual(normalized.segments, segments);
  assert.deepEqual(normalized.event.message, segments);
  assert.equal(normalized.processable, false);
  normalized.segments[0].data.text = 'mutated';
  assert.equal(input.message[0].data.text, 'hello', 'normalization does not mutate raw receipt');
});

test('CQ parsing decodes text/parameter escaping exactly once and preserves equals/newlines', () => {
  const parsed = parseCqMessage('&#91;CQ:at,qq=1&#93; &amp;#91;[CQ:share,title=a&#44;b=c\nx,url=https://a/?a=1&amp;b=2]尾');
  assert.deepEqual(parsed, [
    { type: 'text', data: { text: '[CQ:at,qq=1] &#91;' } },
    { type: 'share', data: { title: 'a,b=c\nx', url: 'https://a/?a=1&b=2' } },
    { type: 'text', data: { text: '尾' } },
  ]);
});

test('CQ zero-argument and unknown segments accepted, malformed CQ stays literal', () => {
  assert.deepEqual(parseCqMessage('[CQ:shake][CQ:new_kind,x=1]'), [
    { type: 'shake', data: {} }, { type: 'new_kind', data: { x: '1' } },
  ]);
  for (const text of ['[CQ:face,id]', '[CQ:face, id=1]', '[CQ:face,id=1,id=2]', '[CQ:face,id=1']) {
    assert.deepEqual(parseCqMessage(text), [{ type: 'text', data: { text } }]);
  }
  const prototype = parseCqMessage('[CQ:x,__proto__=value,constructor=value]')[0];
  assert.equal(Object.getPrototypeOf(prototype.data), Object.prototype);
  assert.equal(Object.hasOwn(prototype.data, '__proto__'), true);
});

test('legacy supported messages become trigger-eligible, CQ @ and reply enter existing predicates', () => {
  const normalized = normalizeOneBotEvent(group('[CQ:at,qq=789][CQ:reply,id=23] /draw fish'));
  assert.equal(normalized.processable, true);
  assert.deepEqual(normalized.messageTypes, ['at', 'reply', 'text']);
  assert.equal(normalized.event.raw_message, '[CQ:at,qq=789][CQ:reply,id=23] /draw fish');
  const roundTrip = [{ type: 'text', data: { text: '[CQ:image] & fish' } }, { type: 'reply', data: { id: '1,2' } }];
  assert.deepEqual(parseCqMessage(messageToCq(roundTrip)), roundTrip);
});

test('private, group anonymous, system group notice and sent-message have explicit handling boundaries', () => {
  for (const sub_type of ['friend', 'group', 'other']) {
    const event = { ...group('text'), message_type: 'private', sub_type };
    assert.equal(normalizeOneBotEvent(event).sessionKey, 'p-456');
    assert.equal(normalizeOneBotEvent(event).processable, true);
  }
  assert.equal(normalizeOneBotEvent({ ...group('text'), sub_type: 'anonymous', anonymous: { id: 99 } }).processable, true);
  assert.equal(normalizeOneBotEvent({ ...group('text'), sub_type: 'notice' }).processable, false);
  assert.equal(normalizeOneBotEvent({ ...group('text'), post_type: 'message_sent' }).processable, false);
});

test('all post types including unknown extensions are accepted without triggering handlers', () => {
  for (const post_type of ['notice', 'request', 'meta_event', 'implementation_event']) {
    const raw = { post_type, notice_type: 'notify', sub_type: 'poke', group_id: 123, payload: [1, 2] };
    const normalized = normalizeOneBotEvent(raw);
    assert.deepEqual(normalized.event, raw);
    assert.equal(normalized.processable, false);
    assert.equal(normalized.sessionKey, 'g-123');
  }
});

test('malformed envelopes and unsafe routing IDs cannot enter triggers or create paths', () => {
  for (const input of [null, [], 42, 'hello', {}, { post_type: 1 }, { post_type: '' }]) assert.equal(normalizeOneBotEvent(input), null);
  for (const message of [null, 5, {}, [], '', [null], [{ type: 'text', data: { text: {} } }]]) {
    const normalized = normalizeOneBotEvent(group(message));
    assert.equal(normalized.processable, false);
    assert.equal(normalized.handling, 'malformed');
  }
  assert.equal(normalizeOneBotEvent({ ...group('text'), group_id: '../escape' }).processable, false);
  assert.equal(normalizeOneBotEvent({ ...group('text'), user_id: {} }).processable, false);
  assert.equal(getEventSessionKey({ group_id: '../escape', user_id: '../../secret' }), null);
});

test('戳一戳仅放行他人戳机器人；通知保持原样且不开放其他通知', () => {
  const raw = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: 789, user_id: 456, target_id: '789', group_id: 123 };
  const result = normalizeOneBotEvent(raw);
  assert.equal(result.processable, true);
  assert.equal(result.sessionKey, 'g-123');
  assert.deepEqual(result.event, raw);
  assert.equal(normalizeOneBotEvent({ ...raw, group_id: undefined }).sessionKey, 'p-456');
  for (const patch of [{ target_id: 456 }, { user_id: 789 }, { self_id: undefined }, { user_id: null },
    { target_id: undefined }, { group_id: '../unsafe' }, { notice_type: 'friend_add' }, { sub_type: 'honor' }]) {
    assert.equal(normalizeOneBotEvent({ ...raw, ...patch }).processable, false);
  }
});
