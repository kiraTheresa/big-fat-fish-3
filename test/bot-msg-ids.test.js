// upgrade-chat-pipeline Task 8 验证：出站 message_id 进程内记录（bot-msg-ids）——
// 记录/查询、String 归一（OneBot id 数字/字符串两型）、确认残缺不入集、
// 容量上限 FIFO 淘汰、重复记录幂等、clear 测试辅助。
// sender 真实接线（发送确认后入集）另见 test/sender.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordBotMessageId,
  isBotMessageId,
  clearBotMessageIds,
  BOT_MSG_ID_LIMIT,
} from '../src/sender/bot-msg-ids.js';

test('记录与查询：record 后 is 查得到，未记录的 id 查不到', () => {
  clearBotMessageIds();
  recordBotMessageId(1001);
  assert.equal(isBotMessageId(1001), true);
  assert.equal(isBotMessageId(1002), false, '未记录的 id 不得命中');
});

test('String 归一：数字入集字符串查、字符串入集数字查（两型互认）', () => {
  clearBotMessageIds();
  recordBotMessageId(2001); // 数字入集（send_msg 响应常见形态）
  assert.equal(isBotMessageId('2001'), true, '字符串型引用应命中数字型记录');
  recordBotMessageId('2002'); // 字符串入集（reply 段 id 常见形态）
  assert.equal(isBotMessageId(2002), true, '数字型引用应命中字符串型记录');
});

test('确认残缺不入集：undefined / null 不记录（防 String() 幽灵 id 误命中）', () => {
  clearBotMessageIds();
  recordBotMessageId(undefined);
  recordBotMessageId(null);
  assert.equal(isBotMessageId(undefined), false);
  assert.equal(isBotMessageId('undefined'), false, '不得出现 "undefined" 幽灵 id');
  assert.equal(isBotMessageId(null), false);
  assert.equal(isBotMessageId('null'), false, '不得出现 "null" 幽灵 id');
});

test('容量上限 FIFO：LIMIT+1 条入集后最旧一条淘汰、其余全在', () => {
  clearBotMessageIds();
  for (let i = 1; i <= BOT_MSG_ID_LIMIT + 1; i++) recordBotMessageId(i);
  assert.equal(isBotMessageId(1), false, '最旧的第 1 条应被 FIFO 淘汰');
  for (let i = 2; i <= BOT_MSG_ID_LIMIT + 1; i++) {
    assert.equal(isBotMessageId(i), true, `第 ${i} 条应在集合内`);
  }
});

test('重复记录幂等：同 id 再记不重复入队，淘汰按首次入集顺序', () => {
  clearBotMessageIds();
  for (let i = 1; i <= BOT_MSG_ID_LIMIT; i++) recordBotMessageId(i);
  recordBotMessageId(1); // 已在集内：不得重复入队占 FIFO 容量
  recordBotMessageId(BOT_MSG_ID_LIMIT + 1); // 超限一条：淘汰的应是队头 1，而非 2
  assert.equal(isBotMessageId(1), false, '队头 1 应在重复记录后仍被首个淘汰');
  assert.equal(isBotMessageId(2), true);
  assert.equal(isBotMessageId(BOT_MSG_ID_LIMIT + 1), true, '新 id 正常入集');
});

test('clear 清空：清后旧 id 全部查不到，新记录不受影响', () => {
  clearBotMessageIds();
  recordBotMessageId(3001);
  clearBotMessageIds();
  assert.equal(isBotMessageId(3001), false, '清空后旧 id 不得命中');
  recordBotMessageId(3002);
  assert.equal(isBotMessageId(3002), true, '清空不影响后续记录');
});
