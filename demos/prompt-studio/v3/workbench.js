import { initialState, templates, cases } from '../data.js';
import { buildRequest, initialHistory, parseHistory } from '../v2/request.js';

const STORAGE = 'fish.prompt-studio.demo.v3';
const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = {
  fish: '<path d="M3 12c4-7 10-7 14-2l4-3v10l-4-3c-4 5-10 5-14-2Z"/><circle cx="8" cy="11" r=".6"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>',
  edit: '<path d="m15 4 5 5M4 15 15 4a3.5 3.5 0 0 1 5 5L9 20l-6 1 1-6Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="m6 14 6-6 6 6"/>', down: '<path d="m6 10 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  terminal: '<path d="m4 6 6 6-6 6m9 0h7"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  undo: '<path d="M3 10h12a6 6 0 0 1 0 12M3 10l6-6M3 10l6 6"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.code}</svg>`;
const button = (action, label, symbol, extra = '') => `<button type="button" class="btn" data-action="${action}" ${extra}>${symbol ? icon(symbol) : ''}${label}</button>`;
const iconButton = (action, label, symbol, extra = '') => `<button type="button" class="icon-btn" data-action="${action}" aria-label="${label}" title="${label}" ${extra}>${icon(symbol)}</button>`;
const bytes = (text) => new TextEncoder().encode(text).length;
const number = (n) => n.toLocaleString('en-US');

let canStore = true;
let storageWarning = '';
let state = load();
let mode = 'inspect';
let format = 'text';
let runFormat = 'text';
let source = 'draft';
let panel = 'request';
let run = null;
let runNumber = 0;
let toastTimer;
let saveTimer;
let dialogFocus;
const w = () => state.workspaces.find((item) => item.id === state.active);

function defaults() {
  const value = initialState();
  value.version = 3;
  for (const workspace of value.workspaces) {
    workspace.model = 'deepseek-flash';
    workspace.input = cases[0].input;
    workspace.scenario = 'comfort';
    workspace.recovery = null;
    for (const block of workspace.blocks) if (block.key === 'history') block.content = initialHistory();
  }
  return value;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return defaults();
    const value = JSON.parse(raw);
    const validBlock = (block) => block && typeof block.id === 'string' && typeof block.key === 'string' && typeof block.title === 'string'
      && typeof block.category === 'string' && typeof block.content === 'string' && block.content.length <= 100000 && typeof block.enabled === 'boolean';
    const validBlocks = (blocks) => Array.isArray(blocks) && blocks.length > 0 && blocks.length <= 30 && blocks.every(validBlock)
      && new Set(blocks.map((b) => b.id)).size === blocks.length && blocks.some((b) => b.key === 'identity' && b.required && b.enabled);
    if (value.version !== 3 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.workspaces) || !value.workspaces.length || value.workspaces.length > 20
      || new Set(value.workspaces.map((item) => item.id)).size !== value.workspaces.length
      || !value.workspaces.every((item) => typeof item.id === 'string' && typeof item.name === 'string' && typeof item.model === 'string' && item.model.length <= 80
        && typeof item.input === 'string' && item.input.length <= 12000 && validBlocks(item.blocks) && (!item.recovery || validBlocks(item.recovery))
        && item.tools && ['memes', 'memory', 'draw'].every((key) => typeof item.tools[key] === 'boolean'))
      || !value.workspaces.some((item) => item.id === value.active)) throw new Error('Invalid draft');
    return value;
  } catch {
    canStore = false;
    storageWarning = '本地草稿无法读取或浏览器不允许保存。原有存储未覆盖，本次修改只保留在当前页面，可下载请求另存。';
    return defaults();
  }
}

function save() {
  if (canStore) {
    try { localStorage.setItem(STORAGE, JSON.stringify(state)); }
    catch {
      canStore = false;
      storageWarning = '本地保存失败，当前修改仍保留在页面中。关闭前请下载请求。';
      $('#storage-warning').hidden = false;
      $('#storage-warning').textContent = storageWarning;
    }
  }
  if ($('#save-state')) $('#save-state').textContent = canStore ? '已保存在此浏览器' : '仅保留在页面中';
}

