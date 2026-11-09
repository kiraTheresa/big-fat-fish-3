import { templates, initialState, cases } from './data.js';

const STORAGE = 'fish.prompt-studio.demo.v1';
const $ = (selector) => document.querySelector(selector);
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = {
  fish: '<path d="M3 12c4-7 10-7 14-2l4-3v10l-4-3c-4 5-10 5-14-2Z"/><circle cx="8" cy="11" r=".6"/>',
  blocks: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/>',
  workspace: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M8 9h13"/>',
  notes: '<path d="M6 3h9l4 4v14H6V3Z"/><path d="M14 3v5h5M9 12h7M9 16h5"/>',
  shield: '<path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  message: '<path d="M4 4h16v12H9l-5 4V4Z"/><path d="M8 8h8M8 12h5"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4V3Z"/>',
  history: '<path d="M3 10a9 9 0 1 1 1 7M3 4v6h6M12 7v5l3 2"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 3v4M18 5h4"/>',
  cat: '<path d="m5 10-1-7 7 4h2l7-4-1 7a8 8 0 1 1-14 0Z"/><path d="M8 12h.01M16 12h.01m-6 4 2 1 2-1"/>',
  theater: '<path d="M4 4c4 3 8 3 12 0v7c0 5-5 8-6 8s-6-3-6-8V4Z"/><path d="M7 9h1M12 9h1M7 13c2 2 4 2 6 0M18 7l3-1v9c0 3-3 5-5 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  up: '<path d="m6 14 6-6 6 6"/>', down: '<path d="m6 10 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  focus: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5m8 0h5v-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  compare: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16M6 9h3M15 9h3M6 13h3M15 15h3"/>',
  save: '<path d="M4 3h13l4 4v14H3V3h1Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.blocks}</svg>`;
const action = (name, label, symbol, className = 'btn', attributes = '') => `<button type="button" class="${className}" data-action="${name}" ${attributes}>${symbol ? icon(symbol) : ''}${label}</button>`;
const iconButton = (name, label, symbol, attributes = '') => action(name, '', symbol, 'icon-btn', `aria-label="${label}" title="${label}" ${attributes}`);
const number = (n) => new Intl.NumberFormat('en-US').format(n);

let storageAvailable = true;
let recoveryNotice = '';
let state = load();
let selectedCase = cases[0];
let testInput = selectedCase.input;
let result = null;
let editorMode = 'edit';
let mobilePanel = 'edit';
let focusMode = false;
let busy = false;
let saveTimer;
let toastTimer;
let dragId = null;
let dragOrigin = null;
let dragging = false;
let suppressClick = false;
let dialogFocus = null;
const editorPositions = new Map();
let renderedEditorKey = null;
const workspace = () => state.workspaces.find((w) => w.id === state.active);
const selectedBlock = () => workspace().blocks.find((b) => b.id === state.selected) ?? workspace().blocks[0];
const templateLibrary = () => [...templates, ...(state.library ?? [])];

function load() {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return initialState();
    const value = JSON.parse(raw);
    const validTools = (tools) => tools && ['memes', 'memory', 'draw'].every((key) => typeof tools[key] === 'boolean');
    const validBudget = (budget) => Number.isInteger(budget) && budget >= 512 && budget <= 16000;
    const validBlock = (b) => b && typeof b.id === 'string' && typeof b.key === 'string' && typeof b.title === 'string' && typeof b.category === 'string' && typeof b.content === 'string' && b.content.length <= 100000 && typeof b.enabled === 'boolean';
    if (value.version !== 1 || !Array.isArray(value.workspaces) || !value.workspaces.length || value.workspaces.length > 20
      || !value.workspaces.every((w) => typeof w.id === 'string' && typeof w.name === 'string' && validBudget(w.budget) && Array.isArray(w.blocks) && w.blocks.length > 0 && w.blocks.length <= 30 && w.blocks.every(validBlock) && w.blocks.some((b) => b.key === 'identity' && b.enabled && b.required) && new Set(w.blocks.map((b) => b.id)).size === w.blocks.length && (!w.snapshot || (Array.isArray(w.snapshot.blocks) && w.snapshot.blocks.length > 0 && w.snapshot.blocks.length <= 30 && w.snapshot.blocks.every(validBlock) && validTools(w.snapshot.tools) && validBudget(w.snapshot.budget) && Number.isFinite(w.snapshot.time) && w.snapshot.blocks.some((b) => b.key === 'identity' && b.enabled && b.required))))
      || !value.workspaces.some((w) => w.id === value.active) || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !value.workspaces.every((w) => validTools(w.tools))
      || (value.library && (!Array.isArray(value.library) || value.library.length > 30 || !value.library.every(validBlock)))) throw new Error('Invalid demo draft');
    return value;
  } catch (error) {
    // Keep unreadable storage intact; never silently overwrite an old draft.
    storageAvailable = false;
    recoveryNotice = error instanceof SyntaxError || error.message === 'Invalid demo draft'
      ? '之前的本地草稿无法读取，原数据仍保留。本次修改只保留在当前页面，可导出后另存。'
      : '浏览器未允许本地存储。本次仍可编辑，请在关闭页面前导出草稿。';
    return initialState();
  }
}

