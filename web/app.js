const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const e = escapeHtml;
const number = (value) => Number(value ?? 0).toLocaleString('zh-CN');
const date = (value, timeOnly = false) => {
  if (value === null || value === undefined || value === '') return '—';
  const timestamp = typeof value === 'number' && value < 1e12 ? value * 1000 : value;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', timeOnly
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed);
};
const duration = (seconds) => {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  if (value >= 86400) return `${Math.floor(value / 86400)} 天 ${Math.floor(value % 86400 / 3600)} 小时`;
  if (value >= 3600) return `${Math.floor(value / 3600)} 小时 ${Math.floor(value % 3600 / 60)} 分`;
  return `${Math.floor(value / 60)} 分 ${value % 60} 秒`;
};
const icons = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  events: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8 11h8M8 14h5"/>',
  config: '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  jobs: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  logs: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  usage: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3a7 7 0 0 0 11.6-2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  shield: '<path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Z"/><path d="m8 12 3 3 5-6"/>',
  pulse: '<path d="M2 12h5l3-9 4 18 3-9h5"/>',
  inbox: '<path d="m4 4-3 9v7h22v-7l-3-9H4Z"/><path d="M1 13h6l2 4h6l2-4h6"/>',
  warning: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.events}</svg>`;
const pages = {
  overview: ['运行概览', '照看大肥鱼的每一次运行。', 'OVERVIEW'],
  events: ['消息收件箱', '所有接收事件都在这里；接收不等于自动处理。', 'INBOX'],
  config: ['配置与能力', '让每项能力按你的节奏工作。', 'CONFIGURATION'],
  users: ['用户与权限', '默认开放，需要时再为个别用户设置边界。', 'ACCESS'],
  jobs: ['任务调度', '安排记忆提炼与数据维护，查看执行结果。', 'SCHEDULER'],
  logs: ['运行日志', '从每一个线索，理解运行现场。', 'LOGS'],
  usage: ['用量观察', '查看真实调用、生成图片与 Token 使用情况。', 'USAGE'],
};
const state = {
  token: '', page: pages[location.hash.slice(1)] ? location.hash.slice(1) : 'overview',
  config: null, dirty: false, saving: false, loading: false, live: false, sequence: 0,
  rows: [], jobs: [], users: [], cursor: null, cursors: [],
  filters: { events: { postType: '', sessionKey: '' }, logs: { level: '', q: '' }, usage: { since: '', until: '', kind: '', sessionKey: '' } },
};
let toastTimer;
let lastFocus;

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 7000 : 3500);
}

function logout(message = '') {
  state.token = '';
  state.config = null;
  state.dirty = false;
  state.sequence++;
  state.rows = [];
  state.users = [];
  state.jobs = [];
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#content').innerHTML = '';
  $('#admin-token').value = '';
  $('#admin-token').type = 'password';
  $('#toggle-token').textContent = '显示';
  $('#toggle-token').setAttribute('aria-pressed', 'false');
  $('#toggle-token').setAttribute('aria-label', '显示管理令牌');
  $('#login-error').textContent = message;
  $('#login-error').hidden = !message;
  if ($('#detail-dialog').open) $('#detail-dialog').close();
  $('#dialog-content').innerHTML = '';
  $('#admin-token').focus();
}

async function api(path, { method = 'GET', body, token = state.token } = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), cache: 'no-store', signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? '请求超时，请稍后重试。' : '无法连接管理服务，请检查 Bot 是否仍在运行。');
  }
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    if (response.status === 401 && state.token && token === state.token) logout('管理令牌已失效，请重新登录。');
    const error = new Error(response.status === 401 ? '管理令牌不正确或已失效。'
      : response.status === 409 && path === '/config' ? '配置已被其他操作更新。请先重新读取配置，再保存你的修改。'
        : typeof data.error === 'string' ? data.error : `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const query = (values) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== '' && value !== null && value !== undefined) params.set(key, value);
  return params.toString() ? `?${params}` : '';
};
const pill = (text, color = '') => `<span class="badge ${color}">${e(text)}</span>`;
const empty = (title, description, name = 'inbox') => `<div class="empty-state"><div class="empty-icon">${icon(name)}</div><h3>${e(title)}</h3><p>${e(description)}</p></div>`;
const panelHead = (title, description = '', action = '') => `<div class="panel-header"><div><h2>${e(title)}</h2>${description ? `<p>${e(description)}</p>` : ''}</div>${action}</div>`;
const metric = (label, value, note, name, unit = '') => `<section class="panel metric"><div class="metric-top"><span>${e(label)}</span><span class="metric-symbol">${icon(name)}</span></div><div class="metric-value">${e(value)}${unit ? `<span class="unit">${e(unit)}</span>` : ''}</div><p class="metric-note">${e(note)}</p></section>`;
const pageLink = (page, text) => `<button type="button" class="text-button" data-page="${page}">${e(text)} ↗</button>`;
const selectOptions = (options, selected) => options.map(([value, label]) => `<option value="${e(value)}"${value === selected ? ' selected' : ''}>${e(label)}</option>`).join('');

function connectionInfo(connection) {
  const connected = typeof connection === 'object' ? connection?.connected === true || connection?.status === 'connected' : connection === 'connected';
  const reconnecting = typeof connection === 'object' && connection?.reconnecting;
  return { connected, text: connected ? 'QQ 已连接' : reconnecting ? 'QQ 重连中' : 'QQ 未连接', dot: connected ? '' : 'warning' };
}
function updateStatus(status) {
  const value = connectionInfo(status?.connection);
  $('#connection-status').innerHTML = `<span class="status-dot ${value.dot}"></span>${e(value.text)}`;
}
function markDirty() {
  state.dirty = true;
  if ($('#save-state')) $('#save-state').textContent = '有尚未保存的修改';
  if ($('#save-config')) $('#save-config').disabled = false;
}
function canLeave() {
  if (state.saving) { toast('正在保存，请稍候。'); return false; }
  return !state.dirty || window.confirm('配置尚未保存。放弃这些修改并离开？');
}
function navigate(page) {
  if (!pages[page] || page === state.page) return;
  if (!canLeave()) return;
  state.page = page;
  state.dirty = false;
  state.cursor = null;
  state.cursors = [];
  history.replaceState(null, '', `#${page}`);
  loadPage();
}