function changed() {
  state.revision++;
  $('#save-state').textContent = '正在保存…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 200);
  renderSidebar();
  updateRequest();
  renderTerminal();
}

function toast(text) {
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3000);
}

function current() {
  try { return { request: buildRequest(w(), w().input), error: null }; }
  catch (error) { return { request: null, error: error.message }; }
}

function visibleRequest() { return source === 'run' && run ? { request: run.request, error: null } : current(); }

function highlight(json) {
  const pattern = /"(?:\\.|[^"\\])*"|\b(?:true|false|null|\d+(?:\.\d+)?)\b/g;
  let html = '';
  let cursor = 0;
  for (const match of json.matchAll(pattern)) {
    html += escape(json.slice(cursor, match.index));
    const key = match[0].startsWith('"') && json.slice(match.index + match[0].length).trimStart().startsWith(':');
    html += `<span class="${key ? 'json-key' : match[0].startsWith('"') ? 'json-string' : 'json-primitive'}">${escape(match[0])}</span>`;
    cursor = match.index + match[0].length;
  }
  return html + escape(json.slice(cursor));
}

function render() {
  $('#app').innerHTML = `<div class="app">
    <header class="topbar"><div class="brand"><span class="brand-mark">${icon('fish')}</span><h1>肥鱼 <small>Context Workbench</small></h1><span class="badge">V3</span></div>
      <div class="top-meta"><span class="save-state"><span class="dot"></span><span id="save-state">${canStore ? '已保存在此浏览器' : '仅保留在页面中'}</span></span><div class="mode-switch" aria-label="上下文工作模式"><button type="button" data-mode="inspect" aria-pressed="${mode === 'inspect'}">${icon('code')}阅读上下文<span class="small">只读</span></button><button type="button" data-mode="edit" aria-pressed="${mode === 'edit'}">${icon('edit')}编辑积木</button></div></div></header>
    <div id="storage-warning" class="storage-warning" role="alert" ${storageWarning ? '' : 'hidden'}>${escape(storageWarning)}</div>
    <div class="workspace-bar"><div class="workspace-bar-left"><select id="workspace-select" class="workspace-select" aria-label="选择工作空间">${state.workspaces.map((item) => `<option value="${escape(item.id)}" ${item.id === w().id ? 'selected' : ''}>${escape(item.name)}</option>`).join('')}</select><span class="endpoint"><span class="badge green">POST</span>/v1/chat/completions</span></div><span class="bar-meta">积木 → messages + tools → 单次调用</span><div class="mobile-panel-tabs" aria-label="面板"><button type="button" data-panel="request" aria-pressed="${panel === 'request'}">上下文</button><button type="button" data-panel="terminal" aria-pressed="${panel === 'terminal'}">运行台</button></div></div>
    <main class="layout" data-panel="${panel}"><aside class="sidebar" aria-label="上下文组成"><div class="sidebar-heading"><span>CONTEXT</span><span id="block-count"></span></div><div id="outline" class="outline"></div><div id="sidebar-actions" class="sidebar-actions"></div><div class="sidebar-note"><strong>${mode === 'inspect' ? '一张卡片，一块上下文。' : '每一块正文，都在这里。'}</strong><br>${mode === 'inspect' ? '正文按模块完整展开。<br>原始 JSON 单独查看。' : '目录只负责定位。<br>不用切换积木才能看全文。'}<br><br><a href="../v2/">V2 对比</a> · <button class="btn quiet" type="button" data-action="notes">说明</button></div></aside>
      <section class="center" aria-label="完整上下文"><div class="document-toolbar"><div class="document-heading"><h2>${mode === 'inspect' ? '完整上下文' : '编辑上下文'}</h2><span class="badge ${mode === 'inspect' ? '' : 'blue'}">${mode === 'inspect' ? 'READ ONLY' : 'EDITING'}</span><p>${mode === 'inspect' ? '按模块阅读正文，按原样查看 JSON。' : '在同一组卡片里修改正文，全部连续展开。'}</p></div><div class="document-actions">${button('copy', '<span class="button-label">复制 JSON</span>', 'copy', 'aria-label="复制请求 JSON" title="复制请求 JSON"')}${button('download', '<span class="button-label">下载</span>', 'download', 'aria-label="下载请求 JSON" title="下载请求 JSON"')}</div></div>
        <div class="view-tabs" ${mode === 'edit' ? 'hidden' : ''}><button type="button" data-format="text" aria-pressed="${format === 'text'}">模块正文</button><button type="button" data-format="json" aria-pressed="${format === 'json'}">原始 JSON</button><div id="source-switch" class="source-switch"></div></div>
        <div id="stale-notice" class="stale-notice" hidden></div><div id="document" class="document" tabindex="0" aria-label="${mode === 'inspect' ? '完整请求内容（只读）' : '全部积木编辑区'}"></div>
        <footer class="document-footer"><span id="request-metrics"></span><span>${mode === 'inspect' ? '未折叠 · 未截断 · UTF-8' : '自动保存 · ⌘ / Ctrl + S'}</span></footer></section>
      <aside class="terminal" aria-labelledby="terminal-title"><div class="terminal-heading"><h2 id="terminal-title">${icon('terminal')}单次运行台</h2><span class="badge">LOCAL</span></div><p class="terminal-intro">一次输入，一份请求，一次输出。</p>
        <div class="view-tabs run-view-tabs" aria-label="运行台展示方式"><button type="button" data-run-format="text" aria-pressed="${runFormat === 'text'}">卡片正文</button><button type="button" data-run-format="json" aria-pressed="${runFormat === 'json'}">原始 JSON</button></div>
        <div class="run-scroll"><form id="run-form" class="run-form module-card"><div class="card-heading"><span class="card-number">01</span><h3>本次输入</h3><span class="badge blue">user</span></div>
        <select id="scenario-select" class="scenario-select" aria-label="载入输入样例"><option value="custom" ${w().scenario === 'custom' ? 'selected' : ''}>自定义输入</option>${cases.map((item) => `<option value="${item.id}" ${w().scenario === item.id ? 'selected' : ''}>${escape(item.title)}</option>`).join('')}</select><label class="input-label" for="run-input"><span>这一次想说什么？</span><span>⌘ / Ctrl + Enter</span></label><textarea id="run-input" class="run-input" maxlength="12000" spellcheck="false">${escape(w().input)}</textarea><p id="run-error" class="run-error" role="alert" hidden></p><div class="run-actions"><span>--once</span><button type="submit" class="btn primary" id="run-button">${icon('terminal')}组装并模拟</button></div></form>
        <div id="terminal-output" class="terminal-output" aria-live="polite"></div></div>
        <div class="terminal-footer"><span class="dot"></span>本地模拟 · 不发送 API / QQ 请求</div></aside></main>
    <footer class="statusbar"><span><span>DEMO / LOCAL</span><span class="optional">Chat Completions</span><span id="status-revision"></span></span><span id="payload-status">JSON 可解析 · 本地草稿</span></footer>
  </div>`;
  renderSidebar();
  if (mode === 'edit') renderEditors();
  updateRequest();
  renderTerminal();
}