function persist() {
  if (storageAvailable) {
    try { localStorage.setItem(STORAGE, JSON.stringify(state)); }
    catch {
      storageAvailable = false;
      recoveryNotice = '本地保存失败。当前修改仍在页面中，请导出草稿后再关闭。';
      const warning = $('#storage-warning');
      if (warning) { warning.hidden = false; warning.textContent = recoveryNotice; }
    }
  }
  const status = $('#save-label');
  if (status) status.textContent = storageAvailable ? '已保存在此浏览器' : '仅保留在当前页面';
}

function changed({ render = false } = {}) {
  state.revision++;
  if (result) result.stale = true;
  const status = $('#save-label');
  if (status) status.textContent = '正在保存…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
  if (render) renderApp();
  else { renderComposition(); updateMetrics(); markStale(); }
}

function toast(message) {
  const target = $('#toast');
  target.textContent = message;
  target.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { target.hidden = true; }, 3500);
}

// shortcut: mixed-script token estimate for visual budgeting only; replace with the model tokenizer before enforcing real request limits.
function estimateTokens(text) {
  const characters = [...text];
  const cjk = characters.filter((c) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(c)).length;
  return Math.ceil(cjk + (characters.length - cjk) / 4);
}

function assemble() {
  const w = workspace();
  const inputTokens = estimateTokens(testInput);
  const toolTokens = Object.values(workspace().tools).filter(Boolean).length * 80;
  const blocks = w.blocks.filter((b) => b.enabled).map((b) => ({ ...b, original: b.content, tokens: estimateTokens(b.content), trimmed: 0 }));
  let excess = blocks.reduce((n, b) => n + b.tokens, 0) + inputTokens + toolTokens - w.budget;
  const history = blocks.find((b) => b.key === 'history');
  if (history && excess > 0) {
    const lines = history.content.split('\n');
    while (lines.length && excess > 0) {
      lines.shift();
      const next = lines.join('\n');
      const nextTokens = estimateTokens(next);
      excess -= history.tokens - nextTokens;
      history.tokens = nextTokens;
      history.content = next;
      history.trimmed++;
    }
  }
  const total = blocks.reduce((n, b) => n + b.tokens, 0) + inputTokens + toolTokens;
  return { blocks, total, inputTokens, toolTokens, overflow: total > w.budget, budget: w.budget };
}

