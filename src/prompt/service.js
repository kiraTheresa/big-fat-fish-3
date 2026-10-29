import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { readRecentMessages } from '../store/message-store.js';
import { readPersonaSnapshot, patchKeepsLockedLines } from '../store/persona-store.js';
import { readState } from '../store/session-state.js';
import { chatCompletion } from '../llm.js';
import { buildMessages, parsePatch } from '../distill/distiller.js';
import { buildChatRequest } from './builder.js';
import { runToolConversation } from './runner.js';
import { getPromptWorkspace, getPublishedPrompt, validatePromptConfig, recordPromptTest, promptError } from './store.js';
import { listRuns, readRun, saveRun, sanitizeTrace, saveRunImage, readRunImage } from './traces.js';

export function createPromptService() {
  const snapshots = new Map();
  const pending = new Set();
  const failedWrites = new Set();
  let active = false;
  let closed = false;
  async function sessions() {
    let names = [];
    try { names = await readdir(join(config.dataDir, 'messages')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { items: names.filter((n) => /^[gp]-\d{1,20}\.jsonl$/.test(n)).map((n) => n.slice(0, -6)).sort() };
  }
  async function snapshot({ sessionKey = '', scene = 'group', actorId } = {}) {
    if (sessionKey && !/^[gp]-\d{1,20}$/.test(sessionKey)) throw promptError('会话标识不正确');
    if (!['group', 'private'].includes(scene)) throw promptError('会话场景不正确');
    const records = sessionKey ? await readRecentMessages(sessionKey, 1000) : [];
    const lastUser = records.findLast((rec) => !rec.bot);
    const userId = actorId ?? (sessionKey.startsWith('p-') ? sessionKey.slice(2) : String(lastUser?.user_id ?? '1'));
    if (!/^\d{1,20}$/.test(userId)) throw promptError('测试发言者 QQ 号不正确');
    const isGroup = sessionKey ? sessionKey.startsWith('g-') : scene === 'group';
    const value = { id: randomUUID(), sessionKey: sessionKey || null, nowMs: Date.now(), records,
      persona: sessionKey ? await readPersonaSnapshot(sessionKey) : { character: null, memory: '' },
      state: sessionKey ? await readState(sessionKey) : {},
      event: { message_type: isGroup ? 'group' : 'private', user_id: userId, sender: { nickname: String(lastUser?.user_id) === userId ? lastUser?.sender?.nickname ?? userId : `测试用户 ${userId}` }, ...(isGroup ? { group_id: sessionKey?.slice(2) || '1' } : {}) } };
    snapshots.set(value.id, value);
    if (snapshots.size > 30) snapshots.delete(snapshots.keys().next().value);
    return sanitizeTrace({ ...value, records: undefined, historyCount: records.length });
  }
  function prepare(value) {
    const workspace = getPromptWorkspace();
    if (!value || !['draft', 'published'].includes(value.target ?? 'draft')) throw promptError('测试目标不正确');
    const target = value.target ?? 'draft';
    if (target === 'draft' && value.revision !== workspace.draft.revision) throw promptError('草稿已变化，请先保存或重新读取', 409);
    const chosen = target === 'published' ? workspace.published : workspace.draft;
    const settings = value.config ? validatePromptConfig(value.config) : structuredClone(chosen.config);
    const saved = snapshots.get(value.snapshotId);
    if (!saved) throw promptError('会话快照已过期，请重新载入场景', 409);
    const snap = structuredClone(saved);
    if (value.persona) {
      for (const key of ['character', 'memory']) {
        if (typeof value.persona[key] !== 'string' || value.persona[key].length > 16000) throw promptError('测试人设 / 记忆格式不正确');
      }
      snap.persona = structuredClone(value.persona);
    }
    if (typeof value.input !== 'string' || !value.input.trim() || value.input.length > 12000) throw promptError('请输入不超过 12000 字符的测试消息');
    const kind = value.kind ?? 'chat';
    if (!['chat', 'distill'].includes(kind)) throw promptError('测试类型不正确');
    snap.persona.character ??= settings.prompts.seed;
    let built;
    if (kind === 'chat') built = buildChatRequest(settings, { ...snap, text: value.input });
    else {
      const records = [...snap.records.filter((r) => r.time > (snap.state.distillMark ?? 0)), { ...snap.event, time: Math.floor(snap.nowMs / 1000), raw_message: value.input }].slice(-200);
      built = { request: { model: config.deepseekModel, messages: buildMessages(snap.persona, records, settings.prompts.distill) }, summary: { candidates: records.length, sent: records.length }, inspections: [], availability: [] };
    }
    return { settings, snap, chosen, target, kind, built };
  }
  function preview(value) {
    const prepared = prepare(value);
    return sanitizeTrace({ ...prepared.built, snapshotId: value.snapshotId, target: prepared.target });
  }
  function overrideRequest(override, original) {
    if (!override || typeof override !== 'object' || Array.isArray(override) || Object.keys(override).some((k) => !['model', 'messages', 'tools', 'stream', 'stream_options'].includes(k)) || override.model !== original.model || override.stream !== original.stream || JSON.stringify(override.stream_options) !== JSON.stringify(original.stream_options) || !Array.isArray(override.messages) || !override.messages.length || override.messages.length > 220 || JSON.stringify(override).length > 250000) throw promptError('实验 JSON 仅接受当前 model、messages、已声明的 tools 和原有流式选项');
    for (const msg of override.messages) {
      if (!msg || !['system', 'user', 'assistant', 'tool'].includes(msg.role) || !(typeof msg.content === 'string' || msg.content === null || Array.isArray(msg.content))) throw promptError('实验消息的 role / content 不正确');
    }
    if (override.tools !== undefined) {
      if (!Array.isArray(override.tools) || override.tools.length > 3) throw promptError('工具列表不正确');
      const allowed = new Set((original.tools ?? []).map((t) => t.function.name));
      if (override.tools.some((t) => t?.type !== 'function' || !allowed.has(t.function?.name))) throw promptError('实验 JSON 不能添加未启用的工具');
    }
    return structuredClone(override);
  }
  async function startTest(value) {
    if (closed) throw promptError('服务正在停止', 503);
    if (active) throw promptError('已有测试正在运行，请等待完成', 409);
    if (!config.deepseekApiKey) throw promptError('未配置聊天 API');
    if (value.config) throw promptError('请先保存草稿再运行测试');
    const prepared = prepare(value);
    const mode = value.mode ?? 'simulate';
    if (!['simulate', 'execute'].includes(mode)) throw promptError('测试工具模式不正确');
    const { settings, snap, chosen, target, kind, built } = prepared;
    const request = value.requestOverride ? overrideRequest(value.requestOverride, built.request) : built.request;
    const run = { id: randomUUID(), createdAt: Date.now(), source: 'test', status: 'running', kind, target, mode, revision: chosen.revision ?? chosen.id, version: target === 'published' ? chosen.number : null, configHash: chosen.hash, usesSeed: !snapshots.get(snap.id).persona.character && !value.persona, snapshotId: snap.id, sessionKey: snap.sessionKey, input: value.input, override: !!value.requestOverride, trace: [], summary: built.summary, inspections: built.inspections, expected: typeof value.expected === 'string' ? value.expected.slice(0, 1000) : '' };
    const metadata = () => ({ id: run.id, createdAt: run.createdAt, revision: run.revision, target, kind, mode, override: run.override, usesSeed: run.usesSeed, status: run.status });
    active = true;
    try { await saveRun(run); await recordPromptTest(metadata()); }
    catch (error) { active = false; throw error; }
    const task = (async () => {
      const memory = { value: snap.persona.memory };
      try {
        if (kind === 'chat') {
          const result = await runToolConversation(request, settings, { sessionKey: 'p-prompt-test', actorId: snap.event.user_id, speaker: snap.event.sender.nickname, mode, memory, nowMs: snap.nowMs,
            onImage: async (b64, prompt) => { const index = run.imageCount ?? 0; await saveRunImage(run.id, index, b64, prompt); run.imageCount = index + 1; } }, { trace: run.trace });
          run.content = result.content;
          run.sandboxMemory = memory.value;
          if (run.trace.some((e) => e.phase === 'tool' && !e.result?.ok)) throw new Error('存在工具失败，请检查执行过程');
        } else {
          const result = await chatCompletion(request.messages, { model: request.model, kind: 'distill', sessionKey: 'p-prompt-test', onAttempt: (entry) => run.trace.push(entry) });
          run.content = result.content;
          const patch = parsePatch(result.content);
          if (!patch || !patchKeepsLockedLines(snap.persona.memory, patch.memory) || !patchKeepsLockedLines(snap.persona.character, patch.character)) throw new Error('提炼输出格式不正确或丢失明确保存的内容');
          if (Object.values(patch).some((text) => Buffer.byteLength(text) > config.personaMaxBytes)) throw new Error('提炼结果超过人设 / 记忆大小上限');
          run.patch = patch;
        }
        run.status = 'completed';
      } catch (error) { run.status = 'failed'; run.error = error.message; }
      run.finishedAt = Date.now();
      await saveRun(run);
      await recordPromptTest(metadata());
    })().finally(() => { active = false; pending.delete(task); });
    pending.add(task);
    // Persist failures when possible, without producing an unhandled rejection on disk errors.
    task.catch(() => { failedWrites.add(run.id); });
    return { id: run.id, status: 'running' };
  }
  async function recover() {
    for (const row of (await listRuns()).items) {
      if (row.source !== 'test' || row.status !== 'running') continue;
      const run = await readRun(row.id);
      run.status = 'interrupted'; run.error = '服务重启，测试未完成；不会自动重放工具';
      await saveRun(run);
      await recordPromptTest({ id: run.id, createdAt: run.createdAt, revision: run.revision, target: run.target, kind: run.kind, mode: run.mode, override: run.override, usesSeed: run.usesSeed, status: run.status });
    }
  }
  return { sessions, snapshot, preview, startTest, readRun: async (id) => { if (failedWrites.has(id)) throw promptError('测试结果保存失败，请检查磁盘后重新测试；不会自动重放工具', 503); return readRun(id); }, listRuns, readRunImage, recover, async close() { closed = true; await Promise.allSettled([...pending]); }, isActive: () => active };
}
