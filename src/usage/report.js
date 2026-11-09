import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readUsageDashboard, USAGE_PERIODS } from './overview.js';
import { renderUsageShareContent } from '../../web/usage-view.js';
import { sendGroup, sendPrivate } from '../sender/sender.js';
import { appendMessage } from '../store/message-store.js';
import { canUseBot } from '../platform/permissions.js';
import { config } from '../config.js';

const snapshots = new Map();
let browserPromise;
let captureChain = Promise.resolve();
let queued = 0;
const failure = (message, status) => Object.assign(new Error(message), { status });

// Only public aggregate fields enter the capture browser; no admin state or IDs.
function reportSnapshot(overview) {
  const { period, since, until, interval, sessionKey } = overview.range;
  return structuredClone({ totals: overview.totals, previous: overview.previous, byKind: overview.byKind,
    byTime: overview.byTime, pendingReasons: overview.pendingReasons, range: { period, since, until, interval },
    scopeLabel: !sessionKey ? '全部会话' : sessionKey.startsWith('g-') ? '当前群聊' : sessionKey.startsWith('p-') ? '当前私聊' : '所选会话' });
}

export async function readUsageDashboardForExport(query) {
  const overview = await readUsageDashboard(query);
  const snapshotId = randomUUID();
  for (const [id, item] of snapshots) if (item.expiresAt <= Date.now()) snapshots.delete(id);
  while (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value);
  snapshots.set(snapshotId, { data: reportSnapshot(overview), expiresAt: Date.now() + 5 * 60000 });
  return { ...overview, snapshotId };
}

function captureSize({ width = 1000, viewportWidth = 1200 } = {}) {
  width = Number(width); viewportWidth = Number(viewportWidth);
  if (!Number.isInteger(width) || width < 280 || width > 2000 || !Number.isInteger(viewportWidth)
    || viewportWidth < 320 || viewportWidth > 3840 || width > viewportWidth) throw failure('截图尺寸无效', 400);
  return { width, viewportWidth };
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, timeout: 15000,
      ...(config.chromeExecutable ? { executablePath: config.chromeExecutable } : {}) })
      .then(browser => { browser.once('disconnected', () => { browserPromise = undefined; }); return browser; })
      .catch(error => { browserPromise = undefined; throw error; });
  }
  return browserPromise;
}

async function capture(data, { width, viewportWidth }) {
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: viewportWidth, height: 1000 }, deviceScaleFactor: 1,
      colorScheme: 'light', reducedMotion: 'reduce', javaScriptEnabled: false, serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    const styles = await Promise.all(['styles.css', 'usage.css'].map(name => readFile(new URL('../../web/' + name, import.meta.url), 'utf8')));
    await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles.join('\n')}#usage-share-content{width:${width}px}</style></head><body>${renderUsageShareContent(data, { capture: true })}</body></html>`, { waitUntil: 'load', timeout: 10000 });
    await page.evaluate(() => document.fonts.ready);
    const target = page.locator('#usage-share-content');
    const bounds = await target.boundingBox();
    if (!bounds || bounds.height > 4096) throw failure('截图内容过长，请缩小统计范围', 400);
    return await target.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', timeout: 10000 });
  } catch (error) {
    if (error.status) throw error;
    throw failure('无法生成用量截图，请确认已安装 Chromium 且浏览器可以启动', 503);
  } finally { if (context) await context.close().catch(() => {}); }
}

function enqueueCapture(data, options) {
  const size = captureSize(options);
  if (queued >= 4) return Promise.reject(failure('用量截图正在处理中，请稍后再试', 429));
  queued++;
  const result = captureChain.then(() => capture(data, size));
  captureChain = result.catch(() => {});
  return result.finally(() => { queued--; });
}

export async function renderUsageReport(overview, options) {
  return enqueueCapture(reportSnapshot(overview), options);
}

export async function readUsageReport(query = {}) {
  if (query.snapshotId !== undefined) {
    const snapshot = snapshots.get(query.snapshotId);
    if (!snapshot || snapshot.expiresAt <= Date.now()) throw failure('统计快照已过期，请刷新用量页面后重试', 409);
    return enqueueCapture(snapshot.data, query);
  }
  return renderUsageReport(await readUsageDashboard({ period: query.period, sessionKey: query.sessionKey, since: query.since, until: query.until, limit: 0 }), query);
}

export async function closeUsageReportBrowser() {
  await captureChain;
  const browser = browserPromise;
  browserPromise = undefined;
  if (browser) await (await browser).close();
  snapshots.clear();
}

// Neither the model nor slash-command arguments can choose a different session.
export async function sendUsageReport({ event, sessionKey, logContext }, period = 'today') {
  if (!Object.hasOwn(USAGE_PERIODS, period)) throw new Error('统计时段需为 today、7d 或 30d');
  const group = event?.message_type === 'group';
  const id = group ? event.group_id : event?.message_type === 'private' ? event.user_id : null;
  if (!/^\d{1,20}$/.test(String(id)) || !/^\d{1,20}$/.test(String(event?.user_id)) || sessionKey !== `${group ? 'g' : 'p'}-${id}` || !canUseBot(event)) throw new Error('缺少有效的当前会话，不能读取其他会话用量');
  const bytes = await readUsageReport({ period, sessionKey });
  const segments = [{ type: 'image', data: { file: `base64://${bytes.toString('base64')}` } }];
  const result = group ? await sendGroup(event.group_id, segments, logContext) : await sendPrivate(event.user_id, segments, logContext);
  if (result.ok) appendMessage({ sessionKey, time: Math.floor(Date.now() / 1000), message_type: event.message_type,
    ...(group ? { group_id: event.group_id } : {}), user_id: event.user_id, raw_message: `[用量报告] ${period} · 当前会话`, bot: true });
  return { ok: result.ok, ...(result.ok ? { messageId: result.messageId } : {}), message: result.ok ? '当前会话的用量报告已发送，OneBot 已确认' : '用量报告发送失败或结果未知，未自动补发' };
}
