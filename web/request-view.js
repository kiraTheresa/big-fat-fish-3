import { usageTime, usageSession } from './usage-view.js';
import { describeLog } from '../src/utils/log-format.js';

const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = value => Number(value ?? 0).toLocaleString('zh-CN');
const decimal = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const seconds = value => Number.isFinite(value) ? `${decimal(value / 1000)} 秒` : '未记录';
const traceTime = value => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(time) : '未记录';
};
export const requestKinds = { chat: '文字对话', vision: '图片理解', distill: '记忆提炼', draw: '绘图', image_lab: '开发者生图' };
export const requestSources = { live: '线上调用', test: 'Prompt 测试', scheduled: '后台任务', admin: '管理操作', system: '系统调用', unknown: '历史未记录' };
export const requestReasons = { upstream_busy: '503 · 服务繁忙', rate_limited: '429 · 请求限流', timeout: '请求超时', auth_failed: '401 · 认证失败', balance_required: '402 · 余额不足', request_rejected: '请求被拒绝', upstream_error: '上游服务器错误', network_error: '网络错误', interrupted: '进程中断，结果未知', other: '其他调用失败' };
const outcomes = { success: '成功', failure: '失败', failed: '失败', interrupted: '已中断', unknown: '结果未知', confirmed: '平台已确认', completed: '处理器已返回', queued: '已入队', generated: '回复已生成', fallback: '兜底回复', skipped: '跳过', rejected: '准入拒绝', partial: '部分完成' };
const resultLabel = row => row.reason ? requestReasons[row.reason] ?? row.reason : outcomes[row.status ?? row.outcome] ?? row.status ?? row.outcome ?? '处理中';
const options = (entries, selected) => entries.map(([value, label]) => `<option value="${e(value)}"${value === selected ? ' selected' : ''}>${e(label)}</option>`).join('');
const heading = (title, note) => `<div class="panel-header"><div><h2>${e(title)}</h2><p>${e(note)}</p></div></div>`;
const empty = text => `<p class="request-empty">${e(text)}</p>`;

function chart(result, f, compact) {
  const rows = result.byTime ?? [];
  const group = compact ? Math.max(1, Math.ceil(rows.length / 6)) : 1;
  const buckets = [];
  for (let i = 0; i < rows.length; i += group) {
    const slice = rows.slice(i, i + group);
    buckets.push({ time: slice[0].time, until: slice.at(-1).until,
      calls: slice.reduce((sum, row) => sum + row.calls, 0), successes: slice.reduce((sum, row) => sum + row.successes, 0),
      failures: slice.reduce((sum, row) => sum + row.failures, 0), unknownResults: slice.reduce((sum, row) => sum + row.unknownResults, 0) });
  }
  const max = Math.max(1, ...buckets.map(row => row.calls));
  const bars = buckets.map((row, i) => {
    const height = row.calls / max * 140;
    const failHeight = row.failures / max * 140;
    const unknownHeight = row.unknownResults / max * 140;
    const selected = Number(f.detailSince) === row.time && Number(f.detailUntil) === row.until;
    const reading = `${usageTime(row.time)} — ${usageTime(row.until)}：${row.calls} 次，失败 ${row.failures} 次，未知 ${row.unknownResults} 次`;
    const showTick = i % Math.max(1, Math.ceil(buckets.length / 6)) === 0;
    const tick = result.range.interval === 'hour' ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(row.time) : usageTime(row.time).slice(0, 5);
    return `<button type="button" class="request-chart-bar" data-action="request-bucket" data-since="${e(row.time)}" data-until="${e(row.until)}" aria-pressed="${selected}" aria-label="${e(reading)}" title="${e(reading)}"><svg viewBox="0 0 20 140" preserveAspectRatio="none" aria-hidden="true"><rect class="request-mark-success" x="2" y="${140 - height}" width="16" height="${height}"/><rect class="request-mark-failure" x="2" y="${140 - failHeight - unknownHeight}" width="16" height="${failHeight}"/><rect class="request-mark-unknown" x="2" y="${140 - unknownHeight}" width="16" height="${unknownHeight}"/></svg><span>${showTick ? e(tick) : ''}</span></button>`;
  }).join('');
  return `<div class="request-legend"><span><i class="request-swatch success"></i>成功</span><span><i class="request-swatch failure"></i>失败</span><span><i class="request-swatch unknown"></i>未知 / 中断</span></div><div class="request-chart"><div class="request-chart-axis" aria-hidden="true"><span>${number(max)} 次</span><span>0</span></div><div class="request-chart-columns">${bars}</div></div><p class="field-hint">每 ${group} ${result.range.interval === 'hour' ? '小时' : '天'}一组；点击柱形筛选下方明细。</p>`;
}

