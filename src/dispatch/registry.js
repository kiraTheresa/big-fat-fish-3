// 触发器注册表：加功能 = 加文件 + register 一行，分发器不写业务 if-else
// 契约：{ name: string, match(event) -> boolean, handle(ctx) -> void|Promise }
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
