// Persistent declared jobs, not arbitrary executable code. One job at a time.
// Claim is saved before execution: after a crash an interrupted run is never replayed.
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson, readJson, withStorageLock } from './persistence.js';

export class Scheduler {
  constructor({ dataDir, handlers, clock = Date.now }) {
    this.file = join(dataDir, 'management', 'jobs.json');
    this.handlers = handlers;
    this.clock = clock;
    this.jobs = [];
    this.timer = null;
    this.active = null;
    this.running = false;
    this.lastError = null;
  }
  validate(input) {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new Error('任务名称需为 1–80 字符');
    if (!Object.hasOwn(this.handlers, input.type)) throw new Error('不支持的任务类型');
    if (typeof input.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
    const s = input.schedule;
    if (s?.kind === 'interval') {
      if (!Number.isSafeInteger(s.everyMs) || s.everyMs < 1000 || s.everyMs > 31536000000) throw new Error('间隔需为 1 秒到 365 天');
      return { name: input.name.trim(), type: input.type, enabled: input.enabled, schedule: { kind: 'interval', everyMs: s.everyMs } };
    }
    if (s?.kind === 'once' && typeof s.at === 'string' && Number.isFinite(Date.parse(s.at))) return { name: input.name.trim(), type: input.type, enabled: input.enabled, schedule: { kind: 'once', at: new Date(s.at).toISOString() } };
    throw new Error('调度需为 interval 或有效的 once 时间');
  }
  next(schedule) { return schedule.kind === 'once' ? Date.parse(schedule.at) : this.clock() + schedule.everyMs; }
  async initialize(defaults = [], previousDefaults = []) {
    const stored = await readJson(this.file, { version: 1, items: defaults.map((input) => ({ ...this.validate(input), id: randomUUID(), nextRunAt: this.next(input.schedule) })) });
    if (stored.version !== 1 || !Array.isArray(stored.items)) throw new Error('任务文件格式不正确');
    const ids = new Set();
    this.jobs = stored.items.map((job) => {
      this.validate(job);
      if (typeof job.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(job.id) || ids.has(job.id) || !Number.isFinite(job.nextRunAt)) throw new Error('任务记录格式不正确');
      ids.add(job.id);
      // Seeded jobs have no createdAt/updatedAt. Preserve all user-created or
      // edited jobs, including disabled jobs; only migrate untouched defaults.
      const previous = previousDefaults.find((item) => item.name === job.name && item.type === job.type
        && item.schedule.kind === job.schedule.kind && item.schedule.everyMs === job.schedule.everyMs);
      const replacement = defaults.find((item) => item.name === job.name && item.type === job.type);
      if (job.createdAt === undefined && job.updatedAt === undefined && previous && replacement
        && JSON.stringify(job.schedule) !== JSON.stringify(replacement.schedule)) {
        job = { ...job, schedule: structuredClone(replacement.schedule), nextRunAt: this.next(replacement.schedule) };
      }
      if (job.lastStatus === 'running') return { ...job, lastStatus: 'interrupted', lastError: '上次进程在任务运行期间停止；本次不重放' };
      return job;
    });
    await this.save(this.jobs);
  }
  async save(items) { await atomicWriteJson(this.file, { version: 1, items }); }
  list() { return { items: structuredClone(this.jobs) }; }
  status() { return { running: this.running, jobs: this.jobs.length, activeJobId: this.activeId ?? null, lastError: this.lastError }; }
  change(fn) {
    return withStorageLock(`${this.file}.transaction`, async () => {
      const next = structuredClone(this.jobs);
      const result = fn(next);
      await this.save(next);
      this.jobs = next;
      return result;
    });
  }
  async create(input) {
    const value = this.validate(input);
    if (value.schedule.kind === 'once' && this.next(value.schedule) <= this.clock()) throw new Error('单次任务时间需在未来');
    return this.change((next) => {
      if (next.length >= 100) throw new Error('最多 100 个任务');
      const job = { ...value, id: randomUUID(), createdAt: this.clock(), nextRunAt: this.next(value.schedule) };
      next.push(job);
      return job;
    });
  }
  async update(id, input) {
    const value = this.validate(input);
    return this.change((next) => {
      const index = next.findIndex((job) => job.id === id);
      if (index < 0) throw Object.assign(new Error('任务不存在'), { status: 404 });
      if (this.activeId === id) throw Object.assign(new Error('任务正在执行，请完成后修改'), { status: 409 });
      if (value.enabled && value.schedule.kind === 'once' && this.next(value.schedule) <= this.clock()) throw new Error('单次任务时间需在未来');
      return (next[index] = { ...next[index], ...value, updatedAt: this.clock(), nextRunAt: this.next(value.schedule) });
    });
  }
  async remove(id) {
    return this.change((next) => {
      if (this.activeId === id) throw Object.assign(new Error('任务正在执行，请完成后删除'), { status: 409 });
      const index = next.findIndex((job) => job.id === id);
      if (index < 0) throw Object.assign(new Error('任务不存在'), { status: 404 });
      next.splice(index, 1);
      return { ok: true };
    });
  }
  async runDue() {
    if (this.active) return this.active;
    this.active = this.executeDue().finally(() => { this.active = null; this.activeId = null; });
    return this.active;
  }
  async executeDue() {
    if (!this.jobs.some((job) => job.enabled && job.nextRunAt <= this.clock())) return;
    let claimed;
    await this.change((next) => {
      const job = next.filter((item) => item.enabled && item.nextRunAt <= this.clock()).sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
      if (!job) return;
      claimed = structuredClone(job);
      this.activeId = job.id;
      job.lastRunAt = this.clock();
      job.lastStatus = 'running';
      job.lastError = null;
      if (job.schedule.kind === 'once') job.enabled = false;
      else job.nextRunAt = this.clock() + job.schedule.everyMs; // skip missed ticks, never backfill a burst
    });
    if (!claimed) return;
    let status = 'success';
    let error = null;
    try { await this.handlers[claimed.type](claimed); }
    catch (err) { status = 'failed'; error = String(err.message).slice(0, 500); }
    await this.change((next) => {
      const job = next.find((item) => item.id === claimed.id);
      if (job) {
        job.lastStatus = status; job.lastError = error; job.finishedAt = this.clock();
        if (job.schedule.kind === 'interval') job.nextRunAt = this.clock() + job.schedule.everyMs;
      }
    });
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => { this.runDue().catch((err) => { this.lastError = err.code ?? '任务存储或执行失败'; }); }, 1000);
    this.timer.unref();
  }
  async stop() { this.running = false; clearInterval(this.timer); this.timer = null; await this.active; }
}
