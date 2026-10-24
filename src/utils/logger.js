const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

export const logger = {
  info: (...args) => console.log(`[${ts()}] INFO `, ...args),
  warn: (...args) => console.warn(`[${ts()}] WARN `, ...args),
  error: (...args) => console.error(`[${ts()}] ERROR`, ...args),
};