function renderApp() {
  const previousEditor = $('#prompt-text');
  if (previousEditor && renderedEditorKey) editorPositions.set(renderedEditorKey, { start: previousEditor.selectionStart, end: previousEditor.selectionEnd, scroll: previousEditor.scrollTop });
  const w = workspace();
  if (!w.blocks.some((b) => b.id === state.selected)) state.selected = w.blocks.find((b) => b.category === '人设')?.id ?? w.blocks[0].id;
  const block = selectedBlock();
  $('#studio').innerHTML = `<div class="app ${focusMode ? 'focus-mode' : ''}">
    <aside class="rail" aria-label="工作台导航">
      <div class="logo" title="肥鱼 Prompt Studio">${icon('fish')}</div>
      ${action('workspace', '', 'workspace', 'rail-button active', 'aria-label="Prompt 工作空间" title="Prompt 工作空间" aria-current="page"')}
      ${action('library', '', 'blocks', 'rail-button', 'aria-label="打开积木库" title="积木库"')}
      ${action('notes', '', 'notes', 'rail-button', 'aria-label="设计说明与实施路线" title="设计说明与实施路线"')}
      <div class="rail-bottom"><span class="rail-dot" aria-hidden="true"></span><div class="avatar" aria-label="本地设计原型">DE</div></div>
    </aside>
    <div class="frame">
      <header class="topbar"><div class="breadcrumb"><span class="wordmark">肥鱼<span><small>Prompt Studio</small></span></span><span class="slash">/</span>
        <select id="workspace-select" class="workspace-select" aria-label="选择工作空间">${state.workspaces.map((item) => `<option value="${escape(item.id)}" ${item.id === w.id ? 'selected' : ''}>${escape(item.name)}</option>`).join('')}</select></div>
        <div class="top-actions"><span class="save-status"><span class="dot"></span><span id="save-label">${storageAvailable ? '已保存在此浏览器' : '仅保留在当前页面'}</span></span>${action('compare', '<span class="compare-label">比较快照</span>', 'compare', 'btn', 'aria-label="比较快照" title="比较快照"')}${action('snapshot', '存为快照', 'save')}</div>
      </header>
      <div id="storage-warning" class="storage-warning" role="alert" ${recoveryNotice ? '' : 'hidden'}>${escape(recoveryNotice)}</div>
      <div class="workspace-intro"><div><div class="title-row"><h1>${escape(w.name)}</h1><span class="tag outline">草稿</span></div><p>${escape(w.description)}</p></div>
        <div class="intro-meta"><span>编辑 → 拼接 → 试聊</span><span class="prototype-label"><span class="dot"></span>交互原型 · 本地数据</span></div></div>
      <div class="mobile-tabs" aria-label="工作区面板"><button type="button" data-panel="edit" aria-pressed="${mobilePanel === 'edit'}">编辑 Prompt</button><button type="button" data-panel="test" aria-pressed="${mobilePanel === 'test'}">模拟试聊</button></div>
      <main class="workbench" data-panel="${mobilePanel}">
        <section class="composition" aria-labelledby="composition-heading"><div class="section-heading"><h2 id="composition-heading">上下文拼图</h2><span class="small" id="block-count"></span></div><div class="composition-list" id="composition-list"></div>
          ${action('library', '添加积木', 'plus', 'add-block')}
          <div class="composition-note"><strong>${icon('sparkles')}每块，只负责一件事。</strong><p>选择左侧的积木，专注修改正文。<br>拖动调整顺序，右侧随时试聊。</p></div>
        </section>
        <section class="editor-panel" aria-labelledby="editor-title"><div class="editor-top"><span class="tag ${escape(block.color)}">${escape(block.category)}</span><div class="editor-title-row"><h2 id="editor-title">${escape(block.title)}</h2><div class="editor-controls">
          ${iconButton('up', '上移当前积木', 'up', w.blocks[0].id === block.id ? 'disabled' : '')}${iconButton('down', '下移当前积木', 'down', w.blocks.at(-1).id === block.id ? 'disabled' : '')}${iconButton('focus', focusMode ? '退出专注编辑' : '专注编辑', 'focus', `aria-pressed="${focusMode}"`)}${iconButton('remove', '移除当前积木', 'trash', block.required ? 'disabled' : '')}</div></div><p class="editor-description">${escape(block.description ?? '')}</p></div>
          <div class="editor-toolbar"><div class="segmented" aria-label="编辑方式"><button type="button" data-mode="edit" aria-pressed="${editorMode === 'edit'}">编辑</button><button type="button" data-mode="read" aria-pressed="${editorMode === 'read'}">阅读</button></div><label class="switch-label"><input id="block-enabled" type="checkbox" ${block.enabled ? 'checked' : ''} ${block.required ? 'disabled' : ''}>${block.required ? '始终带入' : '带入上下文'}</label></div>
          ${block.key === 'tools' ? `<div class="tools-options">${[['memes', '表情'], ['memory', '记忆'], ['draw', '绘图']].map(([key, label]) => `<label><input type="checkbox" data-tool="${key}" ${workspace().tools[key] ? 'checked' : ''}>${label}</label>`).join('')}</div>` : ''}
          <div class="editor-body"><textarea id="prompt-text" class="prompt-text" aria-label="${escape(block.title)} Prompt 正文" maxlength="100000" spellcheck="false" ${editorMode === 'read' ? 'hidden' : ''}>${escape(block.content)}</textarea><div id="reading-preview" class="reading-preview" ${editorMode === 'edit' ? 'hidden' : ''}></div></div>
          <div class="editor-hint">${icon('info')}<span>${escape(block.hint ?? '这个积木只在当前空间编辑；修改不会自动更新积木库中的副本。')}</span></div>
          <div class="editor-bottom"><span id="editor-metrics"></span><span>Markdown · <kbd>⌘ / Ctrl + S</kbd> 保存</span></div>
        </section>
        <aside class="test-panel" aria-labelledby="test-title"><div class="test-top"><div class="test-heading"><h2 id="test-title">试聊一下</h2><span class="tag outline">模拟</span></div><select id="scenario-select" class="scenario-select" aria-label="选择验证场景">${cases.map((item) => `<option value="${item.id}" ${item.id === selectedCase.id ? 'selected' : ''}>${escape(item.title)}</option>`).join('')}</select><p class="case-expectation"><strong>这次关注</strong><br>${escape(selectedCase.expected)}</p></div>
          <div class="conversation" id="conversation" aria-live="polite"></div>
          <form id="test-form" class="composer"><label for="test-input">测试消息</label><textarea id="test-input" maxlength="12000" placeholder="输入一句话，看看它如何被带入上下文…">${escape(testInput)}</textarea><div class="composer-actions"><span class="composer-help">${icon('shield')} 不发送到 QQ</span><button type="submit" class="btn primary" id="run-test">${icon('play')}模拟试聊</button></div></form>
          <div class="test-footer">预设回复演示流程 · 不调用模型、不计费</div>
        </aside>
      </main>
      <section class="context-strip" aria-label="本轮上下文概览"><div><h3>本轮带了什么</h3><p>只看需要的，留出对话的空间。</p></div><div><div class="budget-track" id="budget-track"></div><div class="budget-legend" id="budget-legend"></div></div>${action('preview', '查看组装', 'arrow')}</section>
    </div>
  </div>`;
  renderComposition();
  renderConversation();
  updateMetrics();
  renderReading();
  renderedEditorKey = w.id + ':' + block.id;
  const position = editorPositions.get(renderedEditorKey);
  if (position) { $('#prompt-text').setSelectionRange(position.start, position.end); $('#prompt-text').scrollTop = position.scroll; }
}

