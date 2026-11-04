const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = value => Number(value ?? 0).toLocaleString('zh-CN');
const kindNames = { chat: '文字对话', vision: '图片理解', draw: '绘图', image: '绘图', distill: '记忆提炼' };
const empty = (title, description) => `<div class="empty-state"><h3>${e(title)}</h3><p>${e(description)}</p></div>`;
const panelHead = (title, description) => `<div class="panel-header"><div><h2>${e(title)}</h2><p>${e(description)}</p></div></div>`;

export const usageMoney = (totals = {}) => totals.calls && !totals.pricedCalls ? '待确认'
  : `¥${((totals.costNano || 0) / 1e9).toFixed(totals.costNano > 0 && totals.costNano < 10000000 ? 4 : 2)}`;
export const usageTime = (value, timeOnly = false) => Number.isFinite(value) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: timeOnly ? undefined : '2-digit', day: timeOnly ? undefined : '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value) : '—';
export const usageSession = (key) => key?.startsWith('g-') ? `群聊 · ${key.slice(2)}` : key?.startsWith('p-') ? `私聊 · ${key.slice(2)}` : key || '全部会话';
function usageChart(result) {
  if (result.totals?.calls && !result.totals.pricedCalls) return empty('费用走势待确认', '当前记录缺少可计价用量，不显示为零费用走势。', 'usage');
  const buckets = result.byTime || [];
  if (!buckets.length) return empty('暂无用量走势', '产生调用后显示当前时段的费用走势。', 'usage');
  const max = Math.max(1, ...buckets.map(row => row.costNano || 0));
  const tickEvery = Math.max(1, Math.ceil(buckets.length / 6));
  return `<div class="usage-chart" role="group" aria-label="已计价预估费用走势"><div class="usage-chart-axis"><span>${e(usageMoney({costNano:max}))}</span><span>¥0</span></div><div class="usage-chart-columns">${buckets.map((row, i) => {
    const label = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...(result.range?.interval === 'hour' ? { hour: '2-digit', hour12: false } : { month: '2-digit', day: '2-digit' }) }).format(row.time);
    const reading = `${usageTime(row.time)} · ${usageMoney(row)} · ${number(row.totalTokens)} token · ${number(row.pendingCostCalls)} 次费用待确认`;
    const height = (row.costNano || 0) / max * 98;
    const tick = (i % tickEvery === 0 && i < buckets.length - 2) || i === buckets.length - 1;
    return `<button class="usage-chart-bar" type="button" data-action="usage-chart" data-reading="${e(reading)}" aria-label="${e(reading)}" title="${e(reading)}"><svg viewBox="0 0 20 100" preserveAspectRatio="none" aria-hidden="true"><rect x="3" y="${100-height}" width="14" height="${height}" rx="1"/></svg><span>${tick ? e(label) : ''}</span></button>`;
  }).join('')}</div></div><p class="field-hint" id="usage-chart-reading">选择柱形查看该时段费用；无完整用量的调用不作为零费用计入。</p>`;
}
function usageKindRows(result) {
  const rows = result.byKind || [];
  const max = Math.max(1, result.totals?.costNano || 0);
  return rows.length ? [...rows].sort((a,b) => (b.costNano || 0) - (a.costNano || 0)).map(row => `<button class="usage-kind" type="button" data-action="usage-kind" data-kind="${e(row.kind)}"><span class="usage-kind-heading"><strong>${e(kindNames[row.kind] || row.kind)}</strong><span>${e(usageMoney(row))}</span></span><progress class="usage-progress" value="${Math.round((row.costNano || 0) / max * 1000) / 10}" max="100" aria-label="${e(kindNames[row.kind] || row.kind)}预估费用占比" aria-valuetext="${row.calls && !row.pricedCalls ? '费用待确认，暂无占比' : Math.round((row.costNano || 0) / max * 1000) / 10+'%'}"></progress><span class="usage-kind-note"><span>${e(number(row.calls))} 次 · ${row.kind === 'draw' || row.kind === 'image' ? '已返回 '+e(number(row.images))+' 张图片' : row.unknownUsageCalls === row.calls ? 'token 未返回' : e(number(row.totalTokens))+' token'}</span><span>${e(number(row.pendingCostCalls))} 次待确认</span></span></button>`).join('') : empty('暂无调用用途', '统计包含聊天、识图、记忆提炼与绘图。', 'usage');
}

