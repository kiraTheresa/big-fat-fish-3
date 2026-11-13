import { readUsageOverview } from '../store/usage-store.js';
import { usageDayStart } from '../platform/usage-policy.js';
import { USAGE_PRICING, IMAGE_PRICING } from './pricing.js';

export const USAGE_PERIODS = Object.freeze({ today: 1, '7d': 7, '30d': 30 });
const DAY = 86400000;
export async function readUsageDashboard({ period = 'today', since: customSince, until: customUntil, sessionKey, detailKind, pendingOnly = false, limit = 100 } = {}, now = Date.now()) {
  if (period !== 'custom' && !Object.hasOwn(USAGE_PERIODS, period)) throw new Error('统计时段需为 today、7d、30d 或 custom');
  if (detailKind && !['chat', 'vision', 'distill', 'draw', 'image_lab'].includes(detailKind)) throw new Error('未知调用用途');
  if (![true, false, 'true', 'false'].includes(pendingOnly)) throw new Error('待确认筛选格式不正确');
  let days = USAGE_PERIODS[period];
  let until = now;
  let since = usageDayStart(now) - (days - 1) * DAY;
  if (period === 'custom') {
    const parse = value => typeof value === 'number' ? value : Date.parse(value);
    since = usageDayStart(parse(customSince));
    until = Math.min(now, parse(customUntil));
    days = Math.floor((usageDayStart(until) - since) / DAY) + 1;
    if (!Number.isFinite(since) || !Number.isFinite(until) || since > until || days > 366) throw new Error('自定义日期需有效、开始不晚于结束，最多 366 天');
  }
  const interval = days === 1 ? 'hour' : 'day';
  const [current, previous] = await Promise.all([
    readUsageOverview({ since, until, sessionKey, includeCost: true, interval, detailKind, pendingOnly: pendingOnly === true || pendingOnly === 'true', limit }),
    readUsageOverview({ since: since - days * DAY, until: until - days * DAY, sessionKey, includeCost: true, limit: 0 }),
  ]);
  const step = interval === 'hour' ? 3600000 : DAY;
  const buckets = new Map(current.byTime.map(bucket => [bucket.time, bucket]));
  const byTime = [];
  for (let time = since; time <= until; time += step) {
    byTime.push(buckets.get(time) ?? { time, calls: 0, totalTokens: 0, costNano: 0, pricedCalls: 0, pendingCostCalls: 0 });
  }
  return { ...current, byTime, previous: previous.totals,
    range: { period, since, until, timeZone: 'Asia/Shanghai', interval, sessionKey: sessionKey || null },
    pricing: { ...USAGE_PRICING, image: IMAGE_PRICING } };
}
