import { initialState, templates, cases } from '../data.js';
import { buildRequest, initialHistory, parseHistory } from '../v2/request.js';

const STORAGE = 'fish.prompt-studio.demo.v4';
const $ = (selector) => document.querySelector(selector);
const e = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = {
  fish: '<path d="M3 12c4-7 10-7 14-2l4-3v10l-4-3c-4 5-10 5-14-2Z"/><circle cx="8" cy="11" r=".6"/>',
  overview: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/>',
  logs: '<path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h5"/>',
  requests: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  usage: '<path d="M4 3v18h18M9 17v-5m5 5V7m5 10v-7"/>',
  prompt: '<path d="M21 11a9 9 0 0 1-9 9H4l-2 2v-9a9 9 0 1 1 19-2ZM7 9h9M7 13h6"/>',
  images: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 17 6-6 5 5 3-3 4 4"/><circle cx="15" cy="8" r="1"/>',
  memes: '<circle cx="12" cy="12" r="9"/><path d="M8 14q4 5 8 0M8 9h.01M16 9h.01"/>',
  config: '<path d="M3 7h7m5 0h6M3 17h3m5 0h10"/><circle cx="12" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  jobs: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  users: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m3 11v-3a6 6 0 0 0-3-5"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>',
  edit: '<path d="m15 4 5 5M4 15 15 4a3.5 3.5 0 0 1 5 5L9 20l-6 1 1-6Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="m6 14 6-6 6 6"/>', down: '<path d="m6 10 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  terminal: '<path d="m4 6 6 6-6 6m9 0h7"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.code}</svg>`;
const btn = (action, label, symbol, extra = '') => `<button type="button" class="button" data-action="${action}" ${extra}>${symbol ? icon(symbol) : ''}${label}</button>`;
const ibtn = (action, label, symbol, extra = '') => `<button type="button" class="icon-button" data-action="${action}" aria-label="${e(label)}" title="${e(label)}" ${extra}>${icon(symbol)}</button>`;
const badge = (text, type = '') => `<span class="badge ${type}">${e(text)}</span>`;
const baseBlock = (key) => ({ ...structuredClone(templates.find((t) => t.key === key)), id: key, enabled: true });
let storageWarning = '';
let canStore = true;
let state = load();
let editing = false;
let backup = null;
let format = 'text';
let source = 'draft';
let run = null;
let runNumber = 0;
let revision = 0;
let toastTimer;
let lastFocus;
const w = () => state.workspaces.find((item) => item.id === state.active);
const role = () => state.roles[w().roleId];

function defaults() {
  const roles = Object.fromEntries(['fish', 'cat'].map((key) => [key, { name: baseBlock(key).title, content: baseBlock(key).content }]));
  const workspaces = initialState().workspaces.map((workspace) => ({
    id: workspace.id, name: workspace.name, model: 'deepseek-flash', roleId: workspace.id === 'daily' ? 'fish' : 'cat',
    adaptations: { fish: '', cat: '' },
    roleplay: { enabled: workspace.id === 'theater', content: baseBlock('roleplay').content },
    blocks: workspace.blocks.filter((b) => b.category !== '人设' && b.key !== 'roleplay').map((b) => ({ ...b, ...(b.key === 'history' ? { content: initialHistory() } : {}) })),
    tools: workspace.tools, input: cases[0].input, scenario: cases[0].id,
  }));
  return { version: 4, active: 'daily', roles, workspaces };
}
function load() {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return defaults();
    const value = JSON.parse(raw);
    const text = (x, max = 100000) => typeof x === 'string' && x.length <= max;
    const valid = value?.version === 4 && value.roles && ['fish', 'cat'].every((key) => text(value.roles[key]?.name, 80) && text(value.roles[key]?.content))
      && Array.isArray(value.workspaces) && value.workspaces.length === 2 && new Set(value.workspaces.map((x) => x.id)).size === 2
      && value.workspaces.every((x) => text(x.id, 80) && text(x.name, 80) && text(x.model, 80) && ['fish', 'cat'].includes(x.roleId)
        && x.adaptations && ['fish', 'cat'].every((key) => text(x.adaptations[key])) && typeof x.roleplay?.enabled === 'boolean' && text(x.roleplay.content)
        && text(x.input, 12000) && text(x.scenario, 80) && x.tools && ['memes', 'memory', 'draw'].every((key) => typeof x.tools[key] === 'boolean')
        && Array.isArray(x.blocks) && x.blocks.length > 0 && x.blocks.length <= 30 && new Set(x.blocks.map((b) => b.id)).size === x.blocks.length
        && x.blocks.every((b) => text(b.id, 80) && text(b.key, 80) && text(b.title, 100) && text(b.category, 100) && text(b.content) && typeof b.enabled === 'boolean')
        && x.blocks.some((b) => b.key === 'identity' && b.required && b.enabled)) && value.workspaces.some((x) => x.id === value.active);
    if (!valid) throw new Error('Invalid draft');
    return value;
  } catch {
    canStore = false;
    storageWarning = '本地草稿无法读取，原有数据未覆盖。本次修改只保留在页面中。';
    return defaults();
  }
}
function persist() {
  if (!canStore) return false;
  try { localStorage.setItem(STORAGE, JSON.stringify(state)); return true; }
  catch { canStore = false; storageWarning = '浏览器保存失败，当前内容仍保留在页面中。可复制或下载完整请求另存。'; return false; }
}
function assembledWorkspace(workspace = w(), selectedRole = role()) {
  const blocks = [
    { key: 'role', title: `角色模板 · ${selectedRole.name}`, content: selectedRole.content, enabled: true },
    { key: 'adaptation', title: '当前会话的性格补充', content: workspace.adaptations[workspace.roleId], enabled: !!workspace.adaptations[workspace.roleId].trim() },
    { key: 'roleplay', title: '临时扮演（仅当前场景，不写入长期人设或用户事实）', content: workspace.roleplay.content, enabled: workspace.roleplay.enabled },
    ...workspace.blocks,
  ];
  return { ...workspace, blocks };
}
function current() {
  try {
    if (!role().content.trim()) throw new Error('角色模板不能为空。');
    return { request: buildRequest(assembledWorkspace(), w().input), error: '' };
  } catch (error) { return { request: null, error: error.message }; }
}
function visible() { return source === 'run' && run ? { request: run.request, error: '' } : current(); }
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2800);
}
function highlight(json) {
  let html = '', cursor = 0;
  for (const match of json.matchAll(/"(?:\\.|[^"\\])*"|\b(?:true|false|null|\d+(?:\.\d+)?)\b/g)) {
    html += e(json.slice(cursor, match.index));
    const key = match[0].startsWith('"') && json.slice(match.index + match[0].length).trimStart().startsWith(':');
    html += `<span class="${key ? 'json-key' : match[0].startsWith('"') ? 'json-string' : 'json-primitive'}">${e(match[0])}</span>`;
    cursor = match.index + match[0].length;
  }
  return html + e(json.slice(cursor));
}
const groups = [
  ['运行排查', [['overview', '运行概览'], ['logs', '运行日志'], ['requests', '请求与稳定性'], ['usage', 'Token 用量与费用']]],
  ['开发调试', [['prompt', 'Prompt 工作台']]],
  ['素材收藏', [['images', '绘图作品'], ['memes', '表情收藏']]],
  ['实例管理', [['config', '配置与能力'], ['jobs', '任务调度'], ['users', '用户与权限']]],
];
function render() {
  const scroll = $('#document')?.scrollTop ?? 0;
  $('#app').innerHTML = `<div class="app-shell">
    <aside class="product-sidebar" aria-label="页面导航"><div class="brand"><span class="brand-mark">${icon('fish')}</span><span><strong>大肥鱼</strong><small>开发工作台</small></span></div>
      <nav>${groups.map(([title, items]) => `<div class="nav-group"><p class="nav-label">${title}</p>${items.map(([key, name]) => `<button type="button" class="nav-item ${key === 'prompt' ? 'active' : ''}" data-action="nav" ${key === 'prompt' ? 'aria-current="page"' : ''}>${icon(key)}<span>${name}</span></button>`).join('')}</div>`).join('')}</nav>
      <div class="sidebar-bottom"><div class="local-note"><span class="status-dot neutral"></span><span>本地原型<small>BIG FAT FISH · V4</small></span></div><a class="version-link" href="../v3/">查看 V3 对比 ↗</a></div></aside>
    <div class="workspace"><header class="page-header"><div><p class="eyebrow">WORKSPACE / PROMPT STUDIO</p><div class="title-row"><h1>Prompt 工作台</h1>${badge('V4 DEMO')}</div><p class="page-description">组织角色与上下文，专注修改提示词。</p></div><span class="pill"><span class="status-dot neutral"></span>本地演示 · 未连接 QQ</span></header>
      <div class="page-meta"><span id="save-state">${editing ? '编辑中 · 尚未保存' : canStore ? '草稿保存在此浏览器' : '当前内容仅保留在页面中'}</span><span>保存仅更新原型草稿</span></div>
      <div class="page-controls"><label class="workspace-picker">工作区<select id="workspace-select" ${editing ? 'disabled title="保存或取消后可切换工作区"' : ''}>${state.workspaces.map((item) => `<option value="${e(item.id)}" ${item.id === w().id ? 'selected' : ''}>${e(item.name)}</option>`).join('')}</select></label><div class="display-control"><span>显示</span><div class="segmented" aria-label="页面显示方式"><button type="button" data-format="text" aria-pressed="${format === 'text'}">${icon('overview')}模块正文</button><button type="button" data-format="json" aria-pressed="${format === 'json'}">${icon('code')}原始 JSON</button></div></div><div class="edit-actions">${editing ? `${btn('cancel', '取消')}${btn('save', '保存 Save', 'check', 'id="save-button"')}` : btn('edit', '编辑 Edit', 'edit', 'id="edit-button"')}</div></div>
      <div id="storage-warning" class="notice" role="alert" ${storageWarning ? '' : 'hidden'}>${e(storageWarning)}</div>
      <main class="workbench"><section class="context-panel" aria-label="完整上下文"><div class="context-heading"><div><h2 id="context-title">完整上下文</h2><p id="context-caption">所有模块连续展开</p></div><div class="context-actions">${editing ? btn('library', '添加积木', 'plus') : ''}${ibtn('copy', '复制完整请求 JSON', 'copy')}${ibtn('download', '下载完整请求 JSON', 'download')}</div></div>
        <div id="document-notice" class="document-notice" hidden></div><div id="document" class="document" tabindex="0"></div><div class="context-footer"><span id="request-metrics"></span><span id="draft-state">${editing ? '未保存' : '只读'}</span></div></section>
      <aside class="run-panel" aria-labelledby="run-title"><div class="run-heading"><span class="terminal-symbol">${icon('terminal')}</span><div><h2 id="run-title">单次试聊</h2><p>输入一句，观察一次结果</p></div>${badge('模拟')}</div>
        <div class="run-content"><form id="run-form"><label for="scenario-select">试聊样例</label><select id="scenario-select"><option value="custom" ${w().scenario === 'custom' ? 'selected' : ''}>自定义输入</option>${cases.map((item) => `<option value="${item.id}" ${w().scenario === item.id ? 'selected' : ''}>${e(item.title)}</option>`).join('')}</select><div class="input-heading"><label for="run-input">本次输入</label><span>⌘ / Ctrl + Enter</span></div><textarea id="run-input" maxlength="12000" placeholder="试着对这个角色说一句话…">${e(w().input)}</textarea><p class="input-hint">将与左侧全部启用的上下文一起组装。</p><button class="button primary run-button" id="run-button" type="submit">${icon('terminal')}运行一次</button><p id="run-error" role="alert" class="error" hidden></p></form>
        <button type="button" class="request-link" data-action="show-request">${icon('code')}查看完整请求 JSON <span>↗</span></button>
        <section class="output-section" aria-labelledby="output-title"><div class="output-heading"><h3 id="output-title">输出</h3><span id="output-status">等待运行</span></div><div id="run-output" class="run-output" aria-live="polite"></div></section>
        <p class="simulation-note">预设回复用于体验界面，不代表模型或人设效果。结果不续入下一轮。</p>
        <details class="run-advanced" id="run-advanced"><summary>高级 · 本次请求快照</summary><div id="snapshot-content"></div></details></div>
        <div class="run-footer"><span class="status-dot neutral"></span>本地模拟，不调用 API / QQ</div></aside></main>
      <footer class="workspace-footer"><span>BIG FAT FISH</span><span>角色与素材均为示例 · 无线上变更</span></footer></div></div>`;
  renderDocument(); renderRun(); updateMeta();
  $('#document').scrollTop = scroll;
}
function textBody(content, binding, label, placeholder = '') {
  return editing && source === 'draft'
    ? `<textarea class="prompt-input" ${binding} aria-label="${e(label)}" spellcheck="false" maxlength="100000" placeholder="${e(placeholder)}">${e(content)}</textarea>`
    : content ? `<pre class="prompt-text">${e(content)}</pre>` : `<p class="empty-text">${e(placeholder)}</p>`;
}
function card(id, title, tag, subtitle, body, extra = '', className = '') {
  return `<article class="module-card ${className}" id="card-${e(id)}"><header class="module-header"><div class="module-title"><h3>${title}</h3>${tag}</div>${extra}</header><p class="module-subtitle">${subtitle}</p><div class="module-body">${body}</div></article>`;
}
function renderDocument() {
  const result = visible();
  const snap = source === 'run' && run;
  const workspace = snap ? run.workspace : w();
  const selectedRole = snap ? run.role : role();
  const editable = editing && !snap;
  if (format === 'json') {
    $('#document').innerHTML = result.error ? `<div class="empty-state"><h3>请先修正草稿</h3><p>${e(result.error)}</p>${btn('return-text', '回到模块正文')}</div>` : `<pre id="request-json" class="json-code"><code>${highlight(JSON.stringify(result.request, null, 2))}</code></pre>`;
    return;
  }
  const roleSelector = `<div class="role-selection"><span class="role-avatar">${icon(workspace.roleId === 'fish' ? 'fish' : 'memes')}</span><div>${editable ? `<label class="sr-only" for="role-select">角色模板</label><select id="role-select">${Object.entries(state.roles).map(([id, item]) => `<option value="${id}" ${id === workspace.roleId ? 'selected' : ''}>${e(item.name)}</option>`).join('')}</select>` : `<strong>${e(selectedRole.name)}</strong>`}<p>身份、自称、性格与表达方式</p></div><span class="role-template-label">角色模板</span></div>`;
  const scope = `<div class="scope-summary"><p><span>影响表达</span>身份与自称 · 群聊 / 私聊 · 戳一戳 · 工具后的回复</p><p><span>保持独立</span>公共规则 · 工具权限 · 用户事实</p><button type="button" class="text-button" data-action="scope">查看提示词作用范围 ↗</button></div>`;
  const flow = `<div class="persona-layers" aria-label="人设的三层作用范围"><a href="#card-role"><span>01 · 角色模板</span><strong>${e(selectedRole.name)}</strong><small>引用此角色的工作区共用</small></a><a href="#card-adaptation"><span>02 · 会话变化</span><strong>${workspace.adaptations[workspace.roleId].trim() ? '已有性格补充' : '沿用角色模板'}</strong><small>仅 ${e(workspace.name)} · 当前角色</small></a><a href="#card-roleplay"><span>03 · 临时扮演</span><strong>${workspace.roleplay.enabled ? '正在扮演' : '未启用'}</strong><small>当前场景 · 可随时退出</small></a></div>`;
  const roleCard = card('role', '角色模板', badge('角色专属', 'blue'), '修改保存在所选角色中，影响引用它的工作区。', roleSelector + textBody(selectedRole.content, 'data-field="role"', '角色模板正文') + scope);
  const adaptation = card('adaptation', '会话中的变化', badge('当前会话'), `仅作用于「${e(workspace.name)}」中的${e(selectedRole.name)}，不修改角色模板或其他角色。`, textBody(workspace.adaptations[workspace.roleId], 'data-field="adaptation"', '会话中的性格补充', '还没有长期性格补充，当前沿用角色模板。'), '<span class="source-label">手动编辑示例</span>');
  const playControls = editable ? `<label class="inline-toggle"><input type="checkbox" id="roleplay-enabled" ${workspace.roleplay.enabled ? 'checked' : ''}>启用扮演</label>` : badge(workspace.roleplay.enabled ? '已启用' : '未启用', workspace.roleplay.enabled ? 'violet' : '');
  const play = card('roleplay', '临时扮演', badge('当前场景', 'violet'), '启用后随本次请求带入；退出后恢复基础人设，不写入角色模板与事实记忆。', `<div class="roleplay-content" ${!workspace.roleplay.enabled && !editable ? 'hidden' : ''}>${textBody(workspace.roleplay.content, 'data-field="roleplay"', '临时扮演正文')}</div>${!workspace.roleplay.enabled && !editable ? '<p class="empty-text">当前没有剧情，使用角色本来的身份与表达。</p>' : ''}<div class="roleplay-foot"><span>${workspace.roleplay.enabled ? '持续到手动退出 · 仅当前工作区' : '编辑后可启用预置的「雨夜猫咖」剧情'}</span>${workspace.roleplay.enabled && !snap ? btn('exit-roleplay', '退出扮演') : ''}</div>`, playControls, workspace.roleplay.enabled ? 'roleplay-active' : '');
  const publicCards = workspace.blocks.map((block, index) => {
    const isMaterial = ['memory', 'history'].includes(block.key);
    let body;
    if (block.key === 'history' && !editable) {
      try { body = `<div class="history-list">${parseHistory(block.content).map((message) => `<div><span class="history-role">${e(message.role)}</span><pre>${e(message.content)}</pre></div>`).join('')}</div>`; }
      catch { body = `<pre class="prompt-text">${e(block.content)}</pre>`; }
    } else body = textBody(block.content, `data-block="${e(block.id)}"`, `${block.title}正文`);
    if (block.key === 'tools') body += `<div class="tool-options">${[['memory', '记忆'], ['memes', '表情'], ['draw', '绘图']].map(([key, label]) => `<label><input type="checkbox" data-tool="${key}" ${workspace.tools[key] ? 'checked' : ''} ${editable ? '' : 'disabled'}>${label}工具</label>`).join('')}</div>`;
    const actions = editable ? `<div class="block-actions"><label class="inline-toggle"><input type="checkbox" data-enabled="${e(block.id)}" ${block.enabled ? 'checked' : ''} ${block.required ? 'disabled' : ''}>${block.required ? '必选' : '带入'}</label>${ibtn('up', `上移${block.title}`, 'up', `data-id="${e(block.id)}" ${index === 0 ? 'disabled' : ''}`)}${ibtn('down', `下移${block.title}`, 'down', `data-id="${e(block.id)}" ${index === workspace.blocks.length - 1 ? 'disabled' : ''}`)}${ibtn('remove', `移除${block.title}`, 'trash', `data-id="${e(block.id)}" ${block.required ? 'disabled' : ''}`)}</div>` : !block.enabled ? badge('未带入') : '';
    return card(block.id, e(block.title), badge(isMaterial ? '会话材料' : '公共规则'), isMaterial ? '属于当前会话的材料，切换角色不会改写这些内容。' : '独立于角色模板；更换角色仍遵守此规则。', body, actions, block.enabled ? '' : 'excluded');
  }).join('');
  const tools = result.request?.tools ?? [];
  const toolCard = card('functions', '工具定义', badge(`${tools.length} functions`), '能力与参数不随角色切换。完整定义随请求一起展示。', `<div class="function-list">${tools.map(({ function: fn }) => `<div><code>${e(fn.name)}</code><p>${e(fn.description)}</p><small>${Object.entries(fn.parameters.properties).map(([name, spec]) => `${e(name)}: ${e(spec.type)} — ${e(spec.description)}`).join('<br>') || '无参数'}</small></div>`).join('') || '<p class="empty-text">当前没有启用的工具。</p>'}</div>`);
  $('#document').innerHTML = `<div class="cards-document"><div class="model-line"><label for="model-input">模型</label>${editable ? `<input id="model-input" value="${e(workspace.model)}" maxlength="80" spellcheck="false">` : `<span class="mono">${e(workspace.model)}</span>`}<span class="model-note">Chat Completions</span></div>${flow}${roleCard}${adaptation}${play}<div class="section-divider"><h3>公共规则与会话材料</h3><span>随请求组合 · 不属于人设</span></div>${publicCards}${card('input', '本次输入', badge('user'), '来自右侧单次试聊，与上方上下文共同组成请求。', `<pre id="input-preview" class="prompt-text">${e(workspace.input)}</pre>`)}${toolCard}${editable ? btn('library', '添加上下文积木', 'plus') : ''}</div>`;
  document.querySelectorAll('.prompt-input').forEach(autoHeight);
}
function autoHeight(element) { element.style.height = 'auto'; element.style.height = element.scrollHeight + 3 + 'px'; }
function updateMeta() {
  const result = current(); const displayed = visible();
  $('#save-state').textContent = editing ? '编辑中 · 尚未保存' : canStore ? '草稿保存在此浏览器' : '当前内容仅保留在页面中';
  $('#draft-state').textContent = source === 'run' ? '运行时快照 · 只读' : editing ? '未保存的草稿' : '只读';
  $('#context-title').textContent = source === 'run' ? '运行时的完整请求' : format === 'json' ? '完整请求 JSON' : '完整上下文';
  $('#context-caption').textContent = format === 'json' ? 'POST /v1/chat/completions · 包含全部 messages 与 tools' : '角色、规则与会话材料连续展开';
  const request = displayed.request;
  $('#request-metrics').textContent = request ? `${request.messages.length} messages · ${request.tools?.length ?? 0} tools · ${new TextEncoder().encode(JSON.stringify(request, null, 2)).length.toLocaleString()} bytes` : '草稿待修正';
  const notice = $('#document-notice');
  notice.hidden = !result.error && source !== 'run' && !(editing && format === 'json');
  notice.innerHTML = result.error ? `<span class="error">${e(result.error)}</span>` : source === 'run' ? `正在查看运行 #${run.number} 时的完整请求，后续编辑不会改变它。 ${btn('current', '返回当前草稿')}` : '正在预览未保存的完整请求；修改提示词请切回顶部「模块正文」。';
  $('#run-button').disabled = !!result.error;
  document.querySelectorAll('[data-action="copy"],[data-action="download"]').forEach((button) => { button.disabled = !request; });
  if ($('#save-button')) $('#save-button').disabled = !!result.error;
  const warning = $('#storage-warning'); warning.hidden = !storageWarning; warning.textContent = storageWarning;
}
function renderRun() {
  $('#output-status').textContent = run ? `#${String(run.number).padStart(3, '0')} · 预设输出` : '等待运行';
  $('#run-output').innerHTML = run ? `<div class="cli-status"><span class="status-dot"></span>本次组装完成 · 未发送网络请求</div><pre>${e(run.response)}</pre>` : `<div class="idle-output"><span>${icon('terminal')}</span><p>等你输入一句话</p><small>每次运行替换这里的结果</small></div>`;
  $('#snapshot-content').innerHTML = run ? `<p>本页保留最近一次运行时的完整请求，刷新后清除。</p><dl><div><dt>运行</dt><dd>#${run.number}</dd></div><div><dt>模型</dt><dd>${e(run.request.model)}</dd></div><div><dt>角色</dt><dd>${e(run.role.name)}</dd></div><div><dt>状态</dt><dd>${run.revision !== revision ? '草稿已变化' : '与当前组装一致'}</dd></div></dl>${btn('snapshot', '查看运行时完整请求', 'code')}` : '<p>运行后可查看当时的完整请求。仅供比较，不影响试聊。</p>';
}
function changed() {
  revision++;
  if (!editing) persist();
  if (format === 'json') renderDocument();
  if ($('#input-preview') && source === 'draft') $('#input-preview').textContent = w().input;
  updateMeta(); renderRun();
}
function showDialog(title, description, body) {
  lastFocus = document.activeElement;
  $('#dialog').innerHTML = `<header class="dialog-header"><div><h2 id="dialog-title">${title}</h2><p>${description}</p></div>${ibtn('close', '关闭', 'close')}</header><div class="dialog-body">${body}</div>`;
  $('#dialog').showModal();
}
function showScope() {
  showDialog('人设影响哪些提示词？', '角色决定身份与表达；业务规则继续独立生效。', `<table class="scope-table"><thead><tr><th>使用位置</th><th>角色带来的变化</th><th>保持独立</th></tr></thead><tbody>${[
    ['身份与自称', '名字、背景、自称', '发言者识别、真实权限'], ['群聊 / 私聊', '性格、语气、回应示例', '场景节奏、事实与消息格式'], ['戳一戳', '符合角色的反应', '响应条件、长度限制'], ['表情与工具后回复', '表达偏好与说明口吻', '工具定义、权限与执行结果'], ['后台记忆提炼', '读取角色，整理会话性格补充', '提炼规则与用户事实'], ['临时扮演', '本场景身份与剧情', '角色模板与事实记忆'],
  ].map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table><p class="dialog-note">此 demo 演示普通聊天请求的组装。戳一戳与后台提炼展示的是设计范围，尚未接入实际执行。</p>`);
}
function showLibrary() {
  const available = templates.filter((t) => t.category !== '人设' && t.key !== 'roleplay' && !w().blocks.some((b) => b.key === t.key));
  showDialog('添加上下文积木', '人设在角色模板中选择，临时剧情在扮演卡片中管理。', `<div class="library-list">${available.map((item) => `<article><div><h3>${e(item.title)}</h3><p>${e(item.summary)}</p></div>${btn('add', item.category === '回应方式' && w().blocks.some((b) => b.category === item.category) ? '替换' : '加入', 'plus', `data-key="${item.key}"`)}</article>`).join('') || '<p class="empty-text">当前积木已全部加入。</p>'}</div>`);
}
async function action(name, target) {
  if (name === 'nav') return toast('当前 demo 只展开 Prompt 工作台，其他页面保留导航位置。');
  if (name === 'close') return $('#dialog').close();
  if (name === 'scope') return showScope();
  if (name === 'edit') { backup = structuredClone(state); editing = true; source = 'draft'; render(); return; }
  if (name === 'save') {
    if (current().error) return toast(current().error);
    if (persist()) { editing = false; backup = null; render(); toast('已保存 V4 本地草稿'); }
    else { updateMeta(); toast('本地保存不可用，编辑内容仍在页面中'); }
    return;
  }
  if (name === 'cancel') {
    for (const saved of backup.workspaces) { const active = state.workspaces.find((x) => x.id === saved.id); saved.input = active.input; saved.scenario = active.scenario; }
    state = backup; editing = false; backup = null; revision++; persist(); render(); return;
  }
  if (name === 'show-request' || name === 'snapshot' || name === 'current' || name === 'return-text') {
    source = name === 'snapshot' && run ? 'run' : 'draft';
    if (name !== 'current') format = name === 'return-text' ? 'text' : 'json';
    render(); $('#document').scrollTop = 0; $('#document').focus({ preventScroll: true }); return;
  }
  if (name === 'exit-roleplay') { w().roleplay.enabled = false; changed(); render(); toast('已退出临时扮演，模板与事实记忆保持原样'); return; }
  if (name === 'copy' || name === 'download') {
    const request = visible().request; if (!request) return;
    const raw = JSON.stringify(request, null, 2);
    if (name === 'copy') {
      try { await navigator.clipboard.writeText(raw); toast('已复制完整请求 JSON'); }
      catch { showDialog('复制完整请求', '全选下面的内容后复制。', `<textarea class="copy-fallback" readonly aria-label="完整请求 JSON">${e(raw)}</textarea>`); $('.copy-fallback').select(); }
    } else {
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'fish-v4-request.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return;
  }
  if (!editing) return;
  if (name === 'library') return showLibrary();
  if (name === 'add') {
    if (w().blocks.length >= 30) return toast('当前工作区最多 30 个公共积木');
    const template = templates.find((x) => x.key === target.dataset.key);
    if (!template || w().blocks.some((b) => b.key === template.key)) return;
    const block = baseBlock(template.key); if (block.key === 'history') block.content = initialHistory();
    const replaceAt = block.category === '回应方式' ? w().blocks.findIndex((b) => b.category === block.category) : -1;
    if (replaceAt >= 0) w().blocks.splice(replaceAt, 1, block); else w().blocks.push(block);
    $('#dialog').close(); changed(); render(); return;
  }
  if (['up', 'down', 'remove'].includes(name)) {
    const index = w().blocks.findIndex((b) => b.id === target.dataset.id);
    if (index < 0 || (name === 'remove' && w().blocks[index].required)) return;
    const next = index + (name === 'up' ? -1 : 1);
    if (name !== 'remove' && (next < 0 || next >= w().blocks.length)) return;
    const [block] = w().blocks.splice(index, 1); if (name !== 'remove') w().blocks.splice(next, 0, block);
    changed(); render();
  }
}
function execute() {
  const result = current();
  if (result.error || !w().input.trim()) { $('#run-error').hidden = false; $('#run-error').textContent = result.error || '请输入本次试聊内容。'; return; }
  // shortcut: the response is a fixture; replace with the sandbox runner after the layout is accepted.
  run = { number: ++runNumber, revision, request: result.request, workspace: structuredClone(w()), role: structuredClone(role()), response: cases.find((x) => x.input === w().input)?.reply ?? '本次自定义输入已完成组装。尚未连接模型，没有生成真实回复。' };
  $('#run-error').hidden = true; renderRun(); if (source === 'run') { renderDocument(); updateMeta(); }
}
document.addEventListener('click', (event) => {
  const target = event.target.closest('button'); if (!target || target.disabled) return;
  if (target.dataset.action) { action(target.dataset.action, target); return; }
  if (target.dataset.format) { format = target.dataset.format; render(); $('#document').scrollTop = 0; }
});
document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.id === 'run-input') { w().input = target.value; w().scenario = 'custom'; $('#scenario-select').value = 'custom'; $('#run-error').hidden = true; changed(); return; }
  if (!editing) return;
  if (target.dataset.field === 'role') role().content = target.value;
  else if (target.dataset.field === 'adaptation') w().adaptations[w().roleId] = target.value;
  else if (target.dataset.field === 'roleplay') w().roleplay.content = target.value;
  else if (target.dataset.block) w().blocks.find((b) => b.id === target.dataset.block).content = target.value;
  else if (target.id === 'model-input') w().model = target.value;
  else return;
  if (target.matches('.prompt-input')) autoHeight(target);
  changed();
});
document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.id === 'workspace-select' && !editing) { state.active = target.value; run = null; source = 'draft'; persist(); render(); $('#document').scrollTop = 0; return; }
  if (target.id === 'scenario-select') {
    w().scenario = target.value; const sample = cases.find((x) => x.id === target.value);
    if (sample) { w().input = sample.input; $('#run-input').value = sample.input; }
    changed(); return;
  }
  if (!editing) return;
  if (target.id === 'role-select') w().roleId = target.value;
  else if (target.id === 'roleplay-enabled') w().roleplay.enabled = target.checked;
  else if (target.dataset.enabled) { const block = w().blocks.find((b) => b.id === target.dataset.enabled); if (!block.required) block.enabled = target.checked; }
  else if (target.dataset.tool) w().tools[target.dataset.tool] = target.checked;
  else return;
  changed(); render();
});
document.addEventListener('submit', (event) => { if (event.target.id === 'run-form') { event.preventDefault(); execute(); } });
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !$('#dialog').open) { event.preventDefault(); execute(); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (editing) action('save'); else toast('当前没有未保存的编辑'); }
});
$('#dialog').addEventListener('close', () => { if (lastFocus?.isConnected) lastFocus.focus(); });
window.addEventListener('beforeunload', (event) => { if (editing) { event.preventDefault(); event.returnValue = ''; } });
render();
