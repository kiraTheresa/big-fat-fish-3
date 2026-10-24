// 触发器示例：ping → pong（连通性验证）
export default {
  name: 'ping',
  match: (event) => event.raw_message?.trim() === 'ping',
  async handle(ctx) {
    await ctx.reply('pong');
  },
};
