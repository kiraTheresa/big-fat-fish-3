// L3 触发器：ping → pong（MVP 首个触发器，bot-core-design §4 契约的第一个实例）。
// 契约：{ name, match(event) -> boolean, handle(ctx) }——match 精确匹配（raw_message
// 去除首尾空白后全等 "ping"），命中后由 dispatcher 保证「命中即停」；
// 回复只经 ctx.reply() 交给发送层，不触碰连接层。
export default {
  name: 'ping',
  match(event) {
    return event.raw_message?.trim() === 'ping';
  },
  async handle(ctx) {
    await ctx.activateMemory?.();
    await ctx.reply('pong');
  },
};