async function loadPage({ quiet = false } = {}) {
  if (!state.token) return;
  const sequence = ++state.sequence;
  const page = state.page;
  state.loading = true;
  $('#refresh').disabled = true;
  const [title, description, section] = pages[page];
  $('#page-title').textContent = title;
  $('#page-description').textContent = description;
  $('#page-eyebrow').textContent = `WORKSPACE / ${section}`;
  document.title = `${title} · 大肥鱼`;
  $('#live-control').hidden = !['overview', 'events', 'logs', 'usage'].includes(page);
  document.querySelectorAll('#navigation [data-page]').forEach((link) => {
    link.classList.toggle('active', link.dataset.page === page);
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('#content').setAttribute('aria-busy', 'true');
  if (!quiet) $('#content').innerHTML = '<section class="panel loading-state"><span class="spinner" aria-hidden="true"></span><p>正在读取运行数据…</p></section>';
  try {
    const html = await renderers[page](sequence);
    if (sequence !== state.sequence || !state.token) return;
    $('#content').innerHTML = html;
    $('#updated-at').textContent = `更新于 ${date(Date.now(), true)}`;
    if (page !== 'overview') api('/status').then((status) => { if (sequence === state.sequence && state.token) updateStatus(status); }).catch(() => {});
  } catch (error) {
    if (sequence !== state.sequence || !state.token) return;
    if (quiet) toast(`自动更新失败：${error.message}`, true);
    else $('#content').innerHTML = `<section class="panel error-state"><div class="empty-icon">${icon('warning')}</div><h3>暂时无法读取数据</h3><p>${e(error.message)}</p><button class="button" type="button" data-action="retry">重新加载</button></section>`;
  } finally {
    if (sequence === state.sequence) {
      state.loading = false;
      $('#refresh').disabled = false;
      $('#content').setAttribute('aria-busy', 'false');
    }
  }
}

function eventInfo(row) {
  const raw = row.event || row.raw || row;
  const postType = row.postType || raw.post_type || 'unknown';
  const type = row.eventType || raw.message_type || raw.notice_type || raw.request_type || raw.meta_event_type || postType;
  const session = row.sessionKey || (raw.group_id ? `g-${raw.group_id}` : raw.user_id ? `p-${raw.user_id}` : '系统事件');
  const segments = Array.isArray(raw.message) ? raw.message.filter((segment) => segment && typeof segment === 'object') : [];
  const types = Array.isArray(row.messageTypes) ? row.messageTypes : segments.map((segment) => segment.type || 'unknown');
  const text = Array.isArray(raw.message) ? segments.filter((segment) => segment.type === 'text').map((segment) => typeof segment.data?.text === 'string' ? segment.data.text : '').join('')
    : typeof raw.message === 'string' ? raw.message : '';
  return { postType, type, session, types: [...new Set(types)], text: text.slice(0, 180), sender: raw.sender?.card || raw.sender?.nickname || raw.user_id || '系统', time: row.receivedAt ?? raw.time };
}
function eventTypeBadge(type) {
  const labels = { message: '消息', message_sent: '发送事件', notice: '通知', request: '请求', meta_event: '元事件', unknown: '未知事件' };
  return pill(labels[type] || type, { notice: 'blue', request: 'violet', meta_event: 'neutral', message_sent: 'neutral', unknown: 'warning' }[type] || '');
}
function recentEvents(items) {
  if (!items.length) return empty('收件箱还很安静', 'QQ 接收的消息、通知和其他事件会出现在这里。');
  return `<div class="event-list">${items.slice(0, 6).map((row) => {
    const info = eventInfo(row);
    return `<div class="event-row"><span class="event-icon">${icon(info.postType === 'meta_event' ? 'pulse' : 'events')}</span><div class="event-text"><strong>${e(info.text || `${info.type} · ${info.types.join(' / ') || '事件已接收'}`)}</strong><p>${e(info.session)} · ${e(info.sender)}</p></div><time>${e(date(info.time, true))}</time></div>`;
  }).join('')}</div>`;
}

async function renderOverview(sequence) {
  const [status, events] = await Promise.all([api('/status'), api('/events?limit=6').catch(() => null)]);
  if (sequence !== state.sequence) return '';
  updateStatus(status);
  const connection = connectionInfo(status.connection);
  const usage = status.usage?.today || status.usage?.totals || status.usage || {};
  const ledgerAvailable = status.usage?.ledgerAvailable !== false && status.usage?.today !== null;
  const usageNumber = (value) => ledgerAvailable ? number(value) : '不可用';
  const persistenceError = status.storage?.lastError?.message || status.storage?.usage?.lastWriteError || status.usage?.lastPersistenceError || status.logStats?.lastError || status.scheduler?.lastError;
  const jobs = Array.isArray(status.scheduler?.jobs) ? status.scheduler.jobs.length : status.scheduler?.jobs ?? 0;
  const failed = usage.failures ?? 0;
  const storage = status.storage || {};
  return `${persistenceError ? `<div class="notice error">持久化或调度存在异常：${e(typeof persistenceError === 'object' ? JSON.stringify(persistenceError) : persistenceError)}</div>` : ''}<section class="panel status-hero"><div><p class="eyebrow">YOUR LITTLE CONTROL ROOM</p><h2>${connection.connected ? '大肥鱼，在线游弋。' : '控制台就绪，等待 QQ 连接。'}</h2><p>${connection.connected ? '消息接收、运行状态与用量，尽在眼前。' : '可以管理配置与查看记录；连接恢复后继续接收事件。'}</p></div><div class="status-illustration" aria-hidden="true">${icon(connection.connected ? 'check' : 'pulse')}</div></section>
    <div class="metrics-grid">${metric('运行时间', duration(status.uptimeSeconds), `启动于 ${date(status.startedAt)}`, 'pulse')}${metric('今日调用', usageNumber(usage.calls), ledgerAvailable ? `下次重置 ${date(status.usage?.resetAt)}` : '用量账本当前不可读取', 'usage', '次')}${metric('今日 Token', usageNumber(usage.totalTokens), ledgerAvailable ? `${number(usage.unknownUsageCalls)} 次调用未返回完整用量` : '暂时无法汇总已知用量', 'config')}${metric('计划任务', number(jobs), status.scheduler?.running ? '调度器正在运行' : '调度器未运行', 'jobs', '项')}</div>
    <div class="overview-grid"><section class="panel">${panelHead('最近收到', '从最新事件，看看发生了什么。', pageLink('events', '全部事件'))}${events ? recentEvents(events.items || []) : '<div class="notice error">事件列表暂时无法读取，请到消息收件箱重试。</div>'}</section>
    <section class="panel">${panelHead('实例状态', '当前连接与持久化概况')}<dl class="key-values"><div><dt>QQ 连接</dt><dd>${pill(connection.text, connection.connected ? '' : 'warning')}</dd></div><div><dt>最近收到事件</dt><dd>${e(date(status.connection?.lastEventAt))}</dd></div><div><dt>数据目录</dt><dd class="mono">${e(storage.dataDir || '—')}</dd></div><div><dt>今日失败调用</dt><dd>${e(usageNumber(failed))}${ledgerAvailable ? ' 次' : ''}</dd></div><div><dt>今日生成图片</dt><dd>${e(usageNumber(usage.images))}${ledgerAvailable ? ' 张' : ''}</dd></div><div><dt>日志已写入</dt><dd>${e(number(status.logStats?.written))} 条</dd></div></dl><div class="quick-links"><button type="button" class="button small" data-page="config">${icon('config')}调整配置</button><button type="button" class="button small" data-page="logs">${icon('logs')}查看日志</button></div></section></div><div class="summary-strip"><span>本次进程接收<strong>${e(number(status.events?.received))} 条</strong></span><span>正在调用<strong>${e(number(status.usage?.inFlight?.length))} 次</strong></span><span>待写入<strong>${e(number(storage.pendingWrites))} 项</strong></span><span>进程内存<strong>${e(number(Math.round((status.memory?.rssBytes || 0) / 1048576)))} MiB</strong></span></div>`;
}

function pagination(nextCursor, count) {
  return `<div class="pagination"><span>本页 ${e(count)} 条 · 最新优先</span><div><button class="button small" type="button" data-action="first-page" ${state.cursors.length ? '' : 'disabled'}>返回最新</button><button class="button small" type="button" data-action="next-page" ${nextCursor ? '' : 'disabled'}>更早记录 ${icon('arrow')}</button></div></div>`;
}
async function renderEvents(sequence) {
  const f = state.filters.events;
  const result = await api(`/events${query({ limit: 50, ...f, before: state.cursor })}`);
  if (sequence !== state.sequence) return '';
  state.rows = result.items || [];
  state.nextCursor = result.nextCursor;
  return `<section class="panel">${panelHead('全部接收事件', '保留事件与消息段详情；只有已有能力会参与处理。')}
    <form id="events-filter" class="filters"><label>事件类型<select name="postType">${selectOptions([['', '全部类型'], ['message', '消息'], ['message_sent', '自身发送事件'], ['notice', '通知'], ['request', '请求'], ['meta_event', '元事件'], ['unknown', '未知事件']], f.postType)}</select></label><label class="filter-wide">会话<input name="sessionKey" value="${e(f.sessionKey)}" placeholder="例如 g-777030024" autocomplete="off"></label><button type="submit" class="button">筛选</button><button type="button" class="button subtle" data-action="reset-filters">重置</button></form>
    ${state.rows.length ? `<div class="table-wrap"><table><thead><tr><th>收到时间</th><th>事件</th><th>会话 / 发送者</th><th>内容与消息段</th><th>详情</th></tr></thead><tbody>${state.rows.map((row, index) => {
      const info = eventInfo(row);
      return `<tr><td class="mono">${e(date(info.time))}</td><td>${eventTypeBadge(info.postType)}<span class="cell-sub">${e(info.type)}</span></td><td><span class="cell-main mono">${e(info.session)}</span><span class="cell-sub">${e(info.sender)}</span></td><td><span class="cell-main cell-truncate">${e(info.text || '非文本事件')}</span><span class="cell-sub">${e([info.types.join(' · '), ({ trigger_eligible: '可触发已有能力', received_only: '仅接收', blocked: '已封禁，未处理', malformed: '事件结构异常' })[row.handling] || '接收并记录'].filter(Boolean).join(' / '))}</span></td><td class="cell-actions"><button type="button" class="button small" data-action="event-detail" data-index="${index}">查看</button></td></tr>`;
    }).join('')}</tbody></table></div>` : empty('没有符合条件的事件', '清除筛选或等待 QQ 收到新的事件。')}${pagination(result.nextCursor, state.rows.length)}</section>`;
}

const getPath = (value, path, fallback) => path.split('.').reduce((object, key) => object?.[key], value) ?? fallback;
function setPath(value, path, fieldValue) {
  const parts = path.split('.');
  let target = value;
  for (const part of parts.slice(0, -1)) target = target[part] ||= {};
  target[parts.at(-1)] = fieldValue;
}
function toggleField(name, title, description, value) {
  return `<div class="toggle-row"><label class="toggle-copy" for="field-${e(name)}"><strong>${e(title)}</strong><small>${e(description)}</small></label><label class="toggle"><input id="field-${e(name)}" type="checkbox" name="${e(name)}" ${value ? 'checked' : ''}><span aria-hidden="true"></span></label></div>`;
}
function numberField(name, title, value, hint, { min = 0, max, step = 1 } = {}) {
  return `<div class="form-field"><label for="field-${e(name)}">${e(title)}</label><input type="number" id="field-${e(name)}" name="${e(name)}" value="${e(value)}" min="${min}" ${max === undefined ? '' : `max="${max}"`} step="${step}" required><p class="field-hint">${e(hint)}</p></div>`;
}
async function renderConfig(sequence) {
  const result = await api('/config');
  if (sequence !== state.sequence) return '';
  state.config = result;
  state.dirty = false;
  const b = result.behavior || {};
  const p = result.policy || {};
  const connection = result.connection || {};
  const toggle = (name, title, description, fallback = true) => toggleField(name, title, description, getPath({ behavior: b, policy: p }, name, fallback));
  return `<form id="config-form"><div class="config-layout"><section class="panel">${panelHead('对话行为', '保存后应用于后续消息；正在执行的请求保持原流程。')}
    <div class="form-section"><h3>什么时候回应</h3>${toggle('behavior.trigger.at.enabled', '被 @ 时回应', '群消息提及 Bot 时触发。')}${toggle('behavior.trigger.nameCall.enabled', '被叫名字时回应', '命中下面的任意别名时触发。')}${toggle('behavior.trigger.replyQuote.enabled', '被引用时回应', '用户引用 Bot 的消息时触发。')}<div class="form-field full"><label for="aliases">呼唤别名</label><input id="aliases" name="aliases" value="${e((getPath(b, 'trigger.nameCall.aliases', [])).join('，'))}" placeholder="大肥鱼，肥鱼"><p class="field-hint">使用中文或英文逗号分隔。</p></div></div>
    <div class="form-section"><h3>如何回复</h3>${toggle('behavior.reply.delay.enabled', '随机回复延迟', '为回复保留一点自然的停顿。')}<div class="form-grid">${numberField('behavior.reply.delay.minMs', '最短延迟 / 毫秒', getPath(b, 'reply.delay.minMs', 2000), '范围为 0–60,000 毫秒。', { max: 60000 })}${numberField('behavior.reply.delay.maxMs', '最长延迟 / 毫秒', getPath(b, 'reply.delay.maxMs', 8000), '不得小于最短延迟，最多 60,000。', { max: 60000 })}</div>${toggle('behavior.reply.split.enabled', '分段发送回复', '使用分隔符将模型回复拆成多条消息。')}<div class="form-field"><label for="separator">回复分隔符</label><textarea id="separator" name="separator" rows="2" maxlength="20">
${e(getPath(b, 'reply.split.separator', '||'))}</textarea><p class="field-hint">支持换行，最多 20 字符；留空则仅按换行分段。</p></div>${toggle('behavior.reply.quote.enabled', '引用原消息', '回复时带上触发消息的引用。')}</div>
    <div class="form-section"><h3>上下文</h3><p class="section-description">控制人设、记忆和历史消息的总大小。</p>${numberField('behavior.context.budgetBytes', '上下文字节预算', getPath(b, 'context.budgetBytes', 12000), '超出预算后裁剪较早的历史消息。', { min: 512, max: 1000000 })}</div></section>
    <section class="panel">${panelHead('能力与额度', '关闭能力后，对应消息仍会接收并记录。')}${toggle('policy.features.chat', '文字对话', '允许调用聊天模型。')}${toggle('policy.features.vision', '图片理解', '允许已有识图流程处理图片。')}${toggle('policy.features.draw', '绘图', '对所有未被封禁的用户开放。')}${toggle('policy.features.distill', '记忆提炼', '允许离线整理对话记忆。')}<div class="form-section"><h3>每日用量上限</h3><p class="section-description">0 表示不限额。按北京时间自然日计数。</p><div class="form-grid">${numberField('policy.limits.maxCallsPerDay', '最多调用 / 次', getPath(p, 'limits.maxCallsPerDay', 0), '新调用达到上限后停止。', { max: 1000000 })}${numberField('policy.limits.maxTokensPerDay', '最多 Token', getPath(p, 'limits.maxTokensPerDay', 0), '按已知用量判断，不含上游未回传用量。', { max: 1000000000 })}</div></div>
    <div class="form-section"><h3>连接信息</h3><p class="section-description">连接、模型与密钥由环境变量管理。</p><dl class="key-values"><div><dt>QQ 地址</dt><dd class="mono">${e(connection.wsUrl || '—')}</dd></div><div><dt>对话模型</dt><dd class="mono">${e(connection.model || connection.deepseekModel || '—')}</dd></div><div><dt>绘图模型</dt><dd class="mono">${e(connection.imageModel || '—')}</dd></div></dl><p class="field-hint">对话接口：${result.capabilities?.chatConfigured ? '已配置' : '尚未配置密钥'} · 绘图接口：${result.capabilities?.drawConfigured ? '已配置' : '尚未配置密钥'}</p><p class="field-hint">修改环境变量后需要重启 Bot。管理台不显示密钥。</p></div>
    <div class="form-section"><h3>配置版本</h3><p class="field-hint mono">${e(result.revision ?? '—')}</p></div></section></div><div class="save-bar"><p id="save-state">所有配置已同步</p><div><button type="button" class="button" data-action="reload-config">重新读取</button><button type="submit" id="save-config" class="button primary" disabled>保存配置 ${icon('check')}</button></div></div><p id="config-error" class="form-error" role="alert" hidden></p></form>`;
}

const roles = { user: '普通用户', admin: '管理员', blocked: '已封禁' };
async function renderUsers(sequence) {
  const result = await api('/users');
  if (sequence !== state.sequence) return '';
  state.users = result.items || [];
  return `<section class="panel">${panelHead('用户权限', '设置跨会话生效的 QQ 用户角色；也会列出最近接收消息的用户。', `<button type="button" class="button primary" data-action="new-user">${icon('plus')}添加用户</button>`)}<div class="permission-default"><div><strong>默认开放绘图</strong><p>未单独配置的用户沿用默认权限；功能总开关与额度仍然生效。</p></div>${pill(result.defaults?.draw === 'allow' ? '已开放' : result.defaults?.draw || '默认策略')}</div>
    ${state.users.length ? `<div class="table-wrap"><table><thead><tr><th>QQ 用户</th><th>角色</th><th>备注</th><th>更新时间</th><th>管理</th></tr></thead><tbody>${state.users.map((user, index) => `<tr><td class="mono">${e(user.id)}</td><td>${pill(roles[user.role] || user.role, user.role === 'blocked' ? 'danger' : user.role === 'admin' ? 'blue' : 'neutral')}</td><td><span class="cell-truncate cell-main">${e(user.note || user.nickname || '—')}</span><span class="cell-sub">${e(({ environment: '来自 ADMIN_QQ', management: '单独配置', observed: '消息接收时记录' })[user.source] || '')}</span></td><td class="mono">${e(date(user.updatedAt || user.lastSeenAt))}</td><td class="cell-actions"><button type="button" class="button small" data-action="edit-user" data-index="${index}">编辑</button><button type="button" class="button small subtle" data-action="delete-user" data-index="${index}">恢复默认</button></td></tr>`).join('')}</tbody></table></div>` : empty('尚未单独配置用户', '现在所有用户沿用默认权限。可添加 QQ 号并设置管理员或封禁角色。', 'users')}
    <p class="field-hint">QQ 管理员角色用于 Bot 管理指令；进入本网页仍需管理令牌。恢复默认后，ADMIN_QQ 配置的管理员仍保留管理员角色。</p></section>`;
}

const jobTypes = { maintenance: '数据维护', distill: '记忆提炼' };
function scheduleText(schedule) {
  if (!schedule) return '未配置';
  if (schedule.kind === 'once') return `单次 · ${date(schedule.at)}`;
  if (Number(schedule.everyMs) % 60000 !== 0) return `每 ${number(Number(schedule.everyMs) / 1000)} 秒`;
  const minutes = Number(schedule.everyMs) / 60000;
  return minutes >= 1440 && minutes % 1440 === 0 ? `每 ${minutes / 1440} 天` : minutes >= 60 && minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${number(minutes)} 分钟`;
}
async function renderJobs(sequence) {
  const result = await api('/jobs');
  if (sequence !== state.sequence) return '';
  state.jobs = result.items || [];
  return `<section class="panel">${panelHead('计划任务', '定期维护接收记录，或运行已有的记忆提炼。', `<button type="button" class="button primary" data-action="new-job">${icon('plus')}创建任务</button>`)}<div class="notice info">支持间隔执行与指定时间执行。任务不会主动向 QQ 发送消息。</div>
    ${state.jobs.length ? `<div class="table-wrap"><table><thead><tr><th>任务</th><th>执行计划</th><th>下次执行</th><th>上次结果</th><th>状态与管理</th></tr></thead><tbody>${state.jobs.map((job, index) => `<tr><td><span class="cell-main job-name">${e(job.name)}</span><span class="cell-sub">${e(jobTypes[job.type] || job.type)}</span></td><td>${e(scheduleText(job.schedule))}</td><td class="mono">${job.enabled ? e(date(job.nextRunAt)) : job.schedule?.kind === 'once' && job.lastRunAt ? '已执行' : '已暂停'}</td><td>${job.lastStatus ? pill(({ success: '成功', completed: '完成', failed: '失败', error: '失败', interrupted: '已中断', running: '执行中', skipped: '已跳过' })[job.lastStatus] || job.lastStatus, ['error', 'failed', 'interrupted'].includes(job.lastStatus) ? 'danger' : 'neutral') : '<span class="muted">尚未执行</span>'}<span class="cell-sub">${e(date(job.lastRunAt))}</span>${job.lastError ? `<button type="button" class="text-button" data-action="job-error" data-index="${index}">查看原因</button>` : ''}</td><td class="cell-actions"><button type="button" class="button small" data-action="toggle-job" data-index="${index}" aria-label="${job.enabled ? '暂停' : '启用'} ${e(job.name)}">${job.enabled ? '暂停' : '启用'}</button><button type="button" class="button small" data-action="edit-job" data-index="${index}">编辑</button><button type="button" class="button small subtle" data-action="delete-job" data-index="${index}">删除</button></td></tr>`).join('')}</tbody></table></div>` : empty('还没有计划任务', '创建一个定期任务，让数据维护或记忆提炼按时运行。', 'jobs')}</section>`;
}

function logLevel(level) {
  const normalized = String(level || 'info').toLowerCase();
  return pill(normalized.toUpperCase(), ['error', 'fatal'].includes(normalized) ? 'danger' : normalized === 'warn' ? 'warning' : normalized === 'debug' ? 'neutral' : 'blue');
}
async function renderLogs(sequence) {
  const f = state.filters.logs;
  const result = await api(`/logs${query({ limit: 50, ...f, before: state.cursor })}`);
  if (sequence !== state.sequence) return '';
  state.rows = result.items || [];
  state.nextCursor = result.nextCursor;
  return `<section class="panel">${panelHead('日志流', '按级别和关键词定位运行线索。')}<form id="logs-filter" class="filters"><label>日志级别<select name="level">${selectOptions([['', '全部级别'], ['debug', 'DEBUG'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']], f.level)}</select></label><label class="filter-wide">关键词<input name="q" value="${e(f.q)}" placeholder="搜索日志内容" autocomplete="off"></label><button type="submit" class="button">搜索</button><button type="button" class="button subtle" data-action="reset-filters">重置</button></form>
    ${state.rows.length ? `<div class="table-wrap"><table class="log-table"><thead><tr><th>时间</th><th>级别</th><th>内容</th><th>详情</th></tr></thead><tbody>${state.rows.map((row, index) => `<tr><td><time class="mono">${e(date(row.time ?? row.timestamp))}</time></td><td>${logLevel(row.level)}</td><td class="log-message mono">${e(row.message || '')}</td><td class="cell-actions"><button type="button" class="button small" data-action="log-detail" data-index="${index}">查看</button></td></tr>`).join('')}</tbody></table></div>` : empty('没有符合条件的日志', '试试其他级别或关键词，也可以等待下一次运行记录。', 'logs')}${pagination(result.nextCursor, state.rows.length)}</section>`;
}

const kindNames = { chat: '文字对话', vision: '图片理解', draw: '绘图', image: '绘图', distill: '记忆提炼' };
function groupEntries(value, keyName) {
  if (Array.isArray(value)) return value.map((item) => [item[keyName] || item.key || '未分类', item]);
  return Object.entries(value || {});
}
function usageBars(entries, names = {}) {
  const sorted = entries.sort((a, b) => (b[1].calls || 0) - (a[1].calls || 0));
  const max = Math.max(1, ...sorted.map(([, value]) => Number(value.calls) || 0));
  return sorted.length ? sorted.slice(0, 8).map(([key, value]) => `<div class="bar-row"><div class="bar-heading"><span>${e(names[key] || key)}</span><span>${e(number(value.calls))} 次 · ${e(number(value.totalTokens))} Token</span></div><progress class="usage-progress" max="${max}" value="${Number(value.calls) || 0}" aria-label="${e(names[key] || key)} 调用次数">${e(number(value.calls))}</progress></div>`).join('') : empty('暂无调用记录', '发生模型调用后，这里会显示真实用量。', 'usage');
}
async function renderUsage(sequence) {
  const f = state.filters.usage;
  const range = { ...f };
  if (range.since) range.since = new Date(`${range.since}T00:00:00`).toISOString();
  if (range.until) range.until = new Date(`${range.until}T23:59:59.999`).toISOString();
  const result = await api(`/usage${query(range)}`);
  if (sequence !== state.sequence) return '';
  const totals = result.totals || {};
  state.rows = result.items || [];
  return `<section class="panel">${panelHead('观察范围', '统计来自持久化调用记录，不估算缺失的上游用量。')}<form id="usage-filter" class="filters"><label>开始日期<input type="date" name="since" value="${e(f.since)}"></label><label>结束日期<input type="date" name="until" value="${e(f.until)}"></label><label>能力<select name="kind">${selectOptions([['', '全部能力'], ['chat', '文字对话'], ['vision', '图片理解'], ['draw', '绘图'], ['distill', '记忆提炼']], f.kind)}</select></label><label>会话<input name="sessionKey" value="${e(f.sessionKey)}" placeholder="g-群号 / p-QQ号"></label><button type="submit" class="button">应用</button><button type="button" class="button subtle" data-action="reset-filters">重置</button></form></section>
    <div class="metrics-grid usage-metrics">${metric('模型调用', number(totals.calls), `${number(totals.successes)} 次成功 · ${number(totals.failures)} 次失败`, 'usage', '次')}${metric('已知 Token', number(totals.totalTokens), `输入 ${number(totals.promptTokens)} · 输出 ${number(totals.completionTokens)}`, 'config')}${metric('生成图片', number(totals.images), '上游实际返回的图片数量', 'events', '张')}${metric('用量未完整返回', number(totals.unknownUsageCalls), '单独保留，不按零成本推断', 'warning', '次')}</div>
    <div class="usage-grid"><section class="panel">${panelHead('按能力分布', '调用次数与已知 Token。')}${usageBars(groupEntries(result.byKind, 'kind'), kindNames)}</section><section class="panel">${panelHead('活跃会话', '按调用次数排序，最多显示 8 个会话。')}${usageBars(groupEntries(result.bySession, 'sessionKey'))}</section></div>
    <section class="panel">${panelHead('调用明细', `统计覆盖全部匹配记录，下方显示最新 ${state.rows.length} 条。`)}${state.rows.length ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>能力 / 模型</th><th>会话</th><th>结果</th><th>Token</th><th>详情</th></tr></thead><tbody>${state.rows.map((row, index) => `<tr><td class="mono">${e(date(row.time ?? row.timestamp))}</td><td><span class="cell-main">${e(kindNames[row.kind] || row.kind || '—')}</span><span class="cell-sub mono">${e(row.model || '—')}</span></td><td class="mono">${e(row.sessionKey || '—')}</td><td>${row.success === false || ['failed', 'failure', 'error', 'interrupted'].includes(row.status) ? pill('失败', 'danger') : row.success === true || row.status === 'success' ? pill('成功') : pill('已记录', 'neutral')}</td><td class="mono">${row.total_tokens === undefined && row.totalTokens === undefined ? '未返回' : e(number(row.total_tokens ?? row.totalTokens))}</td><td class="cell-actions"><button type="button" class="button small" data-action="usage-detail" data-index="${index}">查看</button></td></tr>`).join('')}</tbody></table></div>` : empty('还没有模型调用', '调用发生后可在此追踪结果与用量。', 'usage')}</section>`;
}
const renderers = { overview: renderOverview, events: renderEvents, config: renderConfig, users: renderUsers, jobs: renderJobs, logs: renderLogs, usage: renderUsage };

function showDialog(title, eyebrow, html) {
  lastFocus = document.activeElement;
  $('#dialog-title').textContent = title;
  $('#dialog-eyebrow').textContent = eyebrow;
  $('#dialog-content').innerHTML = html;
  $('#detail-dialog').showModal();
}
function showJson(title, eyebrow, value, description = '') {
  showDialog(title, eyebrow, `${description ? `<p class="detail-caption">${e(description)}</p>` : ''}<pre class="json-block">${e(JSON.stringify(value, null, 2))}</pre>`);
}
function showUserForm(user) {
  showDialog(user ? '编辑用户' : '添加用户', 'ACCESS / USER', `<form id="user-form" class="dialog-form" data-id="${e(user?.id || '')}"><div class="form-field"><label for="user-id">QQ 号码</label><input id="user-id" name="id" inputmode="numeric" pattern="[0-9]{1,20}" maxlength="20" value="${e(user?.id || '')}" ${user ? 'readonly' : ''} required autocomplete="off" placeholder="输入 QQ 号码"></div><div class="form-field"><label for="user-role">角色</label><select id="user-role" name="role">${selectOptions(Object.entries(roles), user?.role || 'user')}</select><p class="field-hint">管理员可使用 Bot 的管理指令；封禁用户的消息仍然接收，但不触发业务能力。</p></div><div class="form-field"><label for="user-note">备注</label><textarea id="user-note" name="note" maxlength="300" placeholder="可选，帮助你识别这个用户">${e(user?.note || '')}</textarea></div><p class="form-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button" data-action="close-dialog">取消</button><button type="submit" class="button primary">保存用户</button></div></form>`);
}
function localDateTime(value) {
  const time = new Date(value || Date.now() + 3600000);
  const local = new Date(time.getTime() - time.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function showJobForm(job) {
  const kind = job?.schedule?.kind || 'interval';
  showDialog(job ? '编辑任务' : '创建任务', 'SCHEDULER / JOB', `<form id="job-form" class="dialog-form" data-id="${e(job?.id || '')}"><div class="form-field"><label for="job-name">任务名称</label><input id="job-name" name="name" value="${e(job?.name || '')}" required maxlength="80" placeholder="例如：每日数据维护"></div><div class="form-field"><label for="job-type">任务类型</label><select id="job-type" name="type">${selectOptions(Object.entries(jobTypes), job?.type || 'maintenance')}</select><p class="field-hint">数据维护按保留策略清理记录；记忆提炼运行已有的对话整理流程。</p></div><div class="form-field"><label for="job-kind">执行方式</label><select id="job-kind" name="kind">${selectOptions([['interval', '按固定间隔'], ['once', '在指定时间执行一次']], kind)}</select></div><div id="interval-field" class="form-field" ${kind === 'interval' ? '' : 'hidden'}><label for="job-interval">间隔 / 秒</label><input id="job-interval" name="seconds" type="number" value="${e((job?.schedule?.everyMs || 3600000) / 1000)}" min="1" max="31536000" step="0.001" ${kind === 'interval' ? 'required' : 'disabled'}><p class="field-hint">最少 1 秒。60 秒 = 1 分钟；3600 秒 = 1 小时。</p></div><div id="once-field" class="form-field" ${kind === 'once' ? '' : 'hidden'}><label for="job-at">执行时间（浏览器本地时区）</label><input id="job-at" name="at" type="datetime-local" value="${e(localDateTime(job?.schedule?.at))}" ${kind === 'once' ? 'required' : 'disabled'}></div>${toggleField('enabled', '启用任务', '关闭后保留任务，但暂停执行。', job?.enabled ?? true)}<p class="form-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button" data-action="close-dialog">取消</button><button type="submit" class="button primary">保存任务</button></div></form>`);
}

async function withButton(button, action) {
  if (button.disabled) return;
  button.disabled = true;
  try { await action(); } catch (error) { if (state.token) toast(error.message, true); }
  finally { if (button.isConnected) button.disabled = false; }
}
function lockForm(form) {
  const original = [...form.elements].map((field) => [field, field.disabled]);
  for (const [field] of original) field.disabled = true;
  return () => { for (const [field, disabled] of original) field.disabled = disabled; };
}
function closeDialog() {
  if (state.saving) { toast('正在保存，请稍候。'); return; }
  $('#detail-dialog').close();
}
async function saveConfig(form) {
  if (state.saving) return;
  const button = $('#save-config');
  const errorElement = $('#config-error');
  errorElement.hidden = true;
  const draft = { revision: state.config.revision, behavior: structuredClone(state.config.behavior || {}), policy: structuredClone(state.config.policy || {}) };
  for (const field of form.elements) {
    if (!field.name.startsWith('behavior.') && !field.name.startsWith('policy.')) continue;
    setPath(draft, field.name, field.type === 'checkbox' ? field.checked : field.type === 'number' ? Number(field.value) : field.value);
  }
  setPath(draft.behavior, 'trigger.nameCall.aliases', form.elements.aliases.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean));
  setPath(draft.behavior, 'reply.split.separator', form.elements.separator.value);
  if (draft.behavior.reply.delay.maxMs < draft.behavior.reply.delay.minMs) {
    errorElement.textContent = '最长延迟不能小于最短延迟。';
    errorElement.hidden = false;
    return;
  }
  state.saving = true;
  const unlock = lockForm(form);
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    await api('/config', { method: 'PUT', body: draft });
    state.dirty = false;
    await loadPage();
    toast('配置已保存，后续消息将使用新设置。');
  } catch (error) {
    if (!state.token) return;
    errorElement.textContent = error.message;
    errorElement.hidden = false;
    button.disabled = false;
    button.textContent = '保存配置';
  } finally { state.saving = false; unlock(); }
}
async function saveDialogForm(form) {
  if (state.saving) return;
  const button = $('button[type="submit"]', form);
  const errorElement = $('.form-error', form);
  errorElement.hidden = true;
  state.saving = true;
  const unlock = lockForm(form);
  button.disabled = true;
  try {
    if (form.id === 'user-form') {
      const id = form.elements.id.value.trim();
      await api(`/users/${encodeURIComponent(id)}`, { method: 'PUT', body: { role: form.elements.role.value, note: form.elements.note.value.trim() } });
    } else {
      const fields = form.elements;
      let schedule;
      if (fields.kind.value === 'once') {
        const time = new Date(fields.at.value);
        if (!Number.isFinite(time.getTime()) || ((!form.dataset.id || fields.enabled.checked) && time.getTime() <= Date.now())) throw new Error('请选择未来的执行时间。');
        schedule = { kind: 'once', at: time.toISOString() };
      } else schedule = { kind: 'interval', everyMs: Math.round(Number(fields.seconds.value) * 1000) };
      const body = { name: fields.name.value.trim(), type: fields.type.value, schedule, enabled: fields.enabled.checked };
      if (!body.name) throw new Error('请输入任务名称。');
      await api(form.dataset.id ? `/jobs/${encodeURIComponent(form.dataset.id)}` : '/jobs', { method: form.dataset.id ? 'PUT' : 'POST', body });
    }
    $('#detail-dialog').close();
    await loadPage();
    toast(form.id === 'user-form' ? '用户权限已保存。' : '任务已保存。');
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  } finally { state.saving = false; unlock(); }
}

document.addEventListener('click', async (event) => {
  const link = event.target.closest('[data-page]');
  if (link) { event.preventDefault(); navigate(link.dataset.page); return; }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const index = Number(button.dataset.index);
  if (action === 'close-dialog') { closeDialog(); return; }
  if (action === 'retry') { loadPage(); return; }
  if (action === 'reload-config') { if (canLeave()) { state.dirty = false; loadPage(); } return; }
  if (action === 'reset-filters') {
    for (const key of Object.keys(state.filters[state.page])) state.filters[state.page][key] = '';
    state.cursor = null; state.cursors = []; loadPage(); return;
  }
  if (action === 'next-page') { state.cursors.push(state.cursor); state.cursor = state.nextCursor; loadPage(); return; }
  if (action === 'first-page') { state.cursor = null; state.cursors = []; loadPage(); return; }
  if (action === 'event-detail') { showJson('接收事件详情', 'INBOX / EVENT', state.rows[index], '这里只展示已接收的数据。未知消息段会保留原始字段，不自动执行。'); return; }
  if (action === 'log-detail') { showJson('日志详情', 'LOGS / RECORD', state.rows[index]); return; }
  if (action === 'usage-detail') { showJson('调用详情', 'USAGE / CALL', state.rows[index]); return; }
  if (action === 'new-user' || action === 'edit-user') { showUserForm(action === 'edit-user' ? state.users[index] : null); return; }
  if (action === 'new-job' || action === 'edit-job') { showJobForm(action === 'edit-job' ? state.jobs[index] : null); return; }
  if (action === 'job-error') { showJson('任务执行详情', 'SCHEDULER / RESULT', state.jobs[index]); return; }
  if (action === 'delete-user') {
    const user = state.users[index];
    if (!window.confirm(`将 QQ ${user.id} 恢复为默认权限？单独设置的角色和备注将被删除。`)) return;
    await withButton(button, async () => { await api(`/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' }); await loadPage(); toast('用户已恢复默认权限。'); }); return;
  }
  if (action === 'delete-job') {
    const job = state.jobs[index];
    if (!window.confirm(`删除任务「${job.name}」？删除后不能恢复。`)) return;
    await withButton(button, async () => { await api(`/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' }); await loadPage(); toast('任务已删除。'); }); return;
  }
  if (action === 'toggle-job') {
    const job = state.jobs[index];
    if (!job.enabled && job.schedule?.kind === 'once' && Date.parse(job.schedule.at) <= Date.now()) { showJobForm({ ...job, enabled: true }); toast('请为这项单次任务设置新的执行时间。'); return; }
    await withButton(button, async () => { await api(`/jobs/${encodeURIComponent(job.id)}`, { method: 'PUT', body: { name: job.name, type: job.type, schedule: job.schedule, enabled: !job.enabled } }); await loadPage(); toast(job.enabled ? '任务已暂停。' : '任务已启用。'); });
  }
});
document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (form.id === 'login-form') return;
  event.preventDefault();
  if (form.id === 'config-form') { await saveConfig(form); return; }
  if (form.id === 'user-form' || form.id === 'job-form') { await saveDialogForm(form); return; }
  const page = form.id.replace('-filter', '');
  if (!state.filters[page]) return;
  const draft = Object.fromEntries(new FormData(form).entries());
  if (page === 'usage' && draft.since && draft.until && draft.since > draft.until) { toast('开始日期不能晚于结束日期。', true); return; }
  state.filters[page] = draft;
  state.cursor = null; state.cursors = [];
  loadPage();
});
document.addEventListener('input', (event) => { if (event.target.closest('#config-form')) markDirty(); });
document.addEventListener('change', (event) => {
  if (event.target.id === 'job-kind') {
    const once = event.target.value === 'once';
    $('#once-field').hidden = !once; $('#interval-field').hidden = once;
    $('#job-at').disabled = !once; $('#job-at').required = once;
    $('#job-interval').disabled = once; $('#job-interval').required = !once;
  }
  if (event.target.closest('#config-form')) markDirty();
});
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('.login-submit');
  const token = $('#admin-token').value.trim();
  if (!token) return;
  button.disabled = true;
  button.textContent = '连接管理服务…';
  $('#login-error').hidden = true;
  try {
    const status = await api('/status', { token });
    state.token = token;
    $('#admin-token').value = '';
    $('#login').hidden = true;
    $('#app').hidden = false;
    updateStatus(status);
    await loadPage();
    $('#content').focus();
  } catch (error) {
    $('#login-error').textContent = error.message;
    $('#login-error').hidden = false;
  } finally { button.disabled = false; button.innerHTML = '进入管理台 <span aria-hidden="true">↗</span>'; }
});
$('#toggle-token').addEventListener('click', () => {
  const show = $('#admin-token').type === 'password';
  $('#admin-token').type = show ? 'text' : 'password';
  $('#toggle-token').textContent = show ? '隐藏' : '显示';
  $('#toggle-token').setAttribute('aria-pressed', String(show));
  $('#toggle-token').setAttribute('aria-label', show ? '隐藏管理令牌' : '显示管理令牌');
});
$('#logout').addEventListener('click', () => { if (canLeave()) logout(); });
$('#refresh').innerHTML = icon('refresh');
$('#refresh').addEventListener('click', () => { if (canLeave()) { state.dirty = false; loadPage(); } });
$('#close-dialog').addEventListener('click', closeDialog);
$('#detail-dialog').addEventListener('cancel', (event) => { if (state.saving) event.preventDefault(); });
$('#detail-dialog').addEventListener('close', () => { if (lastFocus?.isConnected) lastFocus.focus(); });
$('#auto-refresh').addEventListener('change', (event) => { state.live = event.target.checked; });
$('#navigation').innerHTML = Object.entries(pages).map(([page, [title]]) => `<a href="#${page}" data-page="${page}" class="nav-item">${icon(page)}<span>${e(title)}</span></a>`).join('');
window.addEventListener('beforeunload', (event) => { if (state.dirty || state.saving) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('hashchange', () => {
  const next = location.hash.slice(1);
  if (pages[next] && next !== state.page) navigate(next);
  history.replaceState(null, '', `#${state.page}`);
});
setInterval(() => {
  if (state.token && state.live && !state.loading && !state.dirty && !document.hidden && !$('#detail-dialog').open && !state.cursor && ['overview', 'events', 'logs', 'usage'].includes(state.page) && !$('#content').contains(document.activeElement)) loadPage({ quiet: true });
}, 20000);
