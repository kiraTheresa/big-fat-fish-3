import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemeTrigger } from '../src/triggers/meme.js';

const id = '12345678-1234-1234-1234-123456789abc';
function fixture(text, { group = false, at = false, enabled = true, manage = false, ...dependencies } = {}) {
  const replies = [];
  const calls = [];
  const ctx = { sessionKey: group ? 'g-1' : 'p-2', event: {
    self_id: 42, user_id: 2, group_id: group ? 1 : undefined, message_type: group ? 'group' : 'private',
    message: [...(at ? [{ type: 'at', data: { qq: '42' } }] : []), { type: 'text', data: { text } }],
  }, reply: async (value) => replies.push(value) };
  const trigger = createMemeTrigger({
    settings: () => ({ tools: Object.fromEntries(['save_meme', 'search_memes', 'send_meme'].map((name) => [name, { enabled }])) }),
    canManage: () => manage,
    collect: async (context, args) => { calls.push(['save', context.sessionKey, args]); return { asset: { id, name: args.name, missingParameters: [] }, duplicate: false }; },
    search: async (session, query, options) => { calls.push(['search', session, query, options]); return [{ id, name: '躺平', enabled: true }]; },
    send: async (context, assetId) => { calls.push(['send', context.sessionKey, assetId]); return { ok: true, messageId: 1 }; },
    update: async (...args) => calls.push(['update', ...args]),
    ...dependencies,
  });
  return { ctx, trigger, replies, calls, run: () => trigger.handle(ctx) };
}

test('边界与群聊寻址：裸指令静默，中文别名可用，不吞其他指令', async () => {
  const sample = fixture('/meme save 躺平', { group: true });
  assert.equal(sample.trigger.match(sample.ctx.event), true);
  await sample.run();
  assert.deepEqual(sample.calls, []);
  assert.deepEqual(sample.replies, []);
  const wrong = fixture('/memes save 躺平');
  assert.equal(wrong.trigger.match(wrong.ctx.event), false);
  const help = fixture('/表情', { group: true, at: true });
  await help.run();
  assert.match(help.replies[0], /save/);
});

test('收藏必须带说明；成功显示 ID，重复和不完整分别说明', async () => {
  const empty = fixture('/meme save');
  await empty.run();
  assert.equal(empty.calls.length, 0);
  assert.match(empty.replies[0], /用法/);
  const saved = fixture('/meme save 累了 想躺平');
  await saved.run();
  assert.deepEqual(saved.calls[0], ['save', 'p-2', { name: '累了 想躺平', tags: [] }]);
  assert.match(saved.replies[0], new RegExp(id));
  for (const [duplicate, missingParameters, expected] of [[true, [], /已经收藏/], [false, ['key'], /暂不能使用/]]) {
    const sample = fixture('/meme save 名字', { collect: async () => ({ duplicate, asset: { id, missingParameters } }) });
    await sample.run();
    assert.match(sample.replies[0], expected);
  }
});

test('列表限制到当前会话且显示停用标记；名称发送必须唯一精确匹配', async () => {
  const list = fixture('/meme list 累', { search: async (session, query, opts) => {
    assert.equal(session, 'p-2'); assert.equal(query, '累'); assert.equal(opts.limit, 10); assert.equal(opts.includeUnavailable, true);
    return [{ id, name: '躺平', enabled: false }];
  } });
  await list.run();
  assert.match(list.replies[0], /已停用/);
  const send = fixture('/meme send 躺平');
  await send.run();
  assert.deepEqual(send.calls.at(-1), ['send', 'p-2', id]);
  assert.deepEqual(send.replies, []);
  const multiple = fixture('/meme send 躺平', { search: async () => [{ id, name: '躺平' }, { id: 'other', name: '躺平' }] });
  await multiple.run();
  assert.match(multiple.replies[0], /同名/);
  assert.equal(multiple.calls.length, 0);
});

test('发送失败不声称成功；异常不泄露链接或密钥', async () => {
  const fail = fixture(`/meme send ${id}`, { send: async () => ({ ok: false, error: 'private-key' }) });
  await fail.run();
  assert.match(fail.replies[0], /发送失败/);
  assert.ok(!fail.replies[0].includes('private-key'));
  const broken = fixture('/meme save 躺平', { collect: async () => { throw new Error('https://private.invalid/?key=secret'); } });
  await broken.run();
  assert.ok(!broken.replies.join('').includes('secret'));
});

test('工具开关同样约束指令，关闭后不调用服务但仍能查看帮助', async () => {
  const disabled = fixture('/meme save 躺平', { enabled: false });
  await disabled.run();
  assert.match(disabled.replies[0], /已关闭/);
  assert.equal(disabled.calls.length, 0);
  const help = fixture('/meme help', { enabled: false });
  await help.run();
  assert.match(help.replies[0], /save/);
});

test('管理操作要求权限与完整 UUID，按会话修改且不删除素材', async () => {
  const no = fixture(`/meme disable ${id}`, { group: true, at: true });
  await no.run();
  assert.match(no.replies[0], /管理员/);
  assert.deepEqual(no.calls, []);
  const yes = fixture(`/meme disable ${id}`, { manage: true });
  await yes.run();
  assert.deepEqual(yes.calls[0], ['update', 'p-2', id, { enabled: false }]);
  const rename = fixture(`/meme rename ${id} 下班专用`, { manage: true });
  await rename.run();
  assert.deepEqual(rename.calls[0], ['update', 'p-2', id, { name: '下班专用' }]);
  const invalid = fixture('/meme enable ../escape', { manage: true });
  await invalid.run();
  assert.match(invalid.replies[0], /完整表情 ID/);
  assert.deepEqual(invalid.calls, []);
});
