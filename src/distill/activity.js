// Persist eligible group-chat windows. Sleeping groups are absent from the
// in-memory scan set; only a valid invocation can add them again.
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../config.js';
import { readState, updateState } from '../store/session-state.js';
import { readMessagesSince } from '../store/message-store.js';
import { withStorageLock } from '../platform/persistence.js';

const registries = new Map();
export async function initializeMemoryActivity() {
  const root = resolve(config.dataDir);
  const groups = new Set();
  const loading = (async () => {
    let files;
    try { files = await readdir(join(root, 'session-state')); }
    catch (err) { if (err.code === 'ENOENT') return groups; throw err; }
    for (const file of files) {
      if (!/^g-[A-Za-z0-9_-]{1,64}\.json$/.test(file)) continue;
      const key = file.slice(0, -5);
      const { memoryActivity: activity } = await readState(key);
      if (activity?.lastInvokedAt && !activity.sleeping) groups.add(key);
    }
    return groups;
  })();
  registries.set(root, loading);
  try { return await loading; }
  catch (err) { registries.delete(root); throw err; }
}
const registry = () => registries.get(resolve(config.dataDir)) ?? initializeMemoryActivity();
export async function activeMemoryGroups() { return [...await registry()]; }
const lock = (key, fn) => withStorageLock(join(config.dataDir, 'session-state', `${key}.activity`), fn);
export const receiptTime = (row) => row.receivedAt ?? row.time * 1000;
const receiptId = (row) => row.recordId ?? JSON.stringify(row);
const deadline = (activity) => activity.lastInvokedAt + config.distillIdleMs;

function closedWindows(activity, now) {
  return (activity?.windows ?? []).map((window) => window.to === null && now >= deadline(activity)
    ? { ...window, to: deadline(activity) } : window);
}

export async function markMemoryInvocation(key, receivedAt = Date.now(), now = Date.now()) {
  if (!/^g-[A-Za-z0-9_-]{1,64}$/.test(key)) return;
  const groups = await registry();
  return lock(key, async () => {
    const ok = await updateState(key, (state) => {
      const old = state.memoryActivity;
      const windows = closedWindows(old, now);
      if (!old || old.sleeping || now >= deadline(old)) windows.push({ from: receivedAt, to: null });
      return { memoryActivity: { lastInvokedAt: now, sleeping: false, windows } };
    });
    if (ok) groups.add(key);
  });
}

// Close and persist before the final model attempt. A failed attempt (or crash)
// must not keep waking a group. Windows remain available for its next invocation.
export async function prepareMemoryScan(key, now = Date.now()) {
  const groups = await registry();
  return lock(key, async () => {
    let state = await readState(key);
    const activity = state.memoryActivity;
    if (!activity || activity.sleeping) { groups.delete(key); return null; }
    const closing = now >= deadline(activity);
    if (closing) {
      const next = { ...activity, windows: closedWindows(activity, now), sleeping: true };
      if (!await updateState(key, { memoryActivity: next })) return null;
      state = { ...state, memoryActivity: next };
      groups.delete(key);
    }
    return { state, closing };
  });
}

export function eligibleMemoryMessage(row, state) {
  const time = receiptTime(row);
  const mark = state.distillReceiptAt ?? 0;
  if (time < mark || (time === mark && (state.distillReceiptIds ?? []).includes(receiptId(row)))) return false;
  const activity = state.memoryActivity;
  return (activity?.windows ?? []).some((window) => time >= window.from && time < (window.to ?? deadline(activity)));
}

export function readMemoryMessages(key, state, limit = 100) {
  return key.startsWith('g-')
    ? readMessagesSince(key, 0, limit, (row) => eligibleMemoryMessage(row, state), { oldest: true })
    : readMessagesSince(key, state.distillMark ?? 0, limit);
}

// Merge against the latest state: an invocation may arrive while the model is
// running. Never overwrite its new window or lastInvokedAt with the old snapshot.
export function receiptProgress(state, rows) {
  if (!state.memoryActivity) return {};
  const at = Math.max(state.distillReceiptAt ?? 0, ...rows.map(receiptTime));
  const ids = new Set(at === state.distillReceiptAt ? state.distillReceiptIds : []);
  for (const row of rows) if (receiptTime(row) === at) ids.add(receiptId(row));
  return {
    distillReceiptAt: at, distillReceiptIds: [...ids],
    memoryActivity: { ...state.memoryActivity, windows: state.memoryActivity.windows.filter((window) => window.to === null || window.to > at) },
  };
}
