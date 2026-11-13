import { usageMoney, usageTime, usageSession, renderUsageShareContent } from './usage-view.js';
import { renderRequestsView, renderRequestDetail, renderRequestTrace } from './request-view.js';
import { describeLog } from '../src/utils/log-format.js';
import { createImageLab } from './image-lab.js';

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
  events: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8 11h8M8 14h5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  jobs: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  logs: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  usage: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3a7 7 0 0 0 11.6-2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  shield: '<path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Z"/><path d="m8 12 3 3 5-6"/>',
  inbox: '<path d="m4 4-3 9v7h22v-7l-3-9H4Z"/><path d="M1 13h6l2 4h6l2-4h6"/>',
  warning: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.events}</svg>`;
const pages = {
  overview: ['运行概览', ''],
  events: ['消息收件箱', '所有接收事件都在这里；接收不等于自动处理。'],
  prompt: ['Prompt 工作台', '编辑 → 保存 → 测试与评审 → 发布。草稿不会直接影响线上。'],
  images: ['素材库', '浏览生成的图片、提示词与来源会话。'],
  memes: ['素材库', '浏览已记录的表情与收藏状态。'],
  'image-lab': ['开发者生图台', '用文字或参考图调试绘图 API，查看请求和生成结果。'],
  config: ['对话与能力', '设置 Bot 如何回复、开放哪些能力，以及每天最多用多少。'],
  users: ['用户与权限', '默认开放，需要时再为个别用户设置边界。'],
  jobs: ['任务调度', '安排记忆提炼与数据维护，查看执行结果。'],
  logs: ['排障', '按会话追查失败、正常跳过和完整业务链路。'],
  usage: ['用量与费用', '查看模型调用、Token 和预估费用。'],
  requests: ['排障', '查看模型调用频率、耗时和失败原因。'],
};
const navigation = [
  ['运行', [['overview', '概览'], ['usage', '用量与费用'], ['requests', '排障', 'logs']]],
  ['Bot 管理', [['config', '对话与能力'], ['prompt', 'Prompt'], ['users', '用户权限'], ['jobs', '任务调度']]],
  ['素材', [['images', '绘图作品'], ['memes', '表情收藏'], ['image-lab', '开发者生图台']]],
];
const resolvePage = (page) => page === 'media' ? 'images' : page;
const initialPage = resolvePage(location.hash.slice(1));
const state = {
  token: '', tokenExpiresAt: 0, page: pages[initialPage] ? initialPage : 'overview',
  config: null, dirty: false, saving: false, loading: false, live: false, sequence: 0,
  rows: [], jobs: [], users: [], cursor: null, cursors: [],
  filters: { requests: { period: 'today', kind: '', source: '', sessionKey: '' }, events: { postType: '', sessionKey: '' }, logs: { failuresOnly: 'true', level: '', q: '', sessionKey: '' }, usage: { period: 'today', since: '', until: '', detailKind: '', pendingOnly: '', sessionKey: '' } },
  requestDashboard: null, requestTrace: null, requestTraceVersion: 0,
};
let promptConsole;
let imageLab;
let usageReportUrl;
const mediaGalleries = new Map();
if (location.hash === '#media') history.replaceState(null, '', '#images');
let toastTimer;
let lastFocus;
const LOGIN_STORAGE_KEY = 'big-fat-fish.admin-session.v1';
const LOGIN_DURATION_MS = 30 * 60 * 1000;
const LOGIN_EXPIRED_MESSAGE = '登录已超过 30 分钟，请重新输入管理令牌。';
let loginAttempt = 0;
let loginTimer;

function clearSavedLogin() {
  try { localStorage.removeItem(LOGIN_STORAGE_KEY); } catch { /* Storage may be disabled. */ }
}

function readSavedLogin() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOGIN_STORAGE_KEY));
    if (typeof saved?.token === 'string' && saved.token.trim()
      && Number.isFinite(saved.expiresAt) && saved.expiresAt > Date.now()
      && saved.expiresAt <= Date.now() + LOGIN_DURATION_MS) return saved;
  } catch { /* Invalid or unavailable storage must not prevent manual login. */ }
  clearSavedLogin();
  return null;
}

function expireLogin() {
  if (!state.token || !state.tokenExpiresAt || Date.now() < state.tokenExpiresAt) return false;
  logout(LOGIN_EXPIRED_MESSAGE);
  return true;
}

function resetLoginButton() {
  $('.login-submit').disabled = false;
  $('.login-submit').innerHTML = '进入工作台 <span aria-hidden="true">↗</span>';
}

async function login(token, expiresAt = null) {
  const attempt = ++loginAttempt;
  $('.login-submit').disabled = true;
  $('.login-submit').textContent = expiresAt ? '正在恢复登录…' : '连接管理服务…';
  $('#login-error').hidden = true;
  try {
    const status = await api('/status', { token });
    if (attempt !== loginAttempt) return;
    const deadline = expiresAt ?? Date.now() + LOGIN_DURATION_MS;
    if (deadline <= Date.now()) { logout(LOGIN_EXPIRED_MESSAGE); return; }
    // Restoring a login keeps its original deadline; only manual login starts a new period.
    if (expiresAt === null) {
      try { localStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify({ token, expiresAt: deadline })); }
      catch { clearSavedLogin(); toast('浏览器无法保存登录状态，刷新后需重新输入令牌。', true); }
    }
    state.token = token;
    state.tokenExpiresAt = deadline;
    clearTimeout(loginTimer);
    loginTimer = setTimeout(expireLogin, deadline - Date.now());
    $('#admin-token').value = '';
    $('#login').hidden = true;
    $('#app').hidden = false;
    updateStatus(status);
    await loadPage();
    if (attempt === loginAttempt && state.token) $('#content').focus({ preventScroll: true });
  } catch (error) {
    if (attempt !== loginAttempt) return;
    if (error.status === 401) clearSavedLogin();
    $('#login-error').textContent = error.message;
    $('#login-error').hidden = false;
  } finally { if (attempt === loginAttempt) resetLoginButton(); }
}

async function restoreLogin() {
  const saved = readSavedLogin();
  if (saved) await login(saved.token, saved.expiresAt);
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 7000 : 3500);
}

function logout(message = '', { forget = true } = {}) {
  loginAttempt++;
  clearTimeout(loginTimer);
  if (forget) clearSavedLogin();
  resetLoginButton();
  promptConsole?.clear();
  imageLab?.clear();
  imageLab = null;
  clearUsageReport();
  state.usageDashboard = null;
  state.requestDashboard = null;
  state.requestTrace = null;
  state.requestTraceVersion++;
  for (const gallery of mediaGalleries.values()) gallery.clear();
  state.token = '';
  state.tokenExpiresAt = 0;
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

async function api(path, { method = 'GET', body, token = state.token, responseType = 'json', timeoutMs = 20000 } = {}) {
  if (token === state.token && expireLogin()) throw new Error(LOGIN_EXPIRED_MESSAGE);
  let response;
  try {
    const json = body !== undefined && !(body instanceof FormData);
    response = await fetch(`/api${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body: json ? JSON.stringify(body) : body, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? '请求超时，请稍后重试。' : '无法连接管理服务，请检查 Bot 是否仍在运行。');
  }
  if (response.ok && responseType === 'blob') {
    const blob = await response.blob();
    if (token !== state.token) throw new Error('登录状态已改变。');
    return blob;
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

async function fetchMediaFile(key, variant = 'original') {
  if (expireLogin()) throw new Error(LOGIN_EXPIRED_MESSAGE);
  const token = state.token;
  if (!token) throw new Error('请先登录。');
  const response = await fetch(`/api/media/file?${new URLSearchParams({ key, variant })}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(30000),
  });
  if (response.status === 401 && token === state.token) logout('管理令牌已失效，请重新登录。');
  if (!response.ok) throw new Error(response.status === 404 ? '这张图片已不存在。' : '图片暂时无法读取，请稍后重试。');
  const blob = await response.blob();
  if (token !== state.token) throw new Error('登录状态已改变。');
  return blob;
}

const query = (values) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== '' && value !== null && value !== undefined) params.set(key, value);
  return params.toString() ? `?${params}` : '';
};
const pill = (text, color = '') => `<span class="badge ${color}">${e(text)}</span>`;
const empty = (title, description, name = 'inbox') => `<div class="empty-state"><div class="empty-icon">${icon(name)}</div><h3>${e(title)}</h3><p>${e(description)}</p></div>`;
const panelHead = (title, description = '', action = '') => `<div class="panel-header"><div><h2>${e(title)}</h2>${description ? `<p>${e(description)}</p>` : ''}</div>${action}</div>`;
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
  updateAnnotationPreview(status?.annotationPreview);
}
function updateAnnotationPreview(preview) {
  const button = $('#annotation-preview');
  button.hidden = preview?.available !== true;
  button.dataset.enabled = String(preview?.enabled === true);
  button.setAttribute('aria-pressed', button.dataset.enabled);
  button.textContent = `批注兼容 · ${preview?.enabled ? '开' : '关'}`;
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
  page = resolvePage(page);
  if (!pages[page] || page === state.page) return;
  if (!canLeave()) return;
  state.page = page;
  state.dirty = false;
  state.cursor = null;
  state.cursors = [];
  history.replaceState(null, '', `#${page}`);
  loadPage();
  $('#page-title').focus();
}

function renderNavigation(page) {
  const primary = $('#navigation');
  if (primary.dataset.page === page) return;
  primary.dataset.page = page;
  const [, sections] = navigation.find(([, entries]) => entries.some(([key, , related]) => page === key || page === related)) || navigation[0];
  const link = (key, label, current) => `<a href="#${key}" data-page="${key}"${current ? ` aria-current="${current}"` : ''}>${e(label)}</a>`;
  primary.innerHTML = navigation.map(([label, entries]) => link(entries[0][0], label, entries === sections ? 'true' : '')).join('');
  $('#section-navigation').innerHTML = sections.map(([key, label, related]) => link(key, label, page === key ? 'page' : page === related ? 'true' : '')).join('');
  const diagnostic = $('#diagnostic-navigation');
  diagnostic.hidden = page !== 'requests' && page !== 'logs';
  diagnostic.innerHTML = diagnostic.hidden ? '' : link('requests', '模型请求', page === 'requests' ? 'page' : '') + link('logs', '运行日志', page === 'logs' ? 'page' : '');
}

async function loadPage({ quiet = false } = {}) {
  if (!state.token) return;
  const sequence = ++state.sequence;
  const page = state.page;
  if (page === 'usage' && $('#usage-ledger')) state.usageDetailsOpen = $('#usage-ledger').open;
  for (const gallery of mediaGalleries.values()) gallery.detach();
  state.loading = true;
  $('#refresh').disabled = true;
  const [title, description] = pages[page];
  $('#page-title').textContent = title;
  $('#page-description').textContent = description;
  $('#page-description').hidden = !description;
  $('#connection-status').hidden = page === 'overview';
  document.title = `${title} · 大肥鱼`;
  $('#live-control').hidden = !['overview', 'events', 'logs', 'usage', 'requests'].includes(page);
  renderNavigation(page);
  $('#content').setAttribute('aria-busy', 'true');
  if (!quiet) $('#content').innerHTML = '<section class="panel loading-state"><span class="spinner" aria-hidden="true"></span><p>正在读取运行数据…</p></section>';
  try {
    const html = await renderers[page](sequence);
    if (sequence !== state.sequence || !state.token) return;
    $('#content').innerHTML = html;
    if (page === 'prompt') promptConsole.attach($('#content'));
    if (page === 'image-lab') {
      $('#content').append(imageLab.element);
      imageLab.refresh();
    }
    if (page === 'images' || page === 'memes') mediaGalleries.get(page)?.attach($('#content'));
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
async function renderOverview(sequence) {
  const [status, failures, jobs, config] = await Promise.all([
    api('/status'), api('/logs?limit=6&failuresOnly=true').catch(() => null),
    api('/jobs').catch(() => null), api('/config').catch(() => null),
  ]);
  if (sequence !== state.sequence) return '';
  state.rows = failures?.items || [];
  updateStatus(status);
  const connection = connectionInfo(status.connection);
  const scheduler = status.scheduler;
  const active = jobs?.items?.find((job) => job.id === scheduler?.activeJobId);
  const latest = jobs?.items?.filter((job) => job.lastRunAt && job.lastStatus !== 'running').sort((a, b) => b.lastRunAt - a.lastRunAt)[0];
  const schedulerText = scheduler?.activeJobId ? '正在执行' : scheduler?.running === true ? '运行中 · 当前空闲' : scheduler?.running === false ? '未运行' : '状态暂不可读';
  const lastExecution = latest ? `${e(latest.name)} ${jobResult(latest)}<span class="cell-sub">${e(date(latest.lastRunAt))}</span>`
    : jobs?.items?.length ? '尚无已结束的任务' : jobs ? '暂无计划任务' : '执行记录暂不可读';
  const usage = status.usage?.today || status.usage?.totals || status.usage || {};
  const ledgerAvailable = status.usage?.ledgerAvailable !== false && status.usage?.today !== null;
  const persistenceError = status.storage?.lastError?.message || status.storage?.usage?.lastWriteError || status.usage?.lastPersistenceError || status.logStats?.lastError || scheduler?.lastError;
  const usageSummary = !ledgerAvailable ? '<p class="muted">用量账本暂不可读</p>' : !usage.calls ? '<p class="muted">今天暂无模型调用</p>'
    : `<dl class="key-values"><div><dt>今日调用</dt><dd><strong>${e(number(usage.calls))}</strong> 次</dd></div><div><dt>已报告 Token</dt><dd>${e(number(usage.totalTokens))}</dd></div><div><dt>失败调用 / 出图</dt><dd>${e(number(usage.failures))} 次 / ${e(number(usage.images))} 张</dd></div></dl>`;
  return `${persistenceError ? `<div class="notice error" role="alert">持久化或调度存在异常：${e(typeof persistenceError === 'object' ? JSON.stringify(persistenceError) : persistenceError)}</div>` : ''}
    <div class="overview-grid">
      <section class="panel">${panelHead('当前状态', '', pageLink('jobs', '任务调度'))}
        <dl class="key-values"><div><dt>QQ 连接</dt><dd>${pill(connection.text, connection.dot)}<span class="cell-sub">最近收到事件 ${e(date(status.connection?.lastEventAt))}</span></dd></div>
        <div><dt>调度器</dt><dd>${pill(schedulerText, scheduler?.activeJobId ? 'blue' : scheduler?.running ? '' : 'neutral')}${active ? `<span class="cell-sub">${e(active.name)}</span>` : ''}</dd></div>
        <div><dt>最近任务结果</dt><dd>${lastExecution}</dd></div></dl>
      </section>
      <section class="panel">${panelHead('今日用量', '', pageLink('usage', '查看用量'))}${usageSummary}</section>
    </div>
    <section class="panel">${panelHead('最近失败', '', pageLink('logs', '进入排障'))}${failures ? recentFailures(state.rows) : '<div class="notice error" role="alert">失败记录暂时无法读取，请到运行日志重试。</div>'}</section>
    <details id="instance-details" class="panel instance-details"${$('#instance-details')?.open ? ' open' : ''}>
      <summary>实例详情</summary>
      <dl class="key-values"><div><dt>运行时间</dt><dd>${e(duration(status.uptimeSeconds))} · 启动于 ${e(date(status.startedAt))}</dd></div>
        <div><dt>数据目录</dt><dd class="mono">${e(status.storage?.dataDir || '—')}</dd></div>
        <div><dt>待发送 / 进行中调用 / 待写入</dt><dd>${e(number(status.sender?.queued))} / ${e(number(status.usage?.inFlight?.length))} / ${e(number(status.storage?.pendingWrites))}</dd></div>
        <div><dt>进程内存</dt><dd>${e(number(Math.round((status.memory?.rssBytes || 0) / 1048576)))} MiB</dd></div>
        ${config ? `<div><dt>QQ 地址</dt><dd class="mono">${e(config.connection?.wsUrl || '—')}</dd></div>
        <div><dt>对话模型</dt><dd class="mono">${e(config.connection?.model || config.connection?.deepseekModel || '—')}</dd></div>
        <div><dt>绘图模型</dt><dd class="mono">${e(config.connection?.imageModel || '—')}</dd></div>
        <div><dt>配置版本</dt><dd class="mono">${e(config.revision ?? '—')}</dd></div>` : ''}
      </dl>
      <p class="field-hint">${config ? `对话接口：${config.capabilities?.chatConfigured ? '已配置' : '尚未配置密钥'} · 绘图接口：${config.capabilities?.drawConfigured ? '已配置' : '尚未配置密钥'}。修改连接或模型的环境变量后需重启 Bot。` : '连接和模型配置暂不可读。'}</p>
    </details>`;
}

function recentFailures(items) {
  if (!items.length) return '<p class="muted">暂无失败、降级或结果未知的记录。</p>';
  return `<div class="event-list">${items.map((row, index) => {
    const info = describeLog(row);
    return `<div class="event-row failure-row"><span class="event-icon">${icon('warning')}</span><div class="event-text"><strong>${e(info.title)} · ${e(info.result)}</strong><p>${e(row.sessionKey || '系统')} · ${e(info.detail || row.message)}</p></div><time>${e(date(row.time, true))}</time><button type="button" class="button small" data-action="log-detail" data-index="${index}">详情</button></div>`;
  }).join('')}</div>`;
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
  const toggle = (name, title, description, fallback = true) => toggleField(name, title, description, getPath({ behavior: b, policy: p }, name, fallback));
  return `<form id="config-form"><section class="panel">${panelHead('对话行为', '保存后的设置用于后续消息。')}
    <div class="form-section"><h3>什么时候回应</h3>${toggle('behavior.trigger.at.enabled', '被 @ 时回应', '群消息提及 Bot 时触发。')}${toggle('behavior.trigger.nameCall.enabled', '被叫名字时回应', '命中下面的任意别名时触发。')}${toggle('behavior.trigger.replyQuote.enabled', '被引用时回应', '用户引用 Bot 的消息时触发。')}${toggle('behavior.trigger.poke.enabled', '被戳一戳时回应', '群聊和私聊被戳时，结合人设回复一句短话。')}<div class="form-field full"><label for="aliases">呼唤别名</label><input id="aliases" name="aliases" value="${e((getPath(b, 'trigger.nameCall.aliases', [])).join('，'))}" placeholder="大肥鱼，肥鱼"><p class="field-hint">使用中文或英文逗号分隔。</p></div></div>
    <div class="form-section"><h3>戳一戳短回复</h3><div class="form-field"><label for="poke-prompt">回复提示词</label><textarea id="poke-prompt" name="behavior.trigger.poke.prompt" rows="3" maxlength="2000" required>${e(getPath(b, 'trigger.poke.prompt', ''))}</textarea><p class="field-hint">沿用当前人设与对话上下文，立即发送一条文字回复。</p></div></div>
    <div class="form-section"><h3>对话冷却</h3>${numberField('behavior.chat.cooldownMs', '冷却时间 / 毫秒', getPath(b, 'chat.cooldownMs', 2000), '2000 毫秒 = 2 秒。同一会话从开始响应计时，聊天与戳一戳共用；0 表示关闭。', { max: 60000 })}</div>
    <div class="form-section"><h3>如何回复</h3>${toggle('behavior.reply.delay.enabled', '随机回复延迟', '为回复保留一点自然的停顿。')}<div class="form-grid">${numberField('behavior.reply.delay.minMs', '最短延迟 / 毫秒', getPath(b, 'reply.delay.minMs', 2000), '范围为 0–60,000 毫秒。', { max: 60000 })}${numberField('behavior.reply.delay.maxMs', '最长延迟 / 毫秒', getPath(b, 'reply.delay.maxMs', 8000), '不得小于最短延迟，最多 60,000。', { max: 60000 })}</div>${toggle('behavior.reply.split.enabled', '分段发送回复', '使用分隔符将模型回复拆成多条消息。')}<div class="form-field"><label for="separator">回复分隔符</label><textarea id="separator" name="separator" rows="2" maxlength="20">
${e(getPath(b, 'reply.split.separator', '||'))}</textarea><p class="field-hint">支持换行，最多 20 字符；留空则仅按换行分段。</p></div>${toggle('behavior.reply.quote.enabled', '引用原消息', '回复时带上触发消息的引用。')}</div>
    <div class="form-section"><h3>上下文</h3><p class="section-description">历史筛选与字节预算由 Prompt 发布版本统一管理。</p>${pageLink('prompt', '前往 Prompt 工作台')}</div></section>
    <section class="panel">${panelHead('能力开关', '关闭能力后，对应消息仍会接收并记录。')}${toggle('policy.features.chat', '文字对话', '允许调用聊天模型。')}${toggle('policy.features.vision', '图片理解', '允许已有识图流程处理图片。')}${toggle('policy.features.draw', '绘图', '对所有未被封禁的用户开放。')}${toggle('policy.features.distill', '记忆提炼', '允许离线整理对话记忆。')}</section>
    <section class="panel">${panelHead('每日用量上限', '按北京时间自然日计数。0 表示不限额。')}<div class="form-grid">${numberField('policy.limits.maxCallsPerDay', '最多调用 / 次', getPath(p, 'limits.maxCallsPerDay', 0), '新调用达到上限后停止。', { max: 1000000 })}${numberField('policy.limits.maxTokensPerDay', '最多 Token', getPath(p, 'limits.maxTokensPerDay', 0), '按已知用量判断，不含上游未回传用量。', { max: 1000000000 })}</div></section>
    <div class="save-bar"><p id="save-state">所有配置已同步</p><div><button type="button" class="button" data-action="reload-config">重新读取</button><button type="submit" id="save-config" class="button primary" disabled>保存配置 ${icon('check')}</button></div></div><p id="config-error" class="form-error" role="alert" hidden></p></form>`;
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
const jobStatuses = {
  success: ['成功', ''], completed: ['完成', ''], failed: ['失败', 'danger'], error: ['失败', 'danger'],
  interrupted: ['已中断', 'danger'], running: ['执行中', 'blue'], skipped: ['已跳过', 'neutral'],
};
function jobResult(job) {
  if (!job.lastStatus) return pill('尚未执行', 'neutral');
  const [text, color] = Object.hasOwn(jobStatuses, job.lastStatus) ? jobStatuses[job.lastStatus] : [job.lastStatus, 'neutral'];
  return pill(text, color);
}
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
    ${state.jobs.length ? `<div class="table-wrap"><table><thead><tr><th>任务</th><th>执行计划</th><th>下次执行</th><th>执行状态 / 上次结果</th><th>管理</th></tr></thead><tbody>${state.jobs.map((job, index) => `<tr><td><span class="cell-main job-name">${e(job.name)}</span><span class="cell-sub">${e(jobTypes[job.type] || job.type)}</span></td><td>${e(scheduleText(job.schedule))}</td><td class="mono">${job.enabled ? e(date(job.nextRunAt)) : job.schedule?.kind === 'once' && job.lastRunAt ? '—' : '已暂停'}</td><td>${jobResult(job)}${job.lastRunAt ? `<span class="cell-sub">${e(date(job.lastRunAt))}</span>` : ''}${job.lastError ? `<button type="button" class="text-button" data-action="job-error" data-index="${index}">查看原因</button>` : ''}</td><td class="cell-actions"><button type="button" class="button small" data-action="toggle-job" data-index="${index}" aria-label="${job.enabled ? '暂停' : '启用'} ${e(job.name)}">${job.enabled ? '暂停' : '启用'}</button><button type="button" class="button small" data-action="edit-job" data-index="${index}">编辑</button><button type="button" class="button small subtle" data-action="delete-job" data-index="${index}">删除</button></td></tr>`).join('')}</tbody></table></div>` : empty('还没有计划任务', '创建一个定期任务，让数据维护或记忆提炼按时运行。', 'jobs')}</section>`;
}

async function renderLogs(sequence) {
  const f = state.filters.logs;
  const failuresOnly = f.failuresOnly !== 'false';
  const result = await api(`/logs${query({ limit: 50, ...f, failuresOnly, before: state.cursor })}`);
  if (sequence !== state.sequence) return '';
  state.rows = result.items || [];
  state.nextCursor = result.nextCursor;
  return `<section class="panel">${panelHead(failuresOnly ? '失败记录' : '全部日志', failuresOnly ? '展示失败、降级与结果未知；正常跳过不计入。需要调试时可切换到全部日志。' : '查看已记录的各级日志，包括未命中、跳过与成功步骤；可继续按级别筛选。')}<form id="logs-filter" class="filters"><label>查看范围<select name="failuresOnly">${selectOptions([['true', '仅看失败'], ['false', '全部日志']], String(failuresOnly))}</select></label><label>日志级别<select name="level">${selectOptions([['', '全部级别'], ['debug', 'DEBUG'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']], f.level)}</select></label><label>会话<input name="sessionKey" value="${e(f.sessionKey)}" placeholder="例如 g-123" autocomplete="off"></label><label class="filter-wide">关键词<input name="q" value="${e(f.q)}" placeholder="搜索阶段、原因或链路 ID" autocomplete="off"></label><button type="submit" class="button">搜索</button><button type="button" class="button subtle" data-action="reset-filters">重置</button></form>
    ${state.rows.length ? `<div class="table-wrap"><table class="log-table"><thead><tr><th>时间 / 会话</th><th>阶段 / 结果</th><th>原因 / 过程</th><th>详情</th></tr></thead><tbody>${state.rows.map((row, index) => {
      const info = describeLog(row);
      return `<tr><td><time class="mono">${e(date(row.time))}</time><span class="cell-sub mono">${e(row.sessionKey || '系统 / 历史未记录')}</span></td><td><span class="cell-main">${e(info.title)}</span><span class="cell-sub">${e(info.result)} · ${e(row.level)}</span></td><td class="log-message">${e(info.detail || row.message)}</td><td class="cell-actions"><button type="button" class="button small" data-action="log-detail" data-index="${index}">查看</button></td></tr>`;
    }).join('')}</tbody></table></div>` : empty(failuresOnly ? '没有符合条件的失败记录' : '没有符合条件的日志', '可调整范围或清除筛选；只展示保留范围内已记录的日志。', 'logs')}${pagination(result.nextCursor, state.rows.length)}</section>`;
}

function showLogDetail(row) {
  const info = describeLog(row);
  state.requestTraceVersion++;
  state.requestTrace = null;
  showDialog('日志详情', 'LOGS / RECORD', `<dl class="key-values"><div><dt>时间</dt><dd>${e(date(row.time))}</dd></div><div><dt>会话</dt><dd>${e(row.sessionKey || '系统 / 历史未记录')}</dd></div><div><dt>阶段 / 结果</dt><dd>${e(info.title)} · ${e(info.result)}</dd></div><div><dt>原因 / 过程</dt><dd>${e(info.detail || row.message)}</dd></div></dl><p class="field-hint">此处是单个阶段的结果；后续是否降级、兜底或发送成功，请查看本轮链路。</p>${row.traceId ? `<div class="dialog-actions"><button type="button" class="button" data-action="request-trace" data-trace="${e(row.traceId)}">查看本轮业务链路</button></div>` : '<p class="field-hint">此记录没有链路 ID，无法可靠关联后续结果。</p>'}<details><summary>原始记录（已脱敏）</summary><pre class="json-block">${e(JSON.stringify(row, null, 2))}</pre></details>`);
}

const kindNames = { chat: '文字对话', vision: '图片理解', draw: '绘图', image: '绘图', distill: '记忆提炼' };
function usageSessionTable(result) {
  const rows = [...(result.bySession || [])].sort((a,b) => (b.costNano || 0) - (a.costNano || 0) || b.calls - a.calls).slice(0,8);
  return rows.length ? `<div class="table-wrap"><table><thead><tr><th>会话</th><th>已报告 token</th><th>预估费用</th><th>操作</th></tr></thead><tbody>${rows.map(row => `<tr><td><span class="cell-main">${e(usageSession(row.sessionKey))}</span><span class="cell-sub">${e(number(row.calls))} 次调用 · ${e(number(row.pendingCostCalls))} 次待确认</span></td><td>${row.unknownUsageCalls === row.calls ? '未返回' : e(number(row.totalTokens))}</td><td class="usage-number">${e(usageMoney(row))}</td><td class="cell-actions"><button class="text-button" type="button" data-action="usage-session" data-session="${e(row.sessionKey)}">查看</button></td></tr>`).join('')}</tbody></table></div>` : empty('暂无会话用量', '统计覆盖全部记录，此处最多展示费用最高的 8 个会话。', 'usage');
}
function usageLedger(result) {
  const f = state.filters.usage;
  return `<details id="usage-ledger" class="panel usage-ledger"${f.detailKind || f.pendingOnly || state.usageDetailsOpen ? ' open' : ''}><summary><span>调用明细</span><span class="muted">匹配 ${e(number(result.itemCount ?? state.rows.length))} 次 · 展示最近 ${state.rows.length} 次</span></summary><form id="usage-detail-filter" class="filters"><label>用途<select name="detailKind">${selectOptions([['','全部用途'],...Object.entries(kindNames).filter(([key]) => key !== 'image')], f.detailKind)}</select></label><label>计价状态<select name="pendingOnly">${selectOptions([['','全部记录'],['true','费用待确认']], f.pendingOnly)}</select></label><button class="button" type="submit">筛选明细</button></form>${state.rows.length ? `<div class="table-wrap"><table><thead><tr><th>时间 / 模型</th><th>用途 / 会话</th><th>输入 / 输出 token</th><th>耗时 / 结果</th><th>预估费用</th><th>详情</th></tr></thead><tbody>${state.rows.map((row,index) => `<tr><td>${e(usageTime(row.time))}<span class="cell-sub mono">${e(row.responseModel || row.model || '—')}</span></td><td>${e(kindNames[row.kind] || row.kind || '—')}<span class="cell-sub">${e(usageSession(row.sessionKey))}</span></td><td>${row.prompt_tokens == null ? '未返回' : e(number(row.prompt_tokens))} / ${row.completion_tokens == null ? '未返回' : e(number(row.completion_tokens))}<span class="cell-sub">缓存输入 ${row.prompt_cache_hit_tokens == null ? '未返回' : e(number(row.prompt_cache_hit_tokens))}</span></td><td>${Number.isFinite(row.elapsedMs) ? e((row.elapsedMs / 1000).toFixed(1))+'s' : '—'}<span class="cell-sub">${row.status === 'failure' || row.status === 'interrupted' ? pill(row.status === 'interrupted' ? '已中断' : '失败','danger') : pill('成功')}</span></td><td class="usage-number">${row.cost?.status === 'estimated' ? e(usageMoney({costNano:row.cost.costNano})) : '待确认'}<span class="cell-sub usage-cost-reason">${e(row.cost?.reason || (row.pricing?.band === 'peak' ? '高峰时段价格' : row.pricing?.band === 'off-peak' ? '空闲时段价格' : row.pricing?.unit === 'call' ? (row.cost?.costNano === 0 ? '按次计价 · 未产生费用' : '按次计价 · 固定汇率估算') : ''))}</span></td><td class="cell-actions"><button class="button small" type="button" data-action="usage-detail" data-index="${index}">查看</button></td></tr>`).join('')}</tbody></table></div>` : empty('没有符合条件的调用', '当前明细筛选不会改变上方费用、趋势和会话汇总。', 'usage')}</details>`;
}
async function renderUsage(sequence) {
  const f = state.filters.usage;
  const filters = { ...f, limit:100 };
  if (f.period === 'custom') {
    if (f.since) filters.since = `${f.since}T00:00:00+08:00`;
    if (f.until) filters.until = `${f.until}T23:59:59.999+08:00`;
  } else { delete filters.since; delete filters.until; }
  const [result, status] = await Promise.all([api(`/usage/dashboard${query(filters)}`), api('/status')]);
  if (sequence !== state.sequence) return '';
  state.rows = result.items || [];
  state.usageDashboard = result;
  updateStatus(status);
  const t = result.totals || {};
  const monitor = status.usage || {};
  const today = monitor.today;
  const limits = monitor.policy?.limits || {};
  const period = f.period || 'today';
  const periods = [['today','今天'],['7d','近 7 天'],['30d','近 30 天'],['custom','自定义']];
  return `<div class="usage-workbench"><section class="usage-toolbar" aria-label="用量筛选"><div class="usage-periods" role="group" aria-label="统计时段">${periods.map(([value,label])=>`<button type="button" class="button${period===value?' primary':''}" aria-pressed="${period===value}" data-action="usage-period" data-period="${value}">${label}</button>`).join('')}</div><div class="usage-top-actions"><a class="button" href="https://platform.deepseek.com/" target="_blank" rel="noopener noreferrer">DeepSeek 开发者平台 ↗</a><button class="button primary" type="button" data-action="usage-report">生成分享图</button></div></section><form id="usage-filter" class="filters usage-scope"><input type="hidden" name="period" value="${e(period)}"><input type="hidden" name="detailKind" value="${e(f.detailKind)}"><input type="hidden" name="pendingOnly" value="${e(f.pendingOnly)}">${period==='custom'?`<label>开始日期（北京）<input type="date" name="since" value="${e(f.since)}" required></label><label>结束日期（北京）<input type="date" name="until" value="${e(f.until)}" required></label>`:''}<label class="filter-wide">会话范围<input name="sessionKey" list="usage-sessions" value="${e(f.sessionKey)}" placeholder="全部会话；或 g-群号 / p-QQ号"><datalist id="usage-sessions">${(result.bySession || []).map(row=>`<option value="${e(row.sessionKey)}">${e(usageSession(row.sessionKey))}</option>`).join('')}</datalist></label><button class="button" type="submit">应用范围</button><button class="button subtle" type="button" data-action="reset-filters">重置</button></form>
    ${renderUsageShareContent(result)}
    ${t.calls ? `<div class="usage-panels usage-session-panels"><section class="panel">${panelHead('会话费用排行','按已计价费用排序，最多显示 8 个会话。')}${usageSessionTable(result)}</section><section class="panel">${panelHead('每日额度与账号','额度为全局口径，不随当前会话筛选变化。')}<dl class="key-values"><div><dt>今日已报告 token</dt><dd>${today?e(number(today.totalTokens)):'不可用'}</dd></div><div><dt>每日 token 上限</dt><dd>${limits.maxTokensPerDay?e(number(limits.maxTokensPerDay)):'不限'}</dd></div><div><dt>今日 API 调用 / 上限</dt><dd>${today?e(number(today.calls)):'不可用'} / ${limits.maxCallsPerDay?e(number(limits.maxCallsPerDay)):'不限'}</dd></div><div><dt>进行中的请求</dt><dd>${e(number(monitor.inFlight?.length))}</dd></div><div><dt>下次重置（北京）</dt><dd>${e(usageTime(monitor.resetAt))}</dd></div></dl><p class="field-hint">Token 上限依据已报告用量；正在生成和未知用量可能使实际消耗超过阈值。</p><p class="field-hint">账号余额尚未接入。DeepSeek 账号可能还有其他应用消费，实际账单请到开发者平台查看。</p><a class="button" href="https://platform.deepseek.com/" target="_blank" rel="noopener noreferrer">查看账单 / 充值 ↗</a></section></div>${usageLedger(result)}` : ''}</div>`;
}
function clearUsageReport() {
  if (usageReportUrl) { URL.revokeObjectURL(usageReportUrl); usageReportUrl = undefined; }
}
async function showUsageReport(button) {
  const sequence = state.sequence;
  const range = state.usageDashboard?.range;
  if (!range) return;
  await withButton(button, async () => {
    const snapshotId = state.usageDashboard.snapshotId;
    if (!snapshotId) throw new Error('用量快照不可用，请刷新页面后重试。');
    const width = Math.round($('#usage-share-content').getBoundingClientRect().width);
    const blob = await api(`/usage/report${query({ snapshotId, width, viewportWidth: window.innerWidth })}`, {responseType:'blob'});
    if (sequence !== state.sequence || !state.token) return;
    clearUsageReport();
    usageReportUrl = URL.createObjectURL(blob);
    showDialog('用量报告预览','USAGE / SHARE', `<p class="detail-caption">${range.sessionKey?'当前所选会话摘要':'管理员查看的全局摘要'}。不包含账号余额、QQ 号或其他会话明细；聊天工具默认只返回所在会话的报告。</p><img class="usage-report-image" src="${e(usageReportUrl)}" alt="所选范围的 Token 用量与预估费用报告"><div class="dialog-actions"><a class="button primary" href="${e(usageReportUrl)}" download="usage-report.png">下载 PNG</a></div>`);
  });
}
function showUsagePricing() {
  const pricing = state.usageDashboard?.pricing || {};
  const priceRows = Object.values(pricing.models || {}).map(model => [1,2].map(factor => `<tr><td>${e(model.name)} · ${factor === 1 ? '空闲' : '高峰'}</td>${['cacheInputNano','inputNano','outputNano'].map(key => `<td>${e(number(model.offPeak[key] * factor / 1000))}</td>`).join('')}</tr>`).join('')).join('');
  const image = pricing.image;
  const imageNotes = image ? `<h3>绘图 · 老张 GPT Image VIP</h3><p>${e((image.models || []).join(' / '))}</p><p>每次 $${e(image.callUsd)}，固定按 1 美元 = ¥${e(image.usdCny)} 折算，约 <strong>¥${e(number(image.callUsd * image.usdCny))} / 次</strong>。这是公开价估算，账号分组优惠或倍率、充值成本以供应商账单为准。</p><ul class="usage-pricing-notes"><li>返回图片计费一次，同一请求多张也按一次；后续下载、保存失败仍计费，不依赖 token 用量。</li><li>明确的上游错误或完整响应无图片不计费；超时、断线、响应不完整或进程中断标为待确认。</li><li>价目核对日期 ${e(image.verifiedAt)}；每次调用保存单价和固定汇率，后续调价不改变旧账。</li></ul><a class="button" href="https://docs.laozhang.ai/en/api-capabilities/gpt-image-2-5" target="_blank" rel="noopener noreferrer">查看绘图价目 ↗</a>` : '';
  showDialog('计价说明','USAGE / PRICING', `<p class="detail-caption">本地预估费用与供应商账单分别查看。DeepSeek 费用 = 缓存输入 × 命中单价 + 非缓存输入 × 未命中单价 + 输出 × 输出单价。</p><div class="table-wrap"><table><thead><tr><th>模型（元 / 百万 token）</th><th>缓存输入</th><th>非缓存输入</th><th>输出</th></tr></thead><tbody>${priceRows}</tbody></table></div><ul class="usage-pricing-notes"><li>价目核对日期 ${e(pricing.verifiedAt || '—')}。当前计费日历覆盖至 2026 年末，后续需更新。</li><li>北京时间工作日（不含法定节假日）09:00–12:00、14:00–18:00 为高峰。按请求开始时刻保存价目快照，跨时段请求的实际扣费以供应商为准。</li><li>缓存命中率按输入 token 加权；没有返回缓存拆分的调用不混入分母。</li><li>历史记录缺少供应商或价目依据、未配置价目的供应商或模型、DeepSeek 用量缺失或拆分矛盾时，费用待确认，不当作免费。</li><li>每次 API 尝试分别计数，包含失败和重试；API 调用次数不等于用户消息数。</li></ul><a class="button" href="https://api-docs.deepseek.com/zh-cn/quick_start/pricing/" target="_blank" rel="noopener noreferrer">查看 DeepSeek 价目 ↗</a>${imageNotes}`);
}
async function renderPrompt(sequence) {
  if (!promptConsole) {
    const { createPromptConsole } = await import('/prompt.js');
    promptConsole = createPromptConsole({ api, state, toast });
  }
  return promptConsole.render(sequence);
}

async function renderMedia(page, sequence) {
  let gallery = mediaGalleries.get(page);
  if (!gallery) {
    const { createMediaGallery } = await import('/media.js');
    if (sequence !== state.sequence || !state.token) return '';
    gallery = createMediaGallery({ api, fetchFile: fetchMediaFile, toast, kind: page === 'images' ? 'generated' : 'memes' });
    mediaGalleries.set(page, gallery);
  }
  return gallery.render();
}
function resetRequestDetails() {
  Object.assign(state.filters.requests, { reason: '', failedOnly: '', detailSince: '', detailUntil: '', asOf: '' });
  state.cursor = null; state.cursors = [];
}
async function renderRequests(sequence) {
  const filters = { ...state.filters.requests, limit: 20, before: state.cursor };
  if (filters.period === 'custom') {
    filters.since = `${filters.since}T00:00:00+08:00`;
    filters.until = new Date(`${filters.until}T00:00:00+08:00`).getTime() + 86400000;
  } else { delete filters.since; delete filters.until; }
  const result = await api(`/requests/dashboard${query(filters)}`);
  if (sequence !== state.sequence) return '';
  state.requestDashboard = result;
  state.rows = result.items;
  state.nextCursor = result.nextCursor;
  return renderRequestsView(result, state.filters.requests, { compact: window.innerWidth < 650, older: Boolean(state.cursor) });
}
async function showRequestTrace(button, more = false) {
  const sequence = state.sequence;
  const version = ++state.requestTraceVersion;
  const traceId = button.dataset.trace;
  await withButton(button, async () => {
    const result = await api(`/logs${query({ traceId, limit: 100, before: more ? button.dataset.before : '' })}`);
    if (sequence !== state.sequence || version !== state.requestTraceVersion || !state.token || !$('#detail-dialog').open) return;
    const rows = more && state.requestTrace?.traceId === traceId ? [...state.requestTrace.rows, ...result.items] : result.items;
    state.requestTrace = { traceId, rows };
    $('#dialog-title').textContent = '本轮业务链路';
    $('#dialog-eyebrow').textContent = 'REQUESTS / TRACE';
    $('#detail-dialog').classList.toggle('request-trace-dialog', true);
    $('#dialog-content').innerHTML = renderRequestTrace(rows, result.nextCursor, traceId);
    $('#detail-dialog').scrollTop = 0;
  });
}
async function renderImageLab(sequence) {
  const settings = await api('/image-lab');
  if (sequence !== state.sequence || !state.token) return '';
  imageLab ??= createImageLab({ api, fetchMediaFile, toast });
  imageLab.setSettings(settings);
  return '';
}

const renderers = { requests: renderRequests, images: (sequence) => renderMedia('images', sequence), memes: (sequence) => renderMedia('memes', sequence), 'image-lab': renderImageLab, prompt: renderPrompt, overview: renderOverview, events: renderEvents, config: renderConfig, users: renderUsers, jobs: renderJobs, logs: renderLogs, usage: renderUsage };

function showDialog(title, eyebrow, html) {
  lastFocus = document.activeElement;
  $('#detail-dialog').classList.toggle('request-trace-dialog', false);
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
  if (action === 'annotation-preview') {
    if (state.dirty || state.saving) { toast('请先结束当前编辑或保存，再切换批注兼容。'); return; }
    await withButton(button, async () => {
      const preview = await api('/annotation-preview', { method: 'PUT', body: { enabled: button.dataset.enabled !== 'true' } });
      updateAnnotationPreview(preview);
      if (state.dirty || state.saving) toast('批注设置已切换。请处理当前修改，再重新载入网页。');
      else location.reload();
    });
    return;
  }
  if (action === 'reload-config') { if (canLeave()) { state.dirty = false; loadPage(); } return; }
  if (action === 'reset-filters') {
    for (const key of Object.keys(state.filters[state.page])) state.filters[state.page][key] = '';
    if (state.page === 'logs') state.filters.logs.failuresOnly = 'true';
    state.cursor = null; state.cursors = []; loadPage(); return;
  }
  if (action === 'next-page') { state.cursors.push(state.cursor); state.cursor = state.nextCursor; loadPage(); return; }
  if (action === 'first-page') { state.cursor = null; state.cursors = []; loadPage(); return; }
  if (action === 'event-detail') { showJson('接收事件详情', 'INBOX / EVENT', state.rows[index], '这里只展示已接收的数据。未知消息段会保留原始字段，不自动执行。'); return; }
  if (action === 'log-detail') { showLogDetail(state.rows[index]); return; }
  if (action === 'request-detail') {
    state.requestTraceVersion++;
    state.requestTrace = null;
    showDialog('模型调用详情', 'REQUESTS / CALL', renderRequestDetail(state.rows[index])); return;
  }
  if (action === 'request-trace' || action === 'request-trace-more') { await showRequestTrace(button, action === 'request-trace-more'); return; }
  if (action === 'request-reset') {
    state.filters.requests = { period: 'today', kind: '', source: '', sessionKey: '' };
    resetRequestDetails(); loadPage(); return;
  }
  if (action === 'request-period') {
    state.filters.requests.period = button.dataset.period;
    if (button.dataset.period === 'custom') {
      const local = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      state.filters.requests.since ||= local; state.filters.requests.until ||= local;
    }
    resetRequestDetails(); loadPage(); return;
  }
  if (action === 'request-kind' || action === 'request-session') {
    state.filters.requests[action === 'request-kind' ? 'kind' : 'sessionKey'] = button.dataset[action === 'request-kind' ? 'kind' : 'session'];
    resetRequestDetails(); loadPage(); return;
  }
  if (['request-bucket', 'request-reason', 'request-failures', 'request-clear-detail'].includes(action)) {
    const f = state.filters.requests;
    state.cursor = null; state.cursors = [];
    f.asOf = state.requestDashboard.range.asOf;
    if (action === 'request-bucket') { f.detailSince = button.dataset.since; f.detailUntil = button.dataset.until; }
    if (action === 'request-reason') { f.reason = button.dataset.reason; f.failedOnly = 'true'; }
    if (action === 'request-failures') { f.failedOnly = f.failedOnly === 'true' ? '' : 'true'; f.reason = ''; }
    if (action === 'request-clear-detail') resetRequestDetails();
    if (!f.reason && !f.failedOnly && !f.detailSince) f.asOf = '';
    await loadPage({ quiet: true });
    if (state.page === 'requests') $('.request-ledger')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (action === 'usage-period') {
    state.filters.usage.period = button.dataset.period;
    if (button.dataset.period === 'custom') {
      const local = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
      state.filters.usage.since ||= local; state.filters.usage.until ||= local;
    }
    loadPage(); return;
  }
  if (action === 'usage-session') { state.filters.usage.sessionKey=button.dataset.session; loadPage(); return; }
  if (action === 'usage-kind') { state.filters.usage.detailKind=button.dataset.kind; state.filters.usage.pendingOnly=''; loadPage(); return; }
  if (action === 'usage-pending') { state.filters.usage.pendingOnly='true'; state.filters.usage.detailKind=''; loadPage(); return; }
  if (action === 'usage-chart') { $('#usage-chart-reading').textContent=button.dataset.reading; return; }
  if (action === 'usage-report') { await showUsageReport(button); return; }
  if (action === 'usage-pricing') { showUsagePricing(); return; }
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
  if (form.id === 'usage-detail-filter') { Object.assign(state.filters.usage, Object.fromEntries(new FormData(form).entries())); loadPage(); return; }
  const page = form.id.replace('-filter', '');
  if (!state.filters[page]) return;
  const draft = Object.fromEntries(new FormData(form).entries());
  if (page === 'usage' && draft.since && draft.until && draft.since > draft.until) { toast('开始日期不能晚于结束日期。', true); return; }
  if (page === 'requests' && draft.period === 'custom' && draft.since > draft.until) { toast('开始日期不能晚于结束日期。', true); return; }
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
  const token = $('#admin-token').value.trim();
  if (token && !$('.login-submit').disabled) await login(token);
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
$('#refresh').addEventListener('click', () => { if (canLeave()) { state.dirty = false; if (state.page === 'requests') resetRequestDetails(); loadPage(); } });
$('#close-dialog').addEventListener('click', closeDialog);
$('#detail-dialog').addEventListener('cancel', (event) => { if (state.saving) event.preventDefault(); });
$('#detail-dialog').addEventListener('close', () => { clearUsageReport(); if (lastFocus?.isConnected) lastFocus.focus(); });
$('#auto-refresh').addEventListener('change', (event) => { state.live = event.target.checked; });
renderNavigation(state.page);
window.addEventListener('beforeunload', (event) => { if (state.dirty || state.saving) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('focus', expireLogin);
window.addEventListener('pageshow', expireLogin);
document.addEventListener('visibilitychange', expireLogin);
window.addEventListener('storage', (event) => {
  if ((event.key === LOGIN_STORAGE_KEY || event.key === null) && (state.token || $('.login-submit').disabled)) {
    logout('登录状态已在其他页面更改，请重新登录。', { forget: false });
  }
});
window.addEventListener('hashchange', () => {
  const next = resolvePage(location.hash.slice(1));
  if (pages[next] && next !== state.page) navigate(next);
  history.replaceState(null, '', `#${state.page}`);
});
setInterval(() => {
  if (state.token && state.live && !state.loading && !state.dirty && !document.hidden && !$('#detail-dialog').open && !state.cursor && ['overview', 'events', 'logs', 'usage', 'requests'].includes(state.page) && !(state.page === 'requests' && (state.filters.requests.reason || state.filters.requests.failedOnly || state.filters.requests.detailSince)) && !$('#content').contains(document.activeElement)) loadPage({ quiet: true });
}, 20000);
restoreLogin();