function renderComposition() {
  const w = workspace();
  $('#block-count').textContent = `${w.blocks.filter((b) => b.enabled).length} / ${w.blocks.length} 块启用`;
  $('#composition-list').innerHTML = w.blocks.map((b, i) => `<button type="button" data-block="${escape(b.id)}" aria-pressed="${b.id === state.selected}" class="block-item ${b.id === state.selected ? 'selected' : ''} ${b.enabled ? '' : 'off'}"><span class="block-symbol">${icon(b.icon)}</span><span class="block-copy"><span class="block-title" data-category="${escape(b.category)}">${escape(b.title)}<span class="tag">${escape(b.category)}</span></span><span class="block-sub">${escape(b.summary ?? '自定义 Prompt 积木')}</span>${b.enabled ? '' : '<span class="tag">未带入</span>'}</span><span class="block-number mono">${String(i + 1).padStart(2, '0')}</span></button>`).join('');
}

function updateMetrics() {
  const block = selectedBlock();
  $('#editor-metrics').textContent = `${number([...block.content].length)} 字符 · ≈ ${number(estimateTokens(block.content))} tokens`;
  const built = assemble();
  $('#budget-track').innerHTML = built.blocks.map((b) => `<span class="budget-segment" data-color="${escape(b.color)}" style="width:${Math.min(100, b.tokens / built.budget * 100)}%" title="${escape(b.title)}：约 ${b.tokens} tokens"></span>`).join('');
  $('#budget-legend').innerHTML = `<span class="budget-total ${built.overflow ? 'warning' : ''}"><strong>≈ ${number(built.total)}</strong> / ${number(built.budget)} tokens${built.overflow ? ' · 超出示例预算' : ''}</span><span>含本轮输入与工具占位估算</span>`;
}

function renderReading() {
  $('#reading-preview').innerHTML = selectedBlock().content.split('\n').map((line) => line.startsWith('# ') ? `<h3>${escape(line.slice(2))}</h3>` : line.startsWith('## ') ? `<h4>${escape(line.slice(3))}</h4>` : escape(line)).join('\n');
}

function renderConversation() {
  const source = result ?? { input: selectedCase.input, reply: selectedCase.reply, sample: true };
  const persona = workspace().blocks.find((b) => b.category === '人设' && b.enabled);
  $('#conversation').innerHTML = `<div class="chat-user"><div class="chat-label">Kira <span class="mini-avatar">K</span></div><div class="bubble">${escape(source.input)}</div></div><div class="chat-assistant"><div class="chat-label"><span class="mini-avatar">${icon(persona?.icon ?? 'fish')}</span>${escape(persona?.title ?? '聊天伙伴')}<span class="tag">预设示例</span></div><div class="bubble">${escape(source.reply)}</div><p class="sample-caption">${icon('info')}场景预设，不代表模型遵循了当前 Prompt</p></div>${source.sample ? '' : `<div class="simulation-note">组装已更新。<span id="result-state">${source.stale ? '内容已修改，需重新模拟以更新本轮材料。' : '已捕获本轮材料，可查看组装与积木顺序。'}</span></div><div class="result-actions">${action('last-preview', '查看本次材料', 'notes', 'btn quiet')}${action('feedback', '记一条体验反馈', 'message', 'btn quiet')}</div>`}`;
  $('#run-test').disabled = busy;
}

function markStale() { if ($('#result-state') && result?.stale) $('#result-state').textContent = '内容已修改，需重新模拟以更新本轮材料。'; }

function openDialog(type, title, description, body, footer = '') {
  dialogFocus = document.activeElement;
  const target = $('#dialog');
  target.innerHTML = `<div class="dialog-header"><div><h2 id="dialog-title">${title}</h2><p>${description}</p></div>${iconButton('close-dialog', '关闭面板', 'close')}</div><div class="dialog-body">${body}</div>${footer ? `<div class="dialog-footer">${footer}</div>` : ''}`;
  if (!target.open) target.showModal();
}

function showLibrary() {
  openDialog('library', '积木库', '复用一段好 Prompt，组合成适合当前场景的空间。', '<label class="small muted" for="library-search">搜索名称或类别</label><input id="library-search" class="library-search" placeholder="人设、记忆、回应方式…"><div id="library-grid" class="library-grid"></div>', `<span>加入后是独立副本，修改不会影响其他空间。</span>${action('save-block', '把当前积木存入库', 'plus')}`);
  renderLibrary();
}

