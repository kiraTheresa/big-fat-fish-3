// Composition of shared platform services. Boot secrets never appear in management JSON.
import { config } from '../config.js';
import { configureLogger, logger, readLogs, flushLogs, getLogStats } from '../utils/logger.js';
import { getConnectionStatus } from '../connection/onebot.js';
import { getSenderStatus } from '../sender/sender.js';
import { flushMessageStore } from '../store/message-store.js';
import { initializeMediaStore } from '../store/media-store.js';
import { readEvents, getEventStats, flushEventStore } from '../store/event-store.js';
import { readUsageOverview, flushUsage, getUsageStoreStats } from '../store/usage-store.js';
import { setUsagePolicy, initializeUsage, readUsageMonitor } from './usage-policy.js';
import { initializeSettings, getSettings, updateSettings } from './settings.js';
import { initializePermissions, listUsers, setUser, deleteUser } from './permissions.js';
import { Scheduler } from './scheduler.js';
import { pruneObservations } from './maintenance.js';
import { getPersistenceStatus, flushPersistence } from './persistence.js';
import { scanOnce } from '../distill/distiller.js';
import { initializeMemoryActivity } from '../distill/activity.js';
import { startAdminServer } from '../admin/server.js';
import { acquireRuntimeLock } from './runtime-lock.js';
import { initializePrompts, getPromptWorkspace, savePromptDraft, restorePromptVersion, reviewPromptTest, publishPromptDraft } from '../prompt/store.js';
import { createPromptService } from '../prompt/service.js';

export async function startPlatform({ admin = true, schedule = true } = {}) {
  const releaseLock = await acquireRuntimeLock(config.dataDir);
  try {
    const startedAt = Date.now();
    configureLogger({ dataDir: config.dataDir, level: config.logLevel, retentionDays: config.retentionDays, secrets: [config.accessToken, config.deepseekApiKey, config.imageApiKey, config.adminToken] });
    await initializeMediaStore();
    await initializeSettings(setUsagePolicy);
    await initializePermissions();
    await initializeUsage();
    await initializePrompts();
    await initializeMemoryActivity();
    const prompt = createPromptService();
    await prompt.recover();
    const scheduler = new Scheduler({ dataDir: config.dataDir, handlers: {
      maintenance: async () => { const result = await pruneObservations(config.dataDir, config.retentionDays); logger.info('[scheduler] 观察数据清理完成', result); },
      distill: async () => {
        if (!config.deepseekApiKey || !getSettings().policy.features.distill) return;
        await scanOnce();
      },
    } });
    await scheduler.initialize([
      { name: '记忆提炼扫描', type: 'distill', enabled: !!config.deepseekApiKey, schedule: { kind: 'interval', everyMs: Math.max(1000, config.distillIntervalMs) } },
      { name: '观察数据保留清理', type: 'maintenance', enabled: true, schedule: { kind: 'interval', everyMs: 21600000 } },
    ], [
      { name: '记忆提炼扫描', type: 'distill', schedule: { kind: 'interval', everyMs: 60000 } },
      { name: '观察数据保留清理', type: 'maintenance', schedule: { kind: 'interval', everyMs: 86400000 } },
    ]);
    const services = {
      prompt: { ...prompt, workspace: getPromptWorkspace, saveDraft: savePromptDraft, restore: restorePromptVersion, review: reviewPromptTest, publish: publishPromptDraft },
      getSettings,
      updateSettings: async (value) => { const result = await updateSettings(value); logger.info('[admin] 行为配置与用量策略已保存', { revision: result.revision }); return result; },
      listUsers,
      setUser: async (id, value) => { const result = await setUser(id, value); logger.info('[admin] 用户权限已修改', { id, role: result.role }); return result; },
      deleteUser: async (id) => { const result = await deleteUser(id); logger.info('[admin] 用户恢复默认权限', { id }); return result; },
      scheduler,
      readEvents,
      readLogs: async (query) => { const items = await readLogs(query); return { items, nextCursor: items.length >= (query.limit ?? 100) ? items.at(-1).cursor : null }; },
      readUsageOverview,
      status: async () => ({
        startedAt, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        connection: getConnectionStatus(), sender: getSenderStatus(), events: getEventStats(),
        storage: { dataDir: config.dataDir, ...getPersistenceStatus(), usage: getUsageStoreStats() },
        scheduler: scheduler.status(), usage: await readUsageMonitor(), logStats: getLogStats(),
        memory: { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed },
      }),
    };
    let management;
    if (admin && config.adminToken) {
      management = await startAdminServer({ host: config.adminHost, port: config.adminPort, token: config.adminToken, services });
      logger.info(`管理网站已启动，监听 ${config.adminHost}:${management.port}`);
    } else if (admin) logger.info('管理网站未启用：请在 .env 配置 ADMIN_TOKEN（至少 24 字符）');
    if (schedule) scheduler.start();
    return {
      services, scheduler, management,
      async stop() {
        await scheduler.stop();
        await management?.close();
        await prompt.close();
        await flushEventStore();
        await flushMessageStore();
        await flushUsage();
        await flushLogs();
        await flushPersistence();
        await releaseLock();
      },
    };
  } catch (err) { await releaseLock(); throw err; }
}
