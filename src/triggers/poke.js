import { config } from '../config.js';
import { isBotPoke } from '../protocol/onebot.js';
import chat from './chat.js';

export default {
  name: 'poke',
  match(event) {
    return isBotPoke(event);
  },
  async handle(ctx) {
    if (!config.behavior.trigger.poke.enabled || config.deepseekApiKey === '') return;
    // 通知没有可引用的消息 ID；原始事件仍由收件箱保留。
    const event = { ...ctx.event, message_type: ctx.event.group_id === undefined ? 'private' : 'group' };
    delete event.message_id;
    await chat.handle({ ...ctx, event }, { poke: true });
  },
};
