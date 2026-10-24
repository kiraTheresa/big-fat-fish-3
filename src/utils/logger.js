// 统一日志格式：[HH:mm:ss] LEVEL 消息（spec「可观测性」要求）
// 三级日志均经 console.log 输出，便于测试与 E2E 统一捕获 stdout
function log(level, args) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${time}] ${level} ${args.join(' ')}`);
}

export const logger = {
  info(...args) {
    log('INFO', args);
  },
  warn(...args) {
    log('WARN', args);
  },
  error(...args) {
    log('ERROR', args);
  },
};
