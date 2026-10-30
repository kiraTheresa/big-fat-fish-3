import { parseCqMessage } from '../protocol/onebot.js';

const segments = (event) => Array.isArray(event.message) ? event.message : parseCqMessage(event.message ?? event.raw_message ?? '');
const candidates = (event) => segments(event).filter((segment) => ['image', 'mface', 'face'].includes(segment?.type));

// Supply only structural facts to the model. Native keys, image URLs and the
// quoted message's instructions stay out of the current user's request.
export function describeMemeSource(event, records = []) {
  const own = candidates(event);
  if (own.length) return `当前用户消息附带 ${own.length} 个图片或表情候选。`;
  const replies = segments(event).filter((segment) => segment?.type === 'reply');
  if (replies.length !== 1 || !replies[0].data?.id) return '';
  const source = records.find((record) => String(record.message_id) === String(replies[0].data.id));
  if (!source) return '当前用户引用了一条消息；收藏工具会核实它是否属于当前会话、是否含有可收藏表情。';
  if (source.bot && source.memeId) return '当前用户引用了本鱼已发送的一个收藏表情。';
  const count = candidates(source).length;
  return count ? `当前用户引用的消息含 ${count} 个图片或表情候选。` : '当前用户引用的消息没有图片或表情候选。';
}
