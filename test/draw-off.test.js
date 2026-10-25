// draw 触发器安全默认：未配置 IMAGE_API_KEY（留空）→ match 恒不触发（同 chat 的
// deepseekApiKey 模式）。独立小文件：config 在 import 时求值 env，key 有无两套
// 环境不能同文件共存（draw.test.js 是配了 key 的全链路，本文件专测未配置分支）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.IMAGE_API_KEY = '';

const draw = (await import('../src/triggers/draw.js')).default;

test('未配置 IMAGE_API_KEY：/draw 消息恒不命中（功能不存在，不吞消息）', () => {
  const event = {
    post_type: 'message',
    message_type: 'group',
    group_id: 1,
    user_id: 9001,
    self_id: 10000,
    time: 1760004000,
    message_id: 1,
    message: [{ type: 'text', data: { text: '/draw 一只猫' } }],
    raw_message: '/draw 一只猫',
    sender: { nickname: 'x' },
  };
  assert.equal(draw.match(event), false);
});