function displayedBlocks() { return mode === 'inspect' && source === 'run' && run ? run.blocks : w().blocks; }

function renderSidebar() {
  const blocks = displayedBlocks();
  $('#block-count').textContent = `${blocks.filter((b) => b.enabled).length}/${blocks.length}`;
  $('#outline').innerHTML = blocks.map((block, index) => `<button type="button" class="outline-item editable ${block.enabled ? '' : 'off'}" data-anchor="${escape(block.id)}"><span class="outline-number">${String(index + 1).padStart(2, '0')}</span><span><span class="outline-title">${escape(block.title)}</span><span class="outline-sub">${escape(block.category)}${block.enabled ? '' : ' · 未带入'}</span></span></button>`).join('');
  $('#sidebar-actions').hidden = mode !== 'edit';
  $('#sidebar-actions').innerHTML = mode === 'edit' ? `${button('library', '添加 / 替换积木', 'plus')}${button('recover', '还原上次结构', 'undo', w().recovery ? '' : 'disabled')}` : '';
}

function readCards(request) {
  const blocks = displayedBlocks();
  let historyIndex = 1;
  const cards = blocks.map((block, index) => {
    let body = `<pre class="card-body">${escape(block.content)}</pre>`;
    if (block.key === 'history' && block.enabled) {
      body = `<div class="history-messages">${parseHistory(block.content).map((message) => `<section class="history-message"><div class="message-label"><span class="badge ${message.role === 'assistant' ? '' : 'blue'}">${message.role}</span><span>messages[${historyIndex++}]</span></div><pre class="card-body">${escape(message.content)}</pre></section>`).join('') || '<p class="empty-note">没有历史消息。</p>'}</div>`;
    }
    return `<article class="module-card ${block.enabled ? '' : 'excluded'}" data-reader="${escape(block.id)}"><div class="card-heading"><span class="card-number">${String(index + 1).padStart(2, '0')}</span><h3>${escape(block.title)}</h3><span class="badge">${escape(block.category)}</span>${!block.enabled ? '<span class="badge">未带入</span>' : ''}</div>${body}<div class="card-foot"><span>${block.enabled ? block.key === 'history' ? '独立的历史消息 · 保留各自 role' : 'system · messages[0].content' : '仅保留在草稿，不进入请求'}</span><span>${number(bytes(block.content))} bytes</span></div></article>`;
  }).join('');
  const user = request.messages.at(-1);
  return `<div class="reader-document"><div class="reader-summary"><span><span class="dot"></span>${escape(request.model)}</span><span>${request.messages.length} messages · ${request.tools?.length ?? 0} tools</span></div>${cards}<article class="module-card input-preview"><div class="card-heading"><span class="card-number">↳</span><h3>本次输入</h3><span class="badge blue">user</span></div><pre class="card-body">${escape(user.content)}</pre><div class="card-foot">messages[${request.messages.length - 1}].content · 在运行台填写</div></article>${request.tools?.length ? `<article class="module-card"><div class="card-heading"><span class="card-number">fn</span><h3>可用工具</h3><span class="badge">${request.tools.length} functions</span></div><div class="function-list">${request.tools.map(({ function: fn }) => `<section class="function-item"><h4>${escape(fn.name)}</h4><p>${escape(fn.description)}</p><div class="function-args">${Object.entries(fn.parameters.properties).map(([name, spec]) => `<span class="mono">${escape(name)}: ${escape(spec.type)}</span>`).join(' · ') || '无参数'}</div></section>`).join('')}</div><div class="card-foot">tools · 完整参数定义见原始 JSON</div></article>` : ''}</div>`;
}