function renderLibrary(query = '') {
  const matches = templateLibrary().filter((t) => `${t.title} ${t.category} ${t.summary}`.toLowerCase().includes(query.toLowerCase()));
  $('#library-grid').innerHTML = matches.length ? matches.map((t) => {
    const exists = workspace().blocks.some((b) => b.key === t.key);
    const replaces = ['人设', '回应方式'].includes(t.category) && workspace().blocks.some((b) => b.category === t.category);
    return `<article class="library-card"><div class="card-head">${icon(t.icon)}<h3>${escape(t.title)}</h3><span class="tag ${escape(t.color)}">${escape(t.category)}</span></div><p>${escape(t.summary ?? '保存在此浏览器的自定义积木')}</p>${action('add-template', exists ? '已在空间中' : replaces ? '替换当前' + t.category : '加入空间', exists ? 'check' : 'plus', 'btn', `data-key="${escape(t.key)}" ${exists ? 'disabled' : ''}`)}</article>`;
  }).join('') : '<p class="empty">没有找到这个积木，换个关键词试试。</p>';
}

function showPreview(captured = null) {
  const built = captured ?? assemble();
  const notice = built.overflow ? '固定材料与本轮输入已超出示例预算。保留正文并明确提示，不截断规则；正式接入前需压缩材料或调整预算。' : '按左侧顺序组装。记忆使用你在 demo 中编辑的素材，不进行真实检索；近期对话超预算时按整行裁掉最旧内容。';
  openDialog(captured ? 'captured-preview' : 'preview', captured ? '这一次的上下文' : '本轮上下文', 'Prompt 的去向看得见，才知道该改哪里。', `
    <div class="request-notice">${notice}<br>所有 token 数字是混合文本粗估，工具按占位值估算；不含图片与协议开销，不是模型真实计量或上线限额。</div>
    <div class="request-controls"><span>≈ <strong>${number(built.total)}</strong> tokens</span><span> / </span>${captured ? `<span>${number(built.budget)} 预算（快照）</span>` : `<label for="budget-select">示例输入预算</label><select id="budget-select">${[512, 1000, 4000, 8000, 16000].map((n) => `<option value="${n}" ${workspace().budget === n ? 'selected' : ''}>${number(n)}</option>`).join('')}</select>`}</div>
    <div class="preview-stack">${built.blocks.map((b, i) => `<details class="preview-block" ${i === 0 ? 'open' : ''}><summary><span class="mono muted">${String(i + 1).padStart(2, '0')}</span><strong>${escape(b.title)}</strong><span class="tag ${escape(b.color)}">${escape(b.category)}</span><span class="mono muted">≈ ${b.tokens} t${b.trimmed ? ` · 裁去 ${b.trimmed} 行` : ''}</span></summary><pre>${escape(b.content || '（没有可带入的内容）')}</pre></details>`).join('')}
    <details class="preview-block"><summary><strong>本轮用户输入</strong><span class="mono muted">≈ ${built.inputTokens} t</span></summary><pre>${escape(captured ? result.input : testInput)}</pre></details>
    <details class="preview-block"><summary><strong>工具能力</strong><span class="mono muted">≈ ${built.toolTokens} t（占位）</span></summary><pre>${escape(Object.entries(captured ? result.tools : workspace().tools).filter(([, enabled]) => enabled).map(([key]) => ({ memes: '查找 / 发送表情', memory: '读取 / 保存事实', draw: '绘图' }[key])).join('\n') || '没有启用的工具')}</pre></details></div>`, `<span>只读预览 · ${captured ? '保留模拟时刻的材料' : '随当前编辑更新'}</span>${action('export', '导出草稿 JSON', 'notes')}`);
}