export function renderRequestsView(result, f = {}, { compact = false, older = false } = {}) {
  const t = result.totals;
  const detailActive = f.reason || f.failedOnly === 'true' || f.detailSince;
  const summary = [
    ['API 请求', number(t.calls), '次', `成功 ${t.successes} · 失败 ${t.failures} · 未知 / 中断 ${t.unknownResults}`],
    ['分钟请求峰值', number(t.peakPerMinute), '次/分', `平均 ${decimal(t.averagePerMinute, 2)} 次/分 · 含异常调用`],
    ['已知结果失败率', decimal(t.failureRate), '%', `${t.failures} / ${t.knownResults} 次已知结果`],
    ['成功请求 P95', t.p95Ms === null ? '—' : decimal(t.p95Ms / 1000), '秒', `${t.durationSamples} 次有耗时 · ${t.missingDurations} 次缺失`],
  ].map(([label, value, unit, note]) => `<div class="request-stat"><p>${label}</p><strong>${e(value)}<small>${unit}</small></strong><p>${e(note)}</p></div>`).join('');
  const reset = `<button type="button" class="button subtle" data-action="request-reset">重置范围</button>`;
  const kinds = Object.entries(requestKinds).map(([kind, label]) => {
    const row = result.byKind.find(row => row.kind === kind) ?? { calls: 0, failures: 0, unknownResults: 0 };
    return `<tr><td><button class="text-button" type="button" data-action="request-kind" data-kind="${kind}">${label}</button></td><td class="request-number">${number(row.calls)}</td><td class="request-number">${number(row.failures)}</td><td class="request-number">${number(row.unknownResults)}</td></tr>`;
  }).join('');
  const sessions = result.bySession.slice(0, 8).map(row => `<button class="request-session" type="button" data-action="request-session" data-session="${e(row.sessionKey)}"><span>${e(usageSession(row.sessionKey))}<small>失败 ${number(row.failures)} · 未知 ${number(row.unknownResults)}</small></span><span>${number(row.calls)} 次 ↗</span></button>`).join('');
  const items = result.items.map((row, index) => `<tr><td>${e(usageTime(row.time))}<span class="cell-sub">${e(requestSources[row.source] ?? row.source)}</span></td><td>${e(requestKinds[row.kind] ?? row.kind)}<span class="cell-sub">${e(usageSession(row.sessionKey))}</span></td><td>${e(seconds(row.elapsedMs))}<span class="cell-sub">${e(row.responseModel ?? row.model)}</span></td><td><span class="${['failure', 'interrupted'].includes(row.status) ? 'request-error' : ''}">${e(resultLabel(row))}</span><span class="cell-sub">${row.httpStatus ? 'HTTP ' + e(row.httpStatus) : '未记录 HTTP 状态'}</span></td><td class="cell-actions"><button class="text-button" type="button" data-action="request-detail" data-index="${index}">详情</button></td></tr>`).join('');
  return `<div class="request-workbench">
    <div class="request-periods" role="group" aria-label="请求统计日期">${[['today', '今天'], ['yesterday', '昨天'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['custom', '自定义']].map(([value, label]) => `<button type="button" class="button${(f.period || 'today') === value ? ' primary' : ''}" aria-pressed="${(f.period || 'today') === value}" data-action="request-period" data-period="${value}">${label}</button>`).join('')}</div>
    <form id="requests-filter" class="filters request-scope"><input type="hidden" name="period" value="${e(f.period || 'today')}">${f.period === 'custom' ? `<label>开始日期（北京）<input type="date" name="since" value="${e(f.since)}" required></label><label>结束日期（北京）<input type="date" name="until" value="${e(f.until)}" required></label>` : ''}<label>用途<select name="kind">${options([['', '全部用途'], ...Object.entries(requestKinds)], f.kind || '')}</select></label><label>来源<select name="source">${options([['', '全部来源'], ...Object.entries(requestSources)], f.source || '')}</select></label><label class="filter-wide">会话范围<input name="sessionKey" list="request-sessions" value="${e(f.sessionKey)}" placeholder="全部；或 g-群号 / p-QQ号" autocomplete="off"><datalist id="request-sessions">${result.bySession.map(row => `<option value="${e(row.sessionKey)}">${e(usageSession(row.sessionKey))}</option>`).join('')}</datalist></label><button class="button" type="submit">应用范围</button>${reset}</form>
    <p class="request-range">${e(usageTime(result.range.since))} — ${e(usageTime(result.range.until))} · 北京时间 · 已完成 / 已中断的模型 API 调用</p>
    <section class="panel request-summary" aria-label="请求统计摘要">${summary}</section>
    <div class="request-panels"><section class="panel">${heading('请求分布', '按请求开始时间统计；包含失败及未知结果')}${chart(result, f, compact)}<p class="request-overlap">历史在途峰值 <strong>${t.peakInFlight === null ? '—' : '≈ ' + number(t.peakInFlight)}</strong> 个<span>本机账本估算 · ${number(t.overlapSamples)} 个有效区间</span></p></section>
      <section class="panel">${heading('失败发生在哪里', '点击原因只筛选下方明细')}${result.errors.length ? result.errors.map(row => `<button class="request-reason" type="button" data-action="request-reason" data-reason="${e(row.reason)}"><span>${e(requestReasons[row.reason] ?? row.reason)}</span><strong>${number(row.calls)} <small>次 ↘</small></strong></button>`).join('') : empty('所选范围未记录失败或中断')}<p class="field-hint">未知结果不作为成功；API 结果不代表最终回复送达。</p></section></div>
    <div class="request-panels"><section class="panel">${heading('哪些业务在调用', '点击用途切换全页统计范围')}<div class="table-wrap"><table><thead><tr><th>用途</th><th class="request-number">请求</th><th class="request-number">失败</th><th class="request-number">未知</th></tr></thead><tbody>${kinds}</tbody></table></div></section><section class="panel">${heading('请求来自哪些会话', '按请求数排列，展示前 8 个；点击切换范围')}${sessions || empty('所选范围没有会话调用')}</section></div>
    <section class="panel request-ledger" aria-label="请求明细"><div class="panel-header"><div><h2>请求明细</h2><p>匹配 ${number(result.matchingItems)} 次；明细筛选不改变上方统计。</p></div><div class="request-detail-actions"><button class="button small" type="button" data-action="request-failures" aria-pressed="${f.failedOnly === 'true'}">仅看异常</button>${detailActive ? '<button class="text-button" type="button" data-action="request-clear-detail">清除明细筛选</button>' : ''}</div></div>
    ${detailActive ? `<p class="request-detail-scope" role="status">${e([f.detailSince ? `${usageTime(Number(f.detailSince))} — ${usageTime(Number(f.detailUntil))}` : '全时段', f.reason ? requestReasons[f.reason] ?? f.reason : f.failedOnly === 'true' ? '失败 / 中断' : '全部结果'].join(' · '))}</p>` : ''}
    ${items ? `<div class="table-wrap"><table><thead><tr><th>开始时间 / 来源</th><th>业务 / 会话</th><th>耗时 / 模型</th><th>调用结果</th><th></th></tr></thead><tbody>${items}</tbody></table></div>` : empty(detailActive ? '当前明细筛选下没有请求' : '所选范围暂无请求记录')}
    <div class="pagination"><span aria-live="polite">本页 ${number(result.items.length)} 次 · 最新优先</span><div><button class="button small" type="button" data-action="first-page"${older ? '' : ' disabled'}>返回最新</button><button class="button small" type="button" data-action="next-page"${result.nextCursor ? '' : ' disabled'}>更早记录 →</button></div></div></section>
    <details class="panel request-definitions"><summary>统计口径与数据完整性</summary><p>每次实际模型 API 尝试计 1 次，包含工具多轮和回退调用，不等于用户消息数；准入拒绝没有发出 API 请求，不计入请求量。当前不包含仍在执行、尚未写入账本的请求。</p><p>分钟峰值按固定自然分钟计数。失败率仅以明确成功和失败为分母，进程中断及历史未记录结果单独列为未知。成功 P95 采用最近秩法，只使用有耗时记录的成功请求，不代表用户收到回复所需时间。</p><p>在途峰值按本机已完成请求的开始时间与耗时重建重叠区间，包含跨入当前时段的调用，不含中断及缺失耗时记录，不是账号实时并发。网关耗时包含准备、下载或落盘等处理，不能视为纯推理时间。</p><p>日期范围左闭右开，自定义最多 31 天。来源和链路 ID 仅在新记录中提供；历史数据不会推测补齐。账本读取失败会明确报错，不显示为零。整轮回复成功率、用户首条回复等待尚未采集。</p></details>
  </div>`;
}