function renderEditors() {
  $('#document').innerHTML = `<div class="editor-document"><label class="model-field" for="model-input">模型（示例）<input id="model-input" value="${escape(w().model)}" maxlength="80" spellcheck="false"></label>${w().blocks.map((block, index) => `<article class="block-editor ${block.enabled ? '' : 'off'}" data-editor="${escape(block.id)}"><div class="block-header"><div class="block-title"><span>${String(index + 1).padStart(2, '0')}</span><h3>${escape(block.title)}</h3><span class="badge">${escape(block.category)}</span></div><div class="block-actions"><label class="block-toggle"><input type="checkbox" data-enabled="${escape(block.id)}" ${block.enabled ? 'checked' : ''} ${block.required ? 'disabled' : ''}>${block.required ? '必须带入' : '带入'}</label>${iconButton('up', '上移 ' + block.title, 'up', `data-id="${escape(block.id)}" ${index === 0 ? 'disabled' : ''}`)}${iconButton('down', '下移 ' + block.title, 'down', `data-id="${escape(block.id)}" ${index === w().blocks.length - 1 ? 'disabled' : ''}`)}${iconButton('remove', '移除 ' + block.title, 'trash', `data-id="${escape(block.id)}" ${block.required ? 'disabled' : ''}`)}</div></div><p class="block-caption">${block.key === 'history' ? '历史是 messages 数组中的独立消息，保留真实 role；不会混入 system。' : '编入 messages[0].content，顺序与左侧一致。'}</p><textarea class="block-body ${block.key === 'history' ? 'history' : ''}" aria-label="${escape(block.title)}正文" data-content="${escape(block.id)}" maxlength="100000" spellcheck="false">${escape(block.content)}</textarea>${block.key === 'history' ? '<p id="history-error" class="block-error" role="alert" hidden></p>' : ''}${block.key === 'tools' ? `<div class="tool-options">${[['memes', '表情'], ['memory', '记忆'], ['draw', '绘图']].map(([key, title]) => `<label><input data-tool="${key}" type="checkbox" ${w().tools[key] ? 'checked' : ''}>${title}工具定义</label>`).join('')}</div>` : ''}</article>`).join('')}<div style="padding-top:18px">${button('library', '添加积木', 'plus')}${button('recover', '还原上次结构', 'undo', w().recovery ? '' : 'disabled')}</div></div>`;
  document.querySelectorAll('.block-body').forEach(autoHeight);
}