function showCompare() {
  const w = workspace();
  const snapshot = w.snapshot;
  const differs = (b, index, other) => { const match = other.find((o) => o.id === b.id); return !match || match.content !== b.content || match.enabled !== b.enabled || other[index]?.id !== b.id; };
  const hasChanges = snapshot && (w.blocks.length !== snapshot.blocks.length || w.blocks.some((b, i) => differs(b, i, snapshot.blocks)) || w.budget !== snapshot.budget || JSON.stringify(w.tools) !== JSON.stringify(snapshot.tools));
  const body = snapshot ? `<div class="request-notice">快照保存的是这个空间的积木内容、顺序、启用状态、预算与工具开关。恢复只影响当前空间，之前的编辑会被替换。<br>${hasChanges ? '仅展开有变化的积木，未变化的正文已收起。' : '当前草稿与快照一致，还没有变化。'}</div><div class="diff-columns">${[[snapshot.blocks, `保存的快照 · ${new Date(snapshot.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`], [w.blocks, '当前草稿']].map(([blocks, title], col) => `<section class="diff-column"><h3>${title}</h3>${blocks.map((b, i) => { const different = differs(b, i, col ? snapshot.blocks : w.blocks); if (!different) return ''; return `<div class="diff-item ${different ? 'changed' : ''}"><strong>${i + 1}. ${escape(b.title)}</strong> <span class="tag">${b.enabled ? '带入' : '停用'}${different ? ' · 有变化' : ''}</span><pre>${escape(b.content)}</pre></div>`; }).join('')}<div class="diff-item"><strong>输入预算：${number(col ? w.budget : snapshot.budget)} tokens</strong><pre>${escape(JSON.stringify(col ? workspace().tools : snapshot.tools))}</pre></div></section>`).join('')}</div>` : '<div class="empty"><h3>还没有保存过快照</h3><p>先存一份当前内容，再修改 Prompt，就能在这里比较。</p></div>';
  openDialog('compare', '比较快照', '并排查看改了什么，不必凭记忆来回切换。', body, `<span>每个空间保留最近一份手动快照。</span>${snapshot ? action('restore', '恢复这份快照', 'history') : action('snapshot', '保存第一份快照', 'save')}`);
}

function showNotes() {
  openDialog('notes', '这张工作台，为哪几件事服务？', '设计决定、原型边界与下一步，放在同一个地方。', `<div class="notes">
    <h3>主任务：改一句 Prompt，马上检查它去了哪里。</h3><p>左侧是上下文积木，中间是当前正文，右侧是固定场景的试聊。组装预览、积木库和快照比较按需打开，编辑位置一直保留。</p>
    <h3>我们收起了什么</h3><ul><li>不把运行概览、日志、用量和权限混进 Prompt 编辑区，它们属于运维任务。</li><li>不把编辑、请求 JSON、测试、评审和发布全部铺成一张长表单。</li><li>不做自由画布、复杂连线或任意面板布局。顺序拼接足够表达当前业务。</li></ul>
    <h3>这一版能体验什么</h3><p>编辑与阅读、拖动和按钮排序、添加与替换积木、启停、独立工作空间、专注模式、上下文预览、本地保存、快照比较与恢复、导出、场景模拟。</p>
    <h3>还没有接入什么</h3><p>所有材料是示例；没有真实模型、QQ、后端持久化、语义检索或发布。试聊回复是场景预设，不能验证 Prompt 效果。预算数字是粗估；真正的 token 计量和模型上限仍需后续核对。</p>
    <h3>每个阶段怎么循环</h3><p>选一个具体任务 → 做可操作样稿 → 浏览器走通 → 检查截图与反馈 → 修改 → 记录结论。未解决的设计问题留在原型中，不提前迁入产品。</p>
    <table class="notes-table"><thead><tr><th>阶段</th><th>交付与验收</th></tr></thead><tbody><tr><td>01 · 眼前的原型</td><td>能找到主体、改文案、拼上下文；记录哪些地方仍难用。</td></tr><tr><td>02 · 人设与状态</td><td>按选定交互定义数据；角色切换与退出不污染用户事实。</td></tr><tr><td>03 · 真实上下文</td><td>接现有 builder 与测试沙盒；真实计量、来源与裁剪原因可查。</td></tr><tr><td>04 · 记忆与表情</td><td>事实可纠正、素材可选择；按相同场景比较模型表现。</td></tr><tr><td>05 · 发布与迁移</td><td>接草稿、评审、发布与旧数据保护；再统一其余管理页面。</td></tr></tbody></table>
    <p>正式接入沿用现有服务、工具执行与发布保护。每阶段采用相关的定向测试；真实模型费用与真实 QQ 操作另行安排。</p></div>`, `<span>本地交互原型 · 2026-11-04</span>${action('feedback', '记一条体验反馈', 'message')}`);
}

function exportDraft() {
  const payload = { ...state, prototype: true, exportedAt: new Date().toISOString() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'fish-studio-demo.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出本地 demo 草稿');
}

function reorder(id, targetIndex) {
  const blocks = workspace().blocks;
  const oldIndex = blocks.findIndex((b) => b.id === id);
  if (oldIndex < 0 || targetIndex < 0 || targetIndex >= blocks.length || oldIndex === targetIndex) return;
  const [block] = blocks.splice(oldIndex, 1);
  blocks.splice(targetIndex, 0, block);
  state.selected = id;
  changed({ render: true });
}

async function handleAction(name, target) {
  if (name === 'close-dialog') return $('#dialog').close();
  if (name === 'workspace') { focusMode = false; mobilePanel = 'edit'; renderApp(); return; }
  if (name === 'library') return showLibrary();
  if (name === 'notes') return showNotes();
  if (name === 'preview') return showPreview();
  if (name === 'last-preview' && result) return showPreview(result.built);
  if (name === 'compare') return showCompare();
  if (name === 'export') return exportDraft();
  if (name === 'focus') { focusMode = !focusMode; mobilePanel = 'edit'; renderApp(); $('#prompt-text').focus(); return; }
  if (name === 'up' || name === 'down') {
    reorder(state.selected, workspace().blocks.findIndex((b) => b.id === state.selected) + (name === 'up' ? -1 : 1));
    ($(`[data-action="${name}"]:not(:disabled)`) ?? $(`[data-block="${CSS.escape(state.selected)}"]`))?.focus();
    return;
  }
  if (name === 'snapshot') {
    const w = workspace();
    w.snapshot = { time: Date.now(), blocks: structuredClone(w.blocks), budget: w.budget, tools: structuredClone(workspace().tools) };
    persist();
    if ($('#dialog').open) showCompare();
    toast('已保存当前空间快照，可以放心修改后比较');
    return;
  }
  if (name === 'restore') {
    openDialog('confirm-restore', '恢复这份快照？', '当前空间的积木、预算和工具开关将替换为快照内容。', '<p class="small muted">其他空间和积木库不受影响。可以先导出草稿保留当前编辑。</p>', `${action('export', '先导出草稿', 'notes')}<span>${action('close-dialog', '取消')}${action('confirm-restore', '恢复快照', 'history', 'btn primary')}</span>`);
    return;
  }
  if (name === 'confirm-restore') {
    const w = workspace();
    w.blocks = structuredClone(w.snapshot.blocks);
    w.budget = w.snapshot.budget;
    workspace().tools = structuredClone(w.snapshot.tools);
    changed({ render: true });
    $('#dialog').close();
    toast('当前空间已恢复到快照');
    return;
  }
  if (name === 'add-template') {
    const template = templateLibrary().find((t) => t.key === target.dataset.key);
    if (!template || workspace().blocks.some((b) => b.key === template.key)) return;
    const blocks = workspace().blocks;
    const replaceIndex = ['人设', '回应方式'].includes(template.category) ? blocks.findIndex((b) => b.category === template.category) : -1;
    if (replaceIndex < 0 && blocks.length >= 30) return toast('一个空间最多放 30 块，先停下来整理一下吧');
    const block = { ...structuredClone(template), id: crypto.randomUUID(), enabled: true };
    if (replaceIndex >= 0) blocks.splice(replaceIndex, 1, block);
    else blocks.push(block);
    state.selected = block.id;
    editorMode = 'edit';
    changed({ render: true });
    $('#dialog').close();
    toast(replaceIndex >= 0 ? `已替换当前${template.category}，其他积木保留` : `已加入「${template.title}」`);
    return;
  }
  if (name === 'remove') {
    if (selectedBlock().required) return;
    openDialog('remove', '从空间中移除这块积木？', '只影响当前空间。可以先把编辑后的内容存入积木库，再移除。', `<p>当前积木：${escape(selectedBlock().title)}</p>`, `${action('close-dialog', '取消')}<span>${action('remove-and-save', '存入库并移除', 'bookmark')}${action('confirm-remove', '移除', 'trash', 'btn danger')}</span>`);
    return;
  }
  if (name === 'confirm-remove' || name === 'remove-and-save') {
    const original = selectedBlock();
    if (original.required) return;
    if (name === 'remove-and-save') {
      if ((state.library?.length ?? 0) >= 30) return toast('积木库已满，内容未移除');
      state.library ??= [];
      state.library.push({ ...structuredClone(original), key: crypto.randomUUID(), id: crypto.randomUUID(), title: original.title + ' · 我的副本', required: false });
    }
    workspace().blocks = workspace().blocks.filter((b) => b.id !== original.id);
    state.selected = workspace().blocks[0].id;
    changed({ render: true });
    $('#dialog').close();
    toast(name === 'remove-and-save' ? '已存入库，并从当前空间移除' : '已从当前空间移除');
    return;
  }
  if (name === 'save-block') {
    if ((state.library?.length ?? 0) >= 30) return toast('本地库最多保留 30 个自定义积木');
    const original = selectedBlock();
    const block = { ...structuredClone(original), key: crypto.randomUUID(), id: crypto.randomUUID(), title: original.title + ' · 我的副本', required: false };
    state.library ??= [];
    state.library.push(block);
    persist();
    showLibrary();
    toast('已存入积木库，可在另一个空间复用');
    return;
  }
  if (name === 'feedback') {
    openDialog('feedback', '留下这次体验的一个发现', '记下哪里顺手、哪里需要找、哪里还不理解。', `<label for="feedback-input" class="small muted">体验反馈（保存在当前浏览器，导出时一并带走）</label><textarea id="feedback-input" class="feedback-input" maxlength="4000" placeholder="例如：我想改语气，但不知道该改人设还是回应方式。">${escape(state.feedback ?? '')}</textarea>`, `<span>不会发送给任何人。</span>${action('save-feedback', '保存反馈', 'check', 'btn primary')}`);
    return;
  }
  if (name === 'save-feedback') {
    state.feedback = $('#feedback-input').value;
    persist();
    $('#dialog').close();
    toast('反馈已保存在本地草稿中');
  }
}

document.addEventListener('click', (event) => {
  if (suppressClick) { event.preventDefault(); return; }
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  if (target.dataset.action) handleAction(target.dataset.action, target);
  else if (target.dataset.block) {
    state.selected = target.dataset.block;
    editorMode = 'edit';
    renderApp();
    $(`[data-block="${CSS.escape(state.selected)}"]`)?.focus();
  } else if (target.dataset.mode) {
    editorMode = target.dataset.mode;
    renderApp();
    $(`[data-mode="${editorMode}"]`)?.focus();
  } else if (target.dataset.panel) {
    mobilePanel = target.dataset.panel;
    $('.workbench').dataset.panel = mobilePanel;
    document.querySelectorAll('.mobile-tabs [data-panel]').forEach((button) => button.setAttribute('aria-pressed', button.dataset.panel === mobilePanel));
  }
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.id === 'prompt-text') { selectedBlock().content = target.value; changed(); }
  if (target.id === 'test-input') { testInput = target.value; if (result) result.stale = true; updateMetrics(); markStale(); }
  if (target.id === 'library-search') renderLibrary(target.value);
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.id === 'workspace-select') {
    persist();
    state.active = target.value;
    state.selected = workspace().blocks.find((b) => b.category === '人设')?.id;
    result = null;
    editorMode = 'edit';
    renderApp();
    persist();
  } else if (target.id === 'block-enabled') { selectedBlock().enabled = target.checked; changed(); }
  else if (target.dataset.tool) { workspace().tools[target.dataset.tool] = target.checked; changed(); }
  else if (target.id === 'scenario-select') {
    selectedCase = cases.find((c) => c.id === target.value);
    testInput = selectedCase.input;
    result = null;
    renderApp();
  } else if (target.id === 'budget-select') {
    workspace().budget = Number(target.value);
    changed();
    showPreview();
    $('#budget-select')?.focus();
  }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'test-form') return;
  event.preventDefault();
  if (busy) return;
  if (!testInput.trim()) { toast('先输入一句测试消息'); $('#test-input').focus(); return; }
  busy = true;
  const input = testInput;
  const built = assemble();
  const revision = state.revision;
  const active = state.active;
  const sourceCase = cases.find((c) => c.input === input);
  const tools = structuredClone(workspace().tools);
  $('#run-test').disabled = true;
  $('#run-test').textContent = '正在组装…';
  await new Promise((resolve) => setTimeout(resolve, 350));
  busy = false;
  if (active !== state.active) { renderConversation(); return; }
  result = { input, tools, built, revision, stale: state.revision !== revision || input !== testInput,
    reply: sourceCase?.reply ?? '这是一条自定义测试输入。demo 已组装当前材料；尚未接入模型，不能判断它会怎样回应。' };
  renderConversation();
  $('#run-test').innerHTML = icon('play') + '模拟试聊';
  $('#conversation').scrollTop = $('#conversation').scrollHeight;
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    clearTimeout(saveTimer);
    persist();
    toast(storageAvailable ? '草稿已保存在此浏览器' : '当前只能保留在页面中，请导出草稿');
  }
});

