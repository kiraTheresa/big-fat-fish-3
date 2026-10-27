// OneBot 11 reception boundary. Unknown implementation extensions are data, never actions.
// Sources and accepted types: docs/onebot-reception.md.
export const STANDARD_SEGMENT_TYPES = Object.freeze([
  'text', 'face', 'image', 'record', 'video', 'at', 'rps', 'dice', 'shake',
  'poke', 'anonymous', 'share', 'contact', 'location', 'music', 'reply',
  'forward', 'node', 'xml', 'json',
]);
export const STANDARD_POST_TYPES = Object.freeze(['message', 'notice', 'request', 'meta_event']);
const PROCESSABLE_SEGMENTS = new Set(['text', 'at', 'reply', 'image']);
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  || (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value));

// Decode once, after tokenization: escaped literal CQ code must remain text.
export function decodeCq(value, parameter = false) {
  let text = value.replaceAll('&#91;', '[').replaceAll('&#93;', ']');
  if (parameter) text = text.replaceAll('&#44;', ',');
  return text.replaceAll('&amp;', '&');
}
function encodeCq(value, parameter = false) {
  let text = String(value).replaceAll('&', '&amp;').replaceAll('[', '&#91;').replaceAll(']', '&#93;');
  if (parameter) text = text.replaceAll(',', '&#44;');
  return text;
}

export function parseCqMessage(input) {
  if (typeof input !== 'string') return [];
  const segments = [];
  const code = /\[CQ:([^,\[\]\s]+)((?:,[^\[\]]*)?)\]/g;
  let cursor = 0;
  const text = (value) => {
    if (!value) return;
    const decoded = decodeCq(value);
    const previous = segments.at(-1);
    if (previous?.type === 'text') previous.data.text += decoded;
    else segments.push({ type: 'text', data: { text: decoded } });
  };
  for (const match of input.matchAll(code)) {
    text(input.slice(cursor, match.index));
    const entries = [];
    let valid = true;
    for (const field of match[2] ? match[2].slice(1).split(',') : []) {
      const split = field.indexOf('=');
      const key = field.slice(0, split);
      if (split < 1 || /[\s&]/.test(key) || entries.some(([existing]) => existing === key)) {
        valid = false;
        break;
      }
      entries.push([key, decodeCq(field.slice(split + 1), true)]);
    }
    if (valid) segments.push({ type: match[1], data: Object.fromEntries(entries) });
    else text(match[0]); // malformed CQ code is literal text, preserved in raw event as well
    cursor = match.index + match[0].length;
  }
  text(input.slice(cursor));
  return segments;
}

export function messageToCq(segments) {
  return segments.map((segment) => {
    if (!plainObject(segment) || typeof segment.type !== 'string' || !plainObject(segment.data)) return '';
    if (segment.type === 'text') return encodeCq(segment.data.text ?? '');
    const params = Object.entries(segment.data).map(([key, value]) =>
      `,${key}=${encodeCq(plainObject(value) || Array.isArray(value) ? JSON.stringify(value) : value, true)}`);
    return `[CQ:${segment.type}${params.join('')}]`;
  }).join('');
}

export function getEventSessionKey(event) {
  if (event?.message_type === 'private') return validId(event.user_id) ? `p-${event.user_id}` : null;
  if (validId(event?.group_id)) return `g-${event.group_id}`;
  if (validId(event?.user_id)) return `p-${event.user_id}`;
  return null;
}

// Return null only for non-event envelopes. Malformed events still enter the inbox,
// but cannot enter the trigger chain or create unsafe chat-history paths.
export function normalizeOneBotEvent(input) {
  if (!plainObject(input) || typeof input.post_type !== 'string' || input.post_type.trim() === '') return null;
  const event = structuredClone(input);
  const issues = [];
  const messageEvent = ['message', 'message_sent'].includes(event.post_type);
  const sessionKey = getEventSessionKey(event);
  let segments = [];
  if (messageEvent) {
    const source = event.message ?? event.raw_message;
    if (typeof source === 'string') segments = parseCqMessage(source);
    else if (Array.isArray(source)) {
      segments = source.filter((segment) => {
        const valid = plainObject(segment) && typeof segment.type === 'string' && segment.type !== '' && plainObject(segment.data);
        if (!valid) issues.push('invalid_message_segment');
        return valid;
      });
    } else issues.push('missing_message');
    if (segments.length === 0) issues.push('empty_message');
    if (!['group', 'private'].includes(event.message_type)) issues.push('unknown_message_type');
    if (!validId(event.user_id)) issues.push('invalid_user_id');
    if (event.message_type === 'group' && !validId(event.group_id)) issues.push('invalid_group_id');
    if (segments.some((segment) => segment.type === 'text' && typeof segment.data.text !== 'string')) issues.push('invalid_text');
    event.message = segments;
    if (typeof event.raw_message !== 'string') event.raw_message = typeof source === 'string' ? source : messageToCq(segments);
  }
  const messageTypes = [...new Set(segments.map((segment) => segment.type))];
  const unsupported = messageTypes.some((type) => !PROCESSABLE_SEGMENTS.has(type));
  const knownSubtype = event.sub_type === undefined || (event.message_type === 'group'
    ? ['normal', 'anonymous'].includes(event.sub_type)
    : ['friend', 'group', 'other'].includes(event.sub_type));
  const processable = event.post_type === 'message' && issues.length === 0 && !unsupported && knownSubtype;
  return {
    event, sessionKey, segments, messageTypes, issues: [...new Set(issues)], processable,
    postType: event.post_type,
    eventType: event.message_type ?? event.notice_type ?? event.request_type ?? event.meta_event_type ?? event.post_type,
    subType: event.sub_type ?? null,
    handling: processable ? 'trigger_eligible' : issues.length ? 'malformed' : 'received_only',
  };
}
