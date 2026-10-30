import { parseCqMessage } from '../protocol/onebot.js';

// Native references stay in local protocol storage. Model requests and their traces
// only need a readable placeholder, never native keys, download URLs or raw blobs.
export function historyText(record) {
  const raw = typeof record.raw_message === 'string' ? record.raw_message : '';
  const segments = Array.isArray(record.message) ? record.message : parseCqMessage(raw);
  if (!segments.some((segment) => ['face', 'mface'].includes(segment?.type) || (segment?.type === 'image'
    && (segment.data?.file === 'marketface' || segment.data?.emoji_id !== undefined || segment.data?.key !== undefined)))) return raw;
  return segments.map((segment) => segment?.type === 'text' ? String(segment.data?.text ?? '')
    : segment?.type === 'at' ? `@${segment.data?.qq ?? ''}` : segment?.type === 'reply' ? '[引用消息]'
      : ['face', 'mface', 'image'].includes(segment?.type)
        ? `[表情${segment.data?.summary ? `：${String(segment.data.summary).slice(0, 100)}` : ''}]` : '[消息]').join('');
}
