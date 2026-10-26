// QQ roles govern bot actions. Web management uses a separate administrator token.
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteJson, readJson, withStorageLock } from './persistence.js';

let users = {};
const path = () => join(config.dataDir, 'management', 'users.json');
const validId = (id) => typeof id === 'string' && /^\d{1,20}$/.test(id);
export async function initializePermissions() {
  const stored = await readJson(path(), { version: 1, users: {} });
  if (stored.version !== 1 || !stored.users || typeof stored.users !== 'object' || Array.isArray(stored.users)) throw new Error('用户权限文件格式不正确');
  for (const [id, user] of Object.entries(stored.users)) {
    if (!validId(id) || !['user', 'admin', 'blocked'].includes(user.role)) throw new Error('用户权限记录格式不正确');
  }
  users = stored.users;
}
export function getRole(id) {
  const key = String(id);
  return users[key]?.source === 'management' ? users[key].role : (config.adminQq.includes(key) ? 'admin' : 'user');
}
export function canUseBot(event) { return getRole(event.user_id) !== 'blocked'; }
export function canManageSession(event) {
  if (!canUseBot(event)) return false;
  // A private conversation belongs to its sender; group-wide destructive commands need admin.
  return event.message_type === 'private' || getRole(event.user_id) === 'admin';
}
export function listUsers() {
  const items = { ...users };
  for (const id of config.adminQq) if (!items[id]) items[id] = { id, role: 'admin', note: '', source: 'environment' };
  return { items: Object.values(items).map((user) => ({ ...user, role: getRole(user.id) })).sort((a, b) => (b.lastSeenAt ?? b.updatedAt ?? 0) - (a.lastSeenAt ?? a.updatedAt ?? 0)), defaults: { draw: 'allow', role: 'user' } };
}
async function change(fn) {
  return withStorageLock(`${path()}.transaction`, async () => {
    const next = structuredClone(users);
    const result = fn(next);
    await atomicWriteJson(path(), { version: 1, users: next });
    users = next;
    return result;
  });
}
export async function observeUser(event) {
  const id = String(event.user_id);
  if (!validId(id)) return;
  const last = users[id];
  if (last && Date.now() - (last.lastSeenAt ?? 0) < 60000) return;
  return change((next) => {
    next[id] = { id, role: 'user', source: 'observed', note: '', ...next[id], nickname: String(event.sender?.nickname ?? next[id]?.nickname ?? '').slice(0, 100), lastSeenAt: Date.now() };
  });
}
export function setUser(id, value) {
  if (!validId(id)) throw new Error('QQ 号需为 1–20 位数字');
  if (!value || !['user', 'admin', 'blocked'].includes(value.role) || typeof (value.note ?? '') !== 'string' || (value.note ?? '').length > 300) throw new Error('角色或备注格式不正确');
  return change((next) => (next[id] = { ...next[id], id, role: value.role, note: value.note ?? '', updatedAt: Date.now(), source: 'management' }));
}
export function deleteUser(id) {
  if (!validId(id)) throw new Error('QQ 号格式不正确');
  return change((next) => { delete next[id]; return { ok: true, effectiveRole: config.adminQq.includes(id) ? 'admin' : 'user' }; });
}
