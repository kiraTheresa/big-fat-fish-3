// 触发器注册表：加功能 = 加触发器文件 + register 一行（bot-core-design §4）。
// 契约：{ name: string, match(event) -> boolean, handle(ctx) -> void|Promise }
// 分发器只读本表选择触发器，永不出现业务 if-else；重名注册视为装配错误，直接抛错。
const triggers = [];

export function register(trigger) {
  if (triggers.some((t) => t.name === trigger.name)) {
    throw new Error(`触发器重名: ${trigger.name}`);
  }
  triggers.push(trigger);
}

export function getTriggers() {
  return triggers;
}
