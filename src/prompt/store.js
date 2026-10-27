import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteJson, readJson, withStorageLock } from '../platform/persistence.js';
import { defaultPromptConfig } from './defaults.js';

let current;
let loadedDir;
const file = () => join(config.dataDir, 'management', 'prompts.json');
export const promptError = (message, status = 400) => Object.assign(new Error(message), { status });
const defaults = () => defaultPromptConfig({ historyLimit: config.chatContextLines, budgetBytes: config.behavior.context.budgetBytes });
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const configHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validatePromptConfig(value) {
  function shape(v, template, path) {
    if (!object(v) || Object.keys(v).length !== Object.keys(template).length) throw promptError(`${path} 字段不完整或包含未知字段`);
    for (const [key, example] of Object.entries(template)) {
      if (!Object.hasOwn(v, key)) throw promptError(`${path}.${key} 缺失`);
      if (object(example)) shape(v[key], example, `${path}.${key}`);
      else if (typeof v[key] !== typeof example) throw promptError(`${path}.${key} 类型不正确`);
    }
  }
  shape(value, defaults(), '配置');
  const integer = (v, min, max, label) => { if (!Number.isSafeInteger(v) || v < min || v > max) throw promptError(`${label} 需为 ${min}–${max} 整数`); };
  for (const [key, text] of Object.entries(value.prompts)) {
    if (!text.trim() || Buffer.byteLength(text) > (key === 'seed' ? config.personaMaxBytes : 16000)) throw promptError(`${key} 不能为空或超过大小上限`);
    const allowed = key === 'scene' ? ['time', 'scene', 'silence'] : [];
    for (const match of text.matchAll(/\{\{(.*?)\}\}/g)) if (!allowed.includes(match[1])) throw promptError(`未知模板变量：${match[0]}`);
  }
  integer(value.context.historyLimit, 0, 200, '历史条数');
  integer(value.context.budgetBytes, 512, 1000000, '上下文字节预算');
  integer(value.context.maxAgeMinutes, 0, 525600, '历史时间范围');
  integer(value.execution.maxToolRounds, 1, 5, '工具轮数');
  integer(value.execution.maxToolCalls, 1, 8, '工具次数');
  for (const tool of Object.values(value.tools)) {
    if (!tool.description.trim() || tool.description.length > 2000 || tool.parameterDescription.length > 1000) throw promptError('工具说明为空或过长');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 60000) throw promptError('配置总大小不能超过 60 KB');
  return structuredClone(value);
}
function builtin() {
  const value = defaults();
  return { id: 'builtin', number: 0, createdAt: null, config: value, hash: configHash(value), note: '内置默认配置' };
}
export function getPublishedPrompt() {
  return structuredClone(loadedDir === config.dataDir && current ? current.published : builtin());
}
export function getPromptConfig() { return getPublishedPrompt().config; }
export async function initializePrompts() {
  const saved = await readJson(file(), null);
  if (saved) {
    if (saved.schema !== 1 || !saved.published || !saved.draft || !Array.isArray(saved.versions)) throw new Error('Prompt 版本文件不正确');
    validatePromptConfig(saved.published.config);
    validatePromptConfig(saved.draft.config);
    for (const version of saved.versions) validatePromptConfig(version.config);
    current = saved;
  } else {
    const published = builtin();
    current = { schema: 1, published, versions: [published], draft: { revision: randomUUID(), baseId: published.id, config: published.config, hash: published.hash, updatedAt: Date.now() }, tests: [] };
    await atomicWriteJson(file(), current);
  }
  loadedDir = config.dataDir;
  return getPromptWorkspace();
}
export function getPromptWorkspace() {
  if (loadedDir !== config.dataDir || !current) throw promptError('Prompt 服务尚未初始化', 503);
  return structuredClone(current);
}
async function change(fn) {
  return withStorageLock(`${file()}.transaction`, async () => {
    const next = getPromptWorkspace();
    const result = await fn(next);
    await atomicWriteJson(file(), next);
    current = next;
    return structuredClone(result ?? next);
  });
}
function checkRevision(next, revision) {
  if (revision !== next.draft.revision) throw promptError('草稿已变化，请重新读取；本页修改尚未保存', 409);
}
export async function savePromptDraft({ revision, config: value }) {
  const checked = validatePromptConfig(value);
  return change((next) => {
    checkRevision(next, revision);
    if (configHash(checked) === next.draft.hash) return;
    next.draft = { revision: randomUUID(), baseId: next.published.id, config: checked, hash: configHash(checked), updatedAt: Date.now() };
  });
}
export async function restorePromptVersion({ revision, versionId }) {
  return change((next) => {
    checkRevision(next, revision);
    const version = next.versions.find((v) => v.id === versionId);
    if (!version) throw promptError('版本不存在', 404);
    next.draft = { revision: randomUUID(), baseId: next.published.id, config: structuredClone(version.config), hash: version.hash, updatedAt: Date.now() };
  });
}
export async function recordPromptTest(record) {
  return change((next) => {
    next.tests = [record, ...next.tests.filter((t) => t.id !== record.id)].slice(0, 50);
    return record;
  });
}
export async function reviewPromptTest({ id, revision, passed, note = '' }) {
  if (typeof passed !== 'boolean' || typeof note !== 'string' || note.length > 1000) throw promptError('测试评审格式不正确');
  return change((next) => {
    checkRevision(next, revision);
    const test = next.tests.find((t) => t.id === id);
    if (!test || test.revision !== revision || test.status !== 'completed' || test.override || test.target !== 'draft') throw promptError('仅当前草稿正常完成的原始请求测试可评审', 409);
    test.review = { passed, note, at: Date.now() };
  });
}
export async function publishPromptDraft({ revision, note = '' }) {
  if (typeof note !== 'string' || note.length > 1000) throw promptError('发布说明过长');
  return change((next) => {
    checkRevision(next, revision);
    if (next.draft.baseId !== next.published.id) throw promptError('发布基线发生变化，请重新保存草稿并测试', 409);
    const accepted = next.tests.filter((t) => t.revision === revision && t.status === 'completed' && t.target === 'draft' && !t.override && t.review?.passed);
    const old = next.published.config;
    const draft = next.draft.config;
    const chatChanged = JSON.stringify({ ...old, prompts: { ...old.prompts, distill: '' } }) !== JSON.stringify({ ...draft, prompts: { ...draft.prompts, distill: '' } });
    const distillChanged = old.prompts.distill !== draft.prompts.distill;
    if (old.prompts.seed !== draft.prompts.seed && !accepted.some((t) => t.kind === 'chat' && t.usesSeed)) throw promptError('初始人设已修改，请用全新会话场景测试并评审通过', 409);
    if (!accepted.length || ((chatChanged || !distillChanged) && !accepted.some((t) => t.kind === 'chat')) || (distillChanged && !accepted.some((t) => t.kind === 'distill'))) throw promptError('请先运行并评审通过当前草稿的相关测试（聊天 / 记忆提炼）', 409);
    const version = { id: randomUUID(), number: next.published.number + 1, createdAt: Date.now(), config: draft, hash: next.draft.hash, note, tests: accepted.map((t) => t.id) };
    next.published = version;
    next.versions = [...next.versions, version].slice(-50);
    next.draft = { revision: randomUUID(), baseId: version.id, config: structuredClone(draft), hash: version.hash, updatedAt: Date.now() };
  });
}
