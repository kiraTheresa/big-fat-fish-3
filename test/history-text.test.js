import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyText } from '../src/utils/history-text.js';
import { buildChatRequest } from '../src/prompt/builder.js';
import { buildMessages } from '../src/distill/distiller.js';
import { defaultPromptConfig } from '../src/prompt/defaults.js';
import { messageToCq } from '../src/protocol/onebot.js';

const nativeKey = 'NATIVE_KEY_MUST_STAY_LOCAL';
const nativeUrl = 'https://gxh.vip.qq.com/native-image?key=URL_KEY_MUST_STAY_LOCAL';
const rawBlob = 'RAW_FACE_BLOB_MUST_STAY_LOCAL';
const records = [
  {
    time: 100, user_id: 123, sender: { nickname: '小明' },
    message: [
      { type: 'text', data: { text: '今天累了，' } },
      { type: 'mface', data: { emoji_id: '123', emoji_package_id: '456', key: nativeKey, url: nativeUrl, summary: '躺平' } },
      { type: 'text', data: { text: '想早一点休息。' } },
    ],
  },
  { time: 101, user_id: 123, message: [{ type: 'image', data: { file: 'marketface', key: nativeKey, url: nativeUrl, summary: '开心' } }] },
  { time: 102, user_id: 123, message: [{ type: 'face', data: { id: '1', raw: { content: rawBlob, url: nativeUrl } } }] },
  { time: 103, user_id: 123, raw_message: `收藏了[CQ:mface,emoji_id=123,emoji_package_id=456,key=${nativeKey},url=${nativeUrl},summary=谢谢]` },
  { time: 104, user_id: 123, raw_message: '我明天要去图书馆。' },
].map((record) => ({ ...record, raw_message: record.raw_message ?? messageToCq(record.message) }));

test('原生表情只产生可读占位，保留混合文字和摘要，不修改存储记录', () => {
  const snapshot = structuredClone(records);
  assert.equal(historyText(records[0]), '今天累了，[表情：躺平]想早一点休息。');
  assert.equal(historyText(records[1]), '[表情：开心]');
  assert.equal(historyText(records[2]), '[表情]');
  assert.equal(historyText(records[3]), '收藏了[表情：谢谢]');
  assert.equal(historyText(records[4]), '我明天要去图书馆。');
  assert.deepEqual(records, snapshot);
  assert.ok(records[0].raw_message.includes(nativeKey));
});

test('普通文字里的 CQ 字样和转义内容不会误当原生消息执行或删除', () => {
  const text = '说明文档里的 [CQ:mface,key=example] 只是例子。';
  const record = { raw_message: text, message: [{ type: 'text', data: { text } }] };
  assert.equal(historyText(record), text);
  const escaped = '这段是字面量：&#91;CQ:mface,key=example&#93;';
  assert.equal(historyText({ raw_message: escaped }), escaped);
});

test('聊天请求及检查预览不包含 native key/url/raw blob，普通用户文字仍进入上下文', () => {
  const settings = defaultPromptConfig({ historyLimit: 20, budgetBytes: 100000 });
  const built = buildChatRequest(settings, {
    persona: { character: '肥鱼', memory: '' }, records,
    event: { message_type: 'group', group_id: 1, user_id: 123, sender: { nickname: '小明' } }, text: '你好', nowMs: 200000,
  });
  const serialized = JSON.stringify(built);
  for (const secret of [nativeKey, nativeUrl, rawBlob, 'URL_KEY_MUST_STAY_LOCAL']) assert.ok(!serialized.includes(secret));
  const context = built.request.messages.map((message) => message.content).join('\n');
  assert.match(context, /今天累了，\[表情：躺平\]想早一点休息。/);
  assert.match(context, /我明天要去图书馆。/);
});

test('正式提炼和 Prompt 提炼预览共用的 buildMessages 同样不暴露原生协议参数', () => {
  const messages = buildMessages({ character: '肥鱼', memory: '' }, records, '提炼事实，上限 {maxBytes}');
  const serialized = JSON.stringify(messages);
  for (const secret of [nativeKey, nativeUrl, rawBlob, 'URL_KEY_MUST_STAY_LOCAL']) assert.ok(!serialized.includes(secret));
  assert.match(messages[1].content, /今天累了，\[表情：躺平\]想早一点休息。/);
  assert.match(messages[1].content, /我明天要去图书馆。/);
});

test('替换表情占位后仍按原消息判断图片及命令过滤', () => {
  const settings = defaultPromptConfig({ historyLimit: 20, budgetBytes: 100000 });
  settings.context.image = false;
  settings.context.excludeCommands = true;
  const built = buildChatRequest(settings, {
    persona: { character: '肥鱼', memory: '' },
    records: [
      { time: 1, raw_message: `[CQ:image,file=marketface,key=${nativeKey},url=${nativeUrl}]` },
      { time: 2, raw_message: `[CQ:at,qq=42]/meme save 躺平[CQ:mface,key=${nativeKey}]` },
    ], event: { message_type: 'private', user_id: 123 }, text: '你好', nowMs: 200000,
  });
  assert.equal(built.inspections[0].reason, '未选择图片相关消息');
  assert.equal(built.inspections[1].reason, '命令消息');
  assert.ok(!JSON.stringify(built).includes(nativeKey));
});