export function renderRequestDetail(row) {
  return `<p class="detail-caption">本次模型 API 调用结果，不代表整轮业务或回复发送成功。</p><dl class="key-values"><div><dt>开始时间（北京）</dt><dd>${e(usageTime(row.time))}</dd></div><div><dt>业务 / 来源</dt><dd>${e(requestKinds[row.kind] ?? row.kind)} · ${e(requestSources[row.source] ?? row.source)}</dd></div><div><dt>会话</dt><dd>${e(usageSession(row.sessionKey))}</dd></div><div><dt>模型</dt><dd>${e(row.responseModel ?? row.model)}</dd></div><div><dt>耗时</dt><dd>${e(seconds(row.elapsedMs))}</dd></div><div><dt>结果</dt><dd>${e(resultLabel(row))}${row.httpStatus ? ' · HTTP ' + e(row.httpStatus) : ''}</dd></div>${row.error ? `<div><dt>失败详情</dt><dd>${e(row.error)}</dd></div>` : ''}</dl>${row.traceId ? `<div class="dialog-actions"><button class="button" type="button" data-action="request-trace" data-trace="${e(row.traceId)}">查看本轮业务链路</button></div>` : '<p class="field-hint">这条历史记录没有链路 ID，无法可靠关联本轮业务。</p>'}`;
}

export function renderRequestTrace(rows, nextCursor, traceId) {
  return `<p class="detail-caption">按已获取记录的发生顺序展示。处理器返回不等于回复已发送，平台确认不等于用户已读。</p>${rows.length ? `<ol class="request-trace">${[...rows].reverse().map(row => {
    const info = describeLog(row);
    return `<li><div><time>${e(traceTime(row.time))}</time><strong>${e(info.title)}</strong><span>${e(info.result)}</span></div><p>${e([row.elapsedMs === undefined ? '' : seconds(row.elapsedMs), info.detail].filter(Boolean).join(' · '))}</p></li>`;
  }).join('')}</ol>` : empty('未找到关联日志，可能尚未采集或已按保留策略清理')}${nextCursor ? `<div class="dialog-actions"><button class="button" type="button" data-action="request-trace-more" data-trace="${e(traceId)}" data-before="${e(nextCursor)}">加载更早的链路记录</button></div>` : ''}`;
}
