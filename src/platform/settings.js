// Boot secrets remain in .env; validated live settings have a persisted revision.
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, DEFAULT_BEHAVIOR } from '../config.js';
import { atomicWriteJson, readJson, withStorageLock } from './persistence.js';

export const DEFAULT_POLICY = { features: { chat: true, vision: true, draw: true, distill: true }, limits: { maxCallsPerDay: 0, maxTokensPerDay: 0 } };
let current;
let onChange = () => {};
const path = () => join(config.dataDir, 'management', 'settings.json');
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
function checkShape(value, template, at) {
  if (!object(value)) throw new Error(`${at} 必须是对象`);
  for (const key of Object.keys(value)) if (!(key in template) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`${at}.${key} 不支持`);
  for (const [key, example] of Object.entries(template)) {
    const next = value[key];
    if (object(example)) checkShape(next, example, `${at}.${key}`);
    else if (Array.isArray(example)) {
      if (!Array.isArray(next) || next.length > 30 || next.some((v) => typeof v !== 'string' || !v.trim() || v.length > 80)) throw new Error(`${at}.${key} 需要最多 30 个非空短文本`);
    } else if (typeof next !== typeof example) throw new Error(`${at}.${key} 类型不正确`);
  }
}
function integer(value, min, max, name) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 需为 ${min}–${max} 的整数`); }
export function validateSettings(behavior, policy) {
  checkShape(behavior, DEFAULT_BEHAVIOR, 'behavior');
  checkShape(policy, DEFAULT_POLICY, 'policy');
  integer(behavior.reply.delay.minMs, 0, 60000, '最短延迟');
  integer(behavior.reply.delay.maxMs, behavior.reply.delay.minMs, 60000, '最长延迟');
  if (behavior.reply.split.separator.length > 20) throw new Error('分段符最多 20 字符（留空则仅按换行分段）');
  integer(behavior.context.budgetBytes, 512, 1000000, '上下文字节预算');
  integer(policy.limits.maxCallsPerDay, 0, 1000000, '每日调用上限');
  integer(policy.limits.maxTokensPerDay, 0, 1000000000, '每日 token 上限');
}
export async function initializeSettings(listener = () => {}) {
  onChange = listener;
  const saved = await readJson(path(), null);
  if (saved) {
    if (saved.version !== 1 || typeof saved.revision !== 'string') throw new Error('管理配置版本不正确');
    validateSettings(saved.behavior, saved.policy);
    current = saved;
  } else {
    validateSettings(config.behavior, DEFAULT_POLICY);
    current = { version: 1, revision: randomUUID(), behavior: structuredClone(config.behavior), policy: structuredClone(DEFAULT_POLICY) };
  }
  config.behavior = structuredClone(current.behavior);
  onChange(structuredClone(current.policy));
  return getSettings();
}
export function getSettings() {
  return {
    revision: current.revision, behavior: structuredClone(current.behavior), policy: structuredClone(current.policy),
    connection: { wsUrl: safeUrl(config.wsUrl), model: config.deepseekModel, visionModel: config.deepseekVisionModel, imageModel: config.imageModel, imageSize: config.imageSize, imageApiBaseUrl: safeUrl(config.imageApiBaseUrl), deepseekBaseUrl: safeUrl(config.deepseekBaseUrl) },
    capabilities: { chatConfigured: !!config.deepseekApiKey, drawConfigured: !!config.imageApiKey, secretsEditable: false, hotReload: true },
  };
}
export function safeUrl(value) {
  try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return '[invalid URL]'; }
}
export async function updateSettings(value) {
  if (!object(value)) throw new Error('配置必须是对象');
  validateSettings(value.behavior, value.policy);
  return withStorageLock(`${path()}.transaction`, async () => {
    if (value.revision !== current.revision) { const err = new Error('配置已被另一页面修改，请刷新后重新编辑'); err.status = 409; throw err; }
    const next = { version: 1, revision: randomUUID(), behavior: structuredClone(value.behavior), policy: structuredClone(value.policy), updatedAt: Date.now() };
    await atomicWriteJson(path(), next);
    current = next;
    config.behavior = structuredClone(next.behavior);
    onChange(structuredClone(next.policy));
    return getSettings();
  });
}