// Pointer sorting also works inside embedded browsers; buttons remain the keyboard/touch alternative.
document.addEventListener('pointerdown', (event) => {
  const block = event.target.closest('[data-block]');
  if (!block || event.button !== 0 || event.pointerType !== 'mouse') return;
  dragId = block.dataset.block;
  dragOrigin = [event.clientX, event.clientY];
});
document.addEventListener('pointermove', (event) => {
  if (!dragId || !dragOrigin) return;
  if (Math.hypot(event.clientX - dragOrigin[0], event.clientY - dragOrigin[1]) > 8) dragging = true;
  if (!dragging) return;
  event.preventDefault();
  document.querySelectorAll('.drag-over').forEach((b) => b.classList.remove('drag-over'));
  event.target.closest('[data-block]')?.classList.add('drag-over');
});
function endDrag(event) {
  const block = event.target.closest('[data-block]');
  if (dragging && dragId && block && event.type === 'pointerup') {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    reorder(dragId, workspace().blocks.findIndex((b) => b.id === block.dataset.block));
  }
  dragId = null;
  dragOrigin = null;
  dragging = false;
  document.querySelectorAll('.drag-over').forEach((b) => b.classList.remove('drag-over'));
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
$('#dialog').addEventListener('close', () => {
  if (dialogFocus?.isConnected) dialogFocus.focus();
  else $(`[data-block="${CSS.escape(state.selected)}"]`)?.focus();
});
window.addEventListener('pagehide', persist);
renderApp();