// The workbench and Chromium capture render this same DOM with the same CSS.
export function renderUsageShareContent(result, { capture = false } = {}) {
  const t = result.totals || {};
  const previous = result.previous;
  const delta = t.pricedCalls && !t.pendingCostCalls && previous?.pricedCalls && !previous.pendingCostCalls && previous.costNano > 0 ? (t.costNano-previous.costNano)/previous.costNano*100 : null;
  const cache = t.cacheReportedPromptTokens ? `${(t.cacheHitTokens/t.cacheReportedPromptTokens*100).toFixed(1)}%` : '未返回';
  const range = result.range || {};
  const scope = capture ? result.scopeLabel : usageSession(range.sessionKey);
  return `<div id="usage-share-content" class="${capture ? 'usage-capture' : ''}"><header class="usage-capture-heading"><p class="eyebrow">BIG FAT FISH / USAGE</p><h1>Token 用量与费用</h1></header>
    <section class="panel usage-summary" aria-label="费用与用量摘要"><div class="usage-summary-main"><div class="usage-cost"><p>已计价预估费用 <span class="badge neutral">CNY</span></p><div class="usage-cost-value">${e(usageMoney(t))}</div><p class="field-hint">${delta===null?'暂无可比费用':`较上一时段${delta>=0?'增加':'减少'} ${Math.abs(delta).toFixed(1)}% · 截至相同进度`}</p></div><div class="usage-stat"><p>已报告 token</p><strong>${t.calls && t.unknownUsageCalls===t.calls?'未返回':e(number(t.totalTokens))}</strong><p class="field-hint">输入 ${t.calls && !t.promptKnownCalls?'未返回':e(number(t.promptTokens))} · 输出 ${t.calls && !t.completionKnownCalls?'未返回':e(number(t.completionTokens))}</p></div><div class="usage-stat"><p>API 调用</p><strong>${e(number(t.calls))}<small>次</small></strong><p class="field-hint">成功 ${e(number(t.successes))} · 失败 ${e(number(t.failures))} · 出图 ${e(number(t.images))} 张</p></div></div><div class="usage-summary-foot"><span>${e(scope)} · ${e(usageTime(range.since))} — ${e(usageTime(range.until))}（北京时间）</span><span>${e(number(t.pricedCalls))}/${e(number(t.calls))} 次已计价</span><button class="text-button" type="button" data-action="usage-pricing">计价说明</button></div></section>
    ${t.pendingCostCalls?`<section class="usage-warning" aria-label="计价完整度"><strong>${e(number(t.pendingCostCalls))} 次费用待确认，未包含在上方金额中</strong><p>${e((result.pendingReasons || []).map(row=>`${row.reason} ${number(row.calls)} 次`).join('；'))}</p><button class="text-button" type="button" data-action="usage-pending">查看待确认调用 ↘</button></section>`:''}
    ${!t.calls ? `<section class="panel">${empty('所选范围暂无模型调用','尚未产生调用，与账本读取失败或上游未返回用量不同。')}</section>` : `<div class="usage-panels"><section class="panel">${panelHead('费用走势', `按${range.interval==='hour'?'小时':'天'}汇总 · 仅含已计价费用 · 最后一个时段可能尚未结束`)}${usageChart(result)}<p class="usage-cache">输入缓存命中率 <strong>${e(cache)}</strong><span class="muted">基于有缓存拆分的调用；${e(number(t.cacheUnknownCalls))} 次未返回拆分</span></p></section><section class="panel">${panelHead('按用途分布','点击用途筛选明细；上方汇总范围不变。')}${usageKindRows(result)}</section></div>`}</div>`;
}
