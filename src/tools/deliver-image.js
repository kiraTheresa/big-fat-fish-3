import { appendMessage } from '../store/message-store.js';
import { sendGroup, sendPrivate } from '../sender/sender.js';

export function deliverGeneratedImage({ event, sessionKey }, b64, prompt) {
  appendMessage({ sessionKey, time: Math.floor(Date.now() / 1000), message_type: event.message_type,
    ...(event.group_id !== undefined ? { group_id: event.group_id } : {}), user_id: event.user_id,
    raw_message: `[图片] ${prompt}`, bot: true });
  const segments = [{ type: 'image', data: { file: `base64://${b64}` } }];
  if (event.message_type === 'group') sendGroup(event.group_id, segments);
  else sendPrivate(event.user_id, segments);
}