function autoHeight(textarea) { textarea.style.height = 'auto'; textarea.style.height = textarea.scrollHeight + 2 + 'px'; }

function updateRequest() {
  const displayed = visibleRequest();
  const live = current();
  const request = displayed.request;
  const raw = request ? JSON.stringify(request, null, 2) : '';
  if (mode === 'inspect') {
    const scroll = $('#document').scrollTop;
    $('#document').innerHTML = displayed.error ? `<div class="request-error"><strong>请求尚不能组装</strong><p>${escape(displayed.error)}</p>${button('edit-history', '回到编辑', 'edit')}</div>` : format === 'json'
      ? `<pre class="json-code" id="request-json" aria-label="完整 Chat Completions 请求 JSON"><code>${highlight(raw)}</code></pre>`
      : readCards(request);
    $('#document').scrollTop = scroll;
  }
  $('#request-metrics').textContent = request ? `${request.messages.length} messages · ${request.tools?.length ?? 0} tools · ${number(bytes(raw))} bytes` : '组装被阻止 · 请修正历史格式';
  $('#status-revision').textContent = `draft r${state.revision}`;
  const stale = source === 'run' && run && run.revision !== state.revision;
  $('#stale-notice').hidden = !stale;
  $('#stale-notice').textContent = stale ? '草稿已修改。这里仍显示上次运行时的请求；选择“当前组装”查看新内容。' : '';
  $('#source-switch').innerHTML = run ? `<button type="button" data-source="draft" aria-pressed="${source === 'draft'}">当前组装</button><span>/</span><button type="button" data-source="run" aria-pressed="${source === 'run'}">运行 #${String(run.number).padStart(3, '0')}</button>` : '<span>当前组装</span>';
  const historyError = $('#history-error');
  if (historyError) { historyError.hidden = !live.error; historyError.textContent = live.error ?? ''; }
  $('#run-button').disabled = !!live.error || !w().model.trim();
  document.querySelectorAll('[data-action="copy"],[data-action="download"]').forEach((target) => { target.disabled = !request; });
  $('#payload-status').textContent = live.error ? '草稿请求待修正' : 'JSON 可解析 · 本地草稿';
}

