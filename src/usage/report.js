import { renderAsync } from '@resvg/resvg-js';
import { readUsageDashboard, USAGE_PERIODS } from './overview.js';
import { sendGroup, sendPrivate } from '../sender/sender.js';
import { appendMessage } from '../store/message-store.js';
import { canUseBot } from '../platform/permissions.js';

const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const number = value => Number(value ?? 0).toLocaleString('zh-CN');
const amount = totals => totals.calls && !totals.pricedCalls ? '待确认' : `¥${(totals.costNano / 1e9).toFixed(totals.costNano > 0 && totals.costNano < 10000000 ? 4 : 2)}`;
const kinds = { chat: '文字对话', vision: '图片理解', distill: '记忆提炼', draw: '绘图' };
const formatTime = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);

export async function renderUsageReport(overview) {
  const { totals: t, range } = overview;
  const scope = !range.sessionKey ? '全部会话' : range.sessionKey.startsWith('g-') ? '当前群聊' : range.sessionKey.startsWith('p-') ? '当前私聊' : '所选会话';
  const period = { today: '今天', '7d': '近 7 天', '30d': '近 30 天' }[range.period] ?? '所选时段';
  const text = (value, x, y, size = 23, color = '#202734', weight = 400, anchor = 'start') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${xml(value)}</text>`;
  const lines = Object.entries(kinds).map(([kind, label]) => {
    const row = overview.byKind.find(entry => entry.kind === kind) ?? { calls: 0, costNano: 0, pricedCalls: 0, pendingCostCalls: 0 };
    return { label, ...row };
  }).sort((a, b) => b.costNano - a.costNano).map((row, index) => {
    const y = 651 + index * 73;
    return text(row.label, 56, y) + text(`${number(row.calls)} 次`, 460, y, 21, '#616d7e') + text(amount(row), 844, y, 23, '#202734', 500, 'end')
      + `<rect x="56" y="${y + 15}" width="788" height="5" rx="2" fill="#e9edf3"/><rect x="56" y="${y + 15}" width="${t.costNano ? 788 * row.costNano / t.costNano : 0}" height="5" rx="2" fill="#245bd6"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1140" viewBox="0 0 900 1140"><rect width="900" height="1140" fill="#ffffff"/><rect width="900" height="8" fill="#245bd6"/><g font-family="Noto Sans CJK SC, PingFang SC, Microsoft YaHei, sans-serif">${text('大肥鱼 / 用量报告',56,76,19,'#616d7e',500)}${text('Token 用量与费用',56,145,42,'#202734',600)}${text(`${scope} · ${period}`,56,190,24,'#616d7e')}<path d="M56 225H844M56 944H844" stroke="#dce1e8"/>${text('已计价预估费用 · CNY',56,283,22,'#616d7e')}${text(amount(t),56,385,88,'#202734',600)}${text(`${number(t.pricedCalls)} / ${number(t.calls)} 次已计价`,60,434,21,'#616d7e')}${text('已报告 token',56,507,22,'#616d7e')}${text(t.calls && t.unknownUsageCalls === t.calls ? '未返回' : number(t.totalTokens),56,557,37,'#202734',600)}${text('API 调用',535,507,22,'#616d7e')}${text(`${number(t.calls)} 次`,535,557,37,'#202734',600)}${text('按用途统计',56,609,24,'#202734',600)}${lines}${text(t.pendingCostCalls ? `${number(t.pendingCostCalls)} 次费用待确认，未包含在上方金额中` : t.calls ? '当前记录均有计价依据' : '所选范围暂无调用记录',56,992,21,t.pendingCostCalls ? '#94621e' : '#616d7e')}${text('本地估算，实际扣费以供应商账单为准。',56,1031,20,'#616d7e')}${text(`${formatTime(range.since)} — ${formatTime(range.until)} · 北京时间`,56,1092,19,'#616d7e')}</g></svg>`;
  return (await renderAsync(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Noto Sans CJK SC' } })).asPng();
}

export async function readUsageReport(query = {}) {
  return renderUsageReport(await readUsageDashboard({ period: query.period, sessionKey: query.sessionKey, since: query.since, until: query.until, limit: 0 }));
}

// Neither the model nor slash-command arguments can choose a different session.
export async function sendUsageReport({ event, sessionKey }, period = 'today') {
  if (!Object.hasOwn(USAGE_PERIODS, period)) throw new Error('统计时段需为 today、7d 或 30d');
  const group = event?.message_type === 'group';
  const id = group ? event.group_id : event?.message_type === 'private' ? event.user_id : null;
  if (!/^\d{1,20}$/.test(String(id)) || !/^\d{1,20}$/.test(String(event?.user_id)) || sessionKey !== `${group ? 'g' : 'p'}-${id}` || !canUseBot(event)) throw new Error('缺少有效的当前会话，不能读取其他会话用量');
  const bytes = await readUsageReport({ period, sessionKey });
  const segments = [{ type: 'image', data: { file: `base64://${bytes.toString('base64')}` } }];
  const result = group ? await sendGroup(event.group_id, segments) : await sendPrivate(event.user_id, segments);
  if (result.ok) appendMessage({ sessionKey, time: Math.floor(Date.now() / 1000), message_type: event.message_type,
    ...(group ? { group_id: event.group_id } : {}), user_id: event.user_id, raw_message: `[用量报告] ${period} · 当前会话`, bot: true });
  return { ok: result.ok, ...(result.ok ? { messageId: result.messageId } : {}), message: result.ok ? '当前会话的用量报告已发送，OneBot 已确认' : '用量报告发送失败或结果未知，未自动补发' };
}