function renderTerminal() {
  const output = $('#terminal-output');
  const json = runFormat === 'json';
  $('#run-form').hidden = json;
  const input = run ? run.request.messages.at(-1) : { role: 'user', content: w().input };
  const inputCard = json ? `<article class="module-card"><div class="card-heading"><span class="card-number">01</span><h3>${run ? '运行时的输入' : '本次输入'}</h3><span class="badge">JSON</span></div><pre class="json-code"><code>${highlight(JSON.stringify(input, null, 2))}</code></pre><div class="card-foot">${run ? '本次快照 · 不随草稿变化' : '当前草稿 · 切回卡片正文可编辑'}</div></article>` : '';
  const request = run?.request ?? current().request;
  const receipt = `<article class="module-card run-receipt"><div class="card-heading"><span class="card-number">02</span><h3>请求快照</h3><span class="badge ${run ? 'green' : ''}">${run ? '#' + String(run.number).padStart(3, '0') : '待运行'}</span></div><div class="receipt-body"><p class="cli-command"><span class="cli-prompt">$</span>fish run --once --dry-run</p><div class="receipt-row"><span>模型</span><span class="mono">${escape(request?.model ?? w().model)}</span></div><div class="receipt-row"><span>上下文</span><span>${request?.messages.length ?? '—'} messages · ${request?.tools?.length ?? 0} tools</span></div>${run ? `<div class="receipt-row"><span>状态</span><span class="receipt-state">已捕获 · 未发送</span></div>${button('show-run', '查看完整请求', 'code')}` : '<p class="empty-note">运行后保留本次完整上下文。</p>'}</div><div class="card-foot">${run && run.revision !== state.revision ? '草稿已修改 · 此快照保持原样' : '单次调用 · 不累积对话'}</div></article>`;
  const response = run ? json ? `<pre class="json-code"><code>${highlight(JSON.stringify({ role: 'assistant', content: run.response }, null, 2))}</code></pre>` : `<pre class="card-body response-body">${escape(run.response)}</pre>` : '<div class="empty-output"><span class="terminal-cursor">_</span><p>等待这一次运行</p><small>输出会出现在这里</small></div>';
  output.innerHTML = `${inputCard}${receipt}<article class="module-card output-card"><div class="card-heading"><span class="card-number">03</span><h3>本次输出</h3><span class="badge">${json ? 'JSON' : 'assistant'}</span></div>${response}<div class="card-foot">${run ? '场景预设 · 非真实模型回复' : '只保留最近一次结果'}</div></article>`;
}

function showDialog(title, subtitle, body) {
  dialogFocus = document.activeElement;
  const dialog = $('#dialog');
  dialog.innerHTML = `<div class="dialog-header"><div><h2 id="dialog-title">${title}</h2><p>${subtitle}</p></div>${iconButton('close', '关闭面板', 'close')}</div><div class="dialog-body">${body}</div>`;
  if (!dialog.open) dialog.showModal();
}

function showLibrary() {
  showDialog('积木库', '选择一块加入；人设与回应方式替换同类积木。', '<label class="small muted" for="library-search">搜索名称或类别</label><input id="library-search" class="library-search" placeholder="人设、记忆、场景…"><div id="library-list" class="library-list"></div>');
  renderLibrary();
}

function renderLibrary(query = '') {
  const matches = templates.filter((item) => `${item.title}${item.category}`.includes(query));
  $('#library-list').innerHTML = matches.length ? matches.map((item) => {
    const exists = w().blocks.some((block) => block.key === item.key);
    const replace = ['人设', '回应方式'].includes(item.category) && w().blocks.some((block) => block.category === item.category);
    return `<article class="library-row"><div class="library-copy"><h3>${escape(item.title)}<span class="badge">${escape(item.category)}</span></h3><p>${escape(item.summary)}</p></div>${button('add', exists ? '已加入' : replace ? '替换' : '加入', exists ? null : 'plus', `data-key="${escape(item.key)}" ${exists ? 'disabled' : ''}`)}</article>`;
  }).join('') : '<p class="muted small">没有匹配的积木。</p>';
}

function rememberStructure() { w().recovery = structuredClone(w().blocks); }

async function act(action, target) {
  if (action === 'close') return $('#dialog').close();
  if (action === 'library') return showLibrary();
  if (action === 'edit-history') {
    mode = 'edit'; source = 'draft'; panel = 'request'; render();
    document.querySelector('.history')?.focus();
    return;
  }
  if (action === 'show-run') { mode = 'inspect'; source = 'run'; format = runFormat; panel = 'request'; render(); return; }
  if (action === 'copy') {
    const request = visibleRequest().request;
    if (!request) return;
    const raw = JSON.stringify(request, null, 2);
    try { await navigator.clipboard.writeText(raw); toast('已复制完整请求 JSON'); }
    catch { showDialog('复制请求 JSON', '浏览器未允许直接复制。可在下方全选后复制。', `<textarea id="copy-fallback" class="copy-fallback" readonly aria-label="可复制的完整请求 JSON">${escape(raw)}</textarea>`); $('#copy-fallback').focus(); $('#copy-fallback').select(); }
    return;
  }
  if (action === 'download') {
    const request = visibleRequest().request;
    if (!request) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(request, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'fish-chat-completions-request.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  if (action === 'recover') {
    if (!w().recovery) return;
    const currentBlocks = w().blocks;
    w().blocks = w().recovery;
    w().recovery = currentBlocks;
    state.revision++; save(); render();
    toast('已还原上次结构；再次点击可回到刚才的结构');
    return;
  }
  if (['up', 'down', 'remove'].includes(action)) {
    const index = w().blocks.findIndex((block) => block.id === target.dataset.id);
    if (index < 0 || (action === 'remove' && w().blocks[index].required)) return;
    const next = index + (action === 'up' ? -1 : 1);
    if (action !== 'remove' && (next < 0 || next >= w().blocks.length)) return;
    rememberStructure();
    const [block] = w().blocks.splice(index, 1);
    if (action !== 'remove') w().blocks.splice(next, 0, block);
    state.revision++; save(); render();
    if (action !== 'remove') document.querySelector(`[data-editor="${CSS.escape(block.id)}"] textarea`)?.focus();
    else toast('积木已移除，可还原上次结构');
    return;
  }
  if (action === 'add') {
    const template = templates.find((item) => item.key === target.dataset.key);
    if (!template || w().blocks.some((block) => block.key === template.key)) return;
    const index = ['人设', '回应方式'].includes(template.category) ? w().blocks.findIndex((block) => block.category === template.category) : -1;
    if (index < 0 && w().blocks.length >= 30) return toast('一个空间最多保留 30 块');
    rememberStructure();
    const block = { ...template, id: crypto.randomUUID(), enabled: true, ...(template.key === 'history' ? { content: initialHistory() } : {}) };
    if (index >= 0) w().blocks.splice(index, 1, block); else w().blocks.push(block);
    state.revision++; save(); render(); $('#dialog').close();
    document.querySelector(`[data-editor="${CSS.escape(block.id)}"] textarea`)?.focus();
    toast(index >= 0 ? '已替换，可还原上次结构' : '已加入积木');
    return;
  }
  if (action === 'notes') showDialog('V3：按模块阅读，按原样检查', '卡片正文与原始 JSON，是同一份上下文的两种阅读方式。', `<div class="notes"><p><strong>模块正文：</strong>每个模块一张卡片，全部展开。历史消息保留 role，工具说明与提示词分开呈现；停用的积木标注“未带入”。</p><p><strong>编辑积木：</strong>在同一组卡片里修改、排序、启停或替换。阅读模式不会出现可编辑的提示词表单。</p><p><strong>单次运行：</strong>输入、请求快照、输出各有一张卡片；运行台也可切到 JSON。每次运行独立，快照不随之后的编辑变化。</p><p>仅本地 demo，输出是场景预设，不调用 API 或 QQ。V3 单独保存草稿，V2 保留供比较。原始请求沿用 V2 的 Chat Completions 组装。</p></div>`);
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  if (target.dataset.action) { act(target.dataset.action, target); return; }
  if (target.dataset.mode) {
    mode = target.dataset.mode;
    if (mode === 'edit') source = 'draft';
    panel = 'request';
    render();
    document.querySelector(`[data-mode="${mode}"]`)?.focus();
  } else if (target.dataset.format) {
    format = target.dataset.format;
    document.querySelectorAll('[data-format]').forEach((item) => item.setAttribute('aria-pressed', item.dataset.format === format));
    updateRequest(); $('#document').scrollTop = 0;
  } else if (target.dataset.runFormat) {
    runFormat = target.dataset.runFormat;
    document.querySelectorAll('[data-run-format]').forEach((item) => item.setAttribute('aria-pressed', item.dataset.runFormat === runFormat));
    renderTerminal();
  } else if (target.dataset.source) {
    source = target.dataset.source; renderSidebar(); updateRequest(); $('#document').scrollTop = 0;
    document.querySelector(`[data-source="${source}"]`)?.focus();
  } else if (target.dataset.anchor) {
    if (mode === 'inspect' && format !== 'text') {
      format = 'text';
      document.querySelectorAll('[data-format]').forEach((item) => item.setAttribute('aria-pressed', item.dataset.format === format));
      updateRequest();
    }
    const card = document.querySelector(`[${mode === 'edit' ? 'data-editor' : 'data-reader'}="${CSS.escape(target.dataset.anchor)}"]`);
    card?.scrollIntoView({ block: 'start' });
    card?.querySelector('textarea')?.focus({ preventScroll: true });
  } else if (target.dataset.panel) {
    panel = target.dataset.panel; $('.layout').dataset.panel = panel;
    document.querySelectorAll('.mobile-panel-tabs button').forEach((item) => item.setAttribute('aria-pressed', item.dataset.panel === panel));
  }
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.dataset.content) {
    w().blocks.find((block) => block.id === target.dataset.content).content = target.value;
    autoHeight(target); changed();
  } else if (target.id === 'run-input') {
    w().input = target.value; w().scenario = 'custom'; $('#scenario-select').value = 'custom';
    $('#run-error').hidden = true; changed();
  } else if (target.id === 'model-input') {
    w().model = target.value.trim(); changed();
    target.setCustomValidity(target.value.trim() ? '' : '请填写模型标识');
    $('#run-button').disabled = !target.value.trim() || !!current().error;
  } else if (target.id === 'library-search') renderLibrary(target.value);
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.id === 'workspace-select') {
    save(); state.active = target.value; run = null; source = 'draft'; save(); render();
  } else if (target.dataset.enabled) {
    const block = w().blocks.find((item) => item.id === target.dataset.enabled);
    if (!block.required) block.enabled = target.checked;
    target.closest('.block-editor').classList.toggle('off', !block.enabled);
    changed();
  } else if (target.dataset.tool) { w().tools[target.dataset.tool] = target.checked; changed(); }
  else if (target.id === 'scenario-select') {
    const selected = cases.find((item) => item.id === target.value);
    w().scenario = target.value;
    if (selected) { w().input = selected.input; $('#run-input').value = selected.input; }
    changed();
  }
});

function execute() {
  const built = current();
  if (!w().input.trim() || built.error) {
    $('#run-error').hidden = false;
    $('#run-error').textContent = built.error ?? '请输入本次 user.content。';
    $('#run-input').focus();
    return;
  }
  const sample = cases.find((item) => item.input === w().input);
  run = { number: ++runNumber, revision: state.revision, request: built.request, blocks: structuredClone(w().blocks),
    response: sample?.reply ?? '本次自定义输入已完成组装。未接入模型，因此没有生成真实回复。' };
  source = 'run'; mode = 'inspect'; render();
}

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'run-form') return;
  event.preventDefault(); execute();
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); toast(canStore ? 'V3 草稿已保存' : '当前只能保留在页面中'); }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !$('#dialog').open) { event.preventDefault(); execute(); }
});
$('#dialog').addEventListener('close', () => {
  if (dialogFocus?.isConnected) dialogFocus.focus(); else document.querySelector('[data-mode="edit"]')?.focus();
});
window.addEventListener('pagehide', save);
render();
