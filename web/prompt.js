// Prompt workbench: persisted drafts, frozen scenarios, actual request traces.
const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const json = (v) => JSON.stringify(v, null, 2);
export function configDiff(before, after, prefix = '') {
  return Object.entries(after).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object' ? configDiff(before?.[key] ?? {}, value, path)
      : value !== before?.[key] ? [{ path, before: before?.[key], after: value }] : [];
  });
}
function pendingPublishTests(workspace, config) {
  const tests = workspace.tests.filter((t) => t.revision === workspace.draft.revision && t.review?.passed && t.status === 'completed' && !t.override && t.target === 'draft');
  const changes = configDiff(workspace.published.config, config);
  const distill = changes.some((d) => d.path === 'prompts.distill');
  const chat = !distill || changes.some((d) => d.path !== 'prompts.distill');
  const seed = changes.some((d) => d.path === 'prompts.seed');
  const missing = [];
  if (seed && !tests.some((t) => t.kind === 'chat' && t.usesSeed)) missing.push('全新会话聊天测试');
  else if (chat && !tests.some((t) => t.kind === 'chat')) missing.push('聊天测试');
  if (distill && !tests.some((t) => t.kind === 'distill')) missing.push('记忆提炼测试');
  return missing;
}
export function publishReadiness(workspace, config, dirty = false) {
  return !dirty && pendingPublishTests(workspace, config).length === 0;
}
const sections = [
  ['seed', '角色模板 · 初始人设', '仅用于新建或重置会话；已有会话的人设继续独立演化。'],
  ['identity', '身份与消息格式', '所有会话共用的身份约定，以及如何理解群聊中的发言者。'],
  ['group', '群聊行为', '群聊回复的长度、节奏与表达方式。'],
  ['private', '私聊行为', '一对一对话的回复方式。'],
  ['scene', '当前场景', '运行时填入时间、会话类型和静默时长。'],
  ['toolRules', '工具使用规则', '决定何时执行、怎样解释成功与失败；权限由后端检查。'],
  ['distill', '记忆提炼', '指导人设演化与事实提炼。{maxBytes} 会替换为存储大小上限。'],
  ['context', '历史与记忆', '控制附带哪些历史消息，以及记忆是否自动注入。'],
  ['tools', '工具', '工具开关、描述与参数说明。'],
  ['json', '配置 JSON', '高级编辑：与左侧表单共用同一份草稿。'],
];
const boolLabels = { users: '用户消息', assistant: '机器人回复', text: '文本消息', image: '图片相关消息（文字占位）', excludeCommands: '排除命令消息', onlySpeaker: '仅当前发言者的用户消息', injectMemory: '自动注入会话记忆', vision: '启用本轮图片理解（沿用现有识图规则）' };
const names = { draw: '绘图', remember_fact: '保存记忆', recall_memory: '读取记忆', save_meme: '收藏表情', search_memes: '查找表情', send_meme: '发送表情', send_usage_report: '发送用量报告' };
const parameterNames = { draw: 'prompt', remember_fact: 'content', save_meme: 'description', search_memes: 'query', send_meme: 'id', send_usage_report: 'period' };
const phases = { request: '发送请求', response: '模型返回', tool: '执行工具', error: '调用失败' };
const statuses = { running: '运行中', completed: '已完成，待评审', failed: '失败', interrupted: '已中断' };
const button = (action, label, extra = '') => `<button type="button" class="button small ${action === 'publish' ? 'primary' : ''}" data-pp-action="${action}" ${extra}>${label}</button>`;
const checkbox = (path, label, checked) => `<label class="pp-check"><input type="checkbox" data-pp-field="${path}" ${checked ? 'checked' : ''}>${escape(label)}</label>`;
const textarea = (path, value, rows = 15) => `<textarea spellcheck="false" class="pp-textarea" rows="${rows}" data-pp-field="${path}">\n${escape(value)}</textarea>`;
const STYLE_KEY = 'big-fat-fish.prompt-style';
const styles = {
  workbench: { label: '紧凑', description: '编辑全局规则，使用固定会话快照验证效果。' },
  relaxed: { label: '舒适', description: '增加编辑与阅读间距，功能与配置保持一致。' },
};
function readStyle() {
  try {
    const saved = localStorage.getItem(STYLE_KEY);
    return Object.hasOwn(styles, saved) ? saved : 'workbench';
  } catch { return 'workbench'; }
}

export function createPromptConsole({ api, state: appState, toast }) {
  let appearance = readStyle();
  let s = {};
  let listeners;
  let timer;
  let previewSequence = 0;
  let snapshotSequence = 0;
  let root;
  const $ = (selector) => root?.querySelector(selector);
  const current = () => appState.page === 'prompt' && !!appState.token;
  const setDirty = () => { appState.dirty = true; updateStatus(); };
  const setValue = (path, value) => { const keys = path.split('.'); const last = keys.pop(); let obj = s.config; for (const key of keys) obj = obj[key]; obj[last] = value; };
  function switchStyle(value) {
    if (!Object.hasOwn(styles, value)) return;
    appearance = value;
    // Keep the same DOM: drafts, raw JSON experiments, selection, details and test runs survive.
    $('#prompt-console').dataset.promptStyle = value;
    root.querySelectorAll('[data-pp-style]').forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.ppStyle === value)));
    $('#pp-style-description').textContent = styles[value].description;
    try { localStorage.setItem(STYLE_KEY, value); } catch { /* Restricted storage still allows in-memory switching. */ }
  }
  function editor(section = s.section) {
    const [key, title, hint] = sections.find((v) => v[0] === section);
    let body;
    if (key === 'context') {
      const ctx = s.config.context;
      body = `<div class="pp-fields">${[['historyLimit', '最多附带历史条数', 0, 200], ['maxAgeMinutes', '最近多少分钟（0 为不限）', 0, 525600], ['budgetBytes', 'system + 历史文字预算 / 字节', 512, 1000000]].map(([field, label, min, max]) => `<label>${label}<input type="number" min="${min}" max="${max}" data-pp-field="context.${field}" value="${ctx[field]}"></label>`).join('')}</div><div class="pp-checks">${Object.entries(boolLabels).map(([field, label]) => checkbox(`context.${field}`, label, ctx[field])).join('')}</div><p class="notice info">条数不包含本轮输入。先筛选，再取最近 N 条，最后按字节裁剪。候选范围最多最近 1000 条。字节预算不是 Token 上限。</p><p class="field-hint">历史图片只携带文字占位；语音、戳一戳等接收事件不作为聊天历史处理。当前输入图片仍按现有视觉模型流程处理。</p>`;
    } else if (key === 'tools') {
      body = Object.entries(s.config.tools).map(([name, tool]) => `<article class="pp-tool"><div class="pp-row"><h3>${names[name]} <code>${name}</code></h3>${checkbox(`tools.${name}.enabled`, '开启', tool.enabled)}</div><label>何时调用${textarea(`tools.${name}.description`, tool.description, 4)}</label>${name !== 'recall_memory' ? `<label>参数说明 · <code>${parameterNames[name]}</code>${textarea(`tools.${name}.parameterDescription`, tool.parameterDescription, 2)}</label>` : '<p class="field-hint">无参数；仅可读取当前会话。</p>'}<p class="field-hint" data-pp-tool-status="${name}">正在检查可用状态…</p></article>`).join('') + `<div class="pp-fields">${[['maxToolRounds', '最多工具轮数', 5], ['maxToolCalls', '最多工具执行次数', 8]].map(([field, label, max]) => `<label>${label}<input type="number" min="1" max="${max}" data-pp-field="execution.${field}" value="${s.config.execution[field]}"></label>`).join('')}</div>`;
    } else if (key === 'json') {
      body = `${textarea('configJson', json(s.config), 25)}${button('apply-json', '校验并应用到草稿')}<p class="field-hint">编辑的是长期保存的配置。右侧请求 JSON 的临时实验不会成为发布配置。</p>`;
    } else {
      body = `<label class="sr-only">${title}</label>${key === 'scene' ? `<div class="pp-row">${['time', 'scene', 'silence'].map((v) => button('variable', `{{${v}}}`, `data-variable="${v}"`)).join('')}</div>` : ''}${textarea(`prompts.${key}`, s.config.prompts[key], key === 'seed' || key === 'distill' ? 23 : 17)}`;
    }
    return `<div class="panel-header"><div><p class="eyebrow">GLOBAL DRAFT</p><h2>${title}</h2><p>${hint}</p></div></div><div class="pp-editor-body">${body}</div>`;
  }
  function diffView() {
    const changes = configDiff(s.workspace.published.config, s.config);
    return changes.length ? `<p class="field-hint">${changes.length} 个字段有变化。发布前检查旧值与新值。</p>${changes.map((d) => `<details class="pp-diff"><summary>${escape(d.path)}</summary><div class="pp-diff-columns"><div><small>已发布</small><pre>${escape(d.before)}</pre></div><div><small>草稿</small><pre>${escape(d.after)}</pre></div></div></details>`).join('')}` : '<p class="field-hint">草稿与已发布配置一致。</p>';
  }
  function cards() {
    return sections.filter(([key]) => key !== 'json').map(([key]) => `<article class="panel pp-module" data-module="${key}">${editor(key)}</article>`).join('');
  }
  function syncEditing() {
    $('#prompt-console').dataset.editing = String(!!s.editing);
    root.querySelectorAll('[data-pp-field]').forEach((field) => {
      if (field.tagName === 'TEXTAREA') field.readOnly = !s.editing || appState.saving;
      else field.disabled = !s.editing || appState.saving;
    });
    root.querySelectorAll('[data-pp-action="variable"],[data-pp-action="apply-json"]').forEach((el) => { el.disabled = !s.editing || appState.saving; });
    $('#pp-edit').hidden = !!s.editing;
    $('#pp-save').hidden = $('#pp-cancel').hidden = !s.editing;
    root.querySelectorAll('#pp-editor textarea').forEach((field) => { field.style.height = 'auto'; field.style.height = field.scrollHeight + 3 + 'px'; });
  }
  function switchView(value) {
    if (!['cards', 'json'].includes(value)) return;
    s.view = value; $('#prompt-console').dataset.view = value;
    root.querySelectorAll('[data-pp-view]').forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.ppView === value)));
    if (value === 'cards') syncEditing();
  }
  function shell() {
    return `<div id="prompt-console" class="pp-v4" data-prompt-style="${appearance}" data-view="${s.view ?? 'cards'}" data-editing="${!!s.editing}">
      <section class="pp-page-controls"><div><span class="badge neutral">全局草稿</span> <strong>已发布 v${s.workspace.published.number}</strong><p id="pp-save-state" class="field-hint"></p></div><div class="pp-row"><div class="pp-style-switch" aria-label="页面显示方式"><button type="button" data-pp-view="cards" aria-pressed="${s.view !== 'json'}">模块正文</button><button type="button" data-pp-view="json" aria-pressed="${s.view === 'json'}">原始 JSON</button></div>${button('edit', '编辑 Edit', 'id="pp-edit"')}${button('cancel-edit', '取消', 'id="pp-cancel" hidden')}${button('save', '保存 Save', 'id="pp-save" hidden')}</div></section>
      <p id="pp-error" class="notice danger" role="alert" hidden></p>
      <div class="pp-scenario-bar"><label>测试会话<select id="pp-session"><option value="new-group">全新群聊 · 初始人设</option><option value="new-private">全新私聊 · 初始人设</option>${s.sessions.map((key) => `<option value="${escape(key)}">${escape(key)}</option>`).join('')}</select></label><label>发言者 QQ<input id="pp-actor" inputmode="numeric" placeholder="最近发言者"></label>${button('snapshot', '载入场景')}<span class="field-hint">切换选择后载入，预览与试聊使用同一份材料。</span></div>
      <div class="pp-v4-grid"><section class="pp-main" id="pp-edit-stage"><div class="pp-main-heading"><div><h2>上下文工作区</h2><p id="pp-preview-state" class="field-hint">载入场景后生成完整请求</p></div>${button('copy-request', '复制 JSON')}</div>
      <div class="pp-cards-view"><div class="pp-scope-map"><div><small>01 · 初始模板</small><strong>全局默认人设</strong><span>新建或重置会话时采用</span></div><div><small>02 · 会话人设</small><strong id="pp-persona-source">等待载入</strong><span>各会话独立演化</span></div><div><small>03 · 临时扮演</small><strong>仅测试沙盒</strong><span>不改写模板与会话记忆</span></div></div>
      <details class="pp-scope-details"><summary>人设影响哪些提示词？</summary><p>身份、自称、群聊 / 私聊表达、戳一戳和工具后的回复会使用人设。工具定义、权限与用户事实保持独立；后台提炼读取人设作为材料。</p><p>当前身份规则与语气示例也可能包含角色描述，更换初始人设时请一并检查。此处编辑的是全局默认模板，尚不提供多角色模板库。</p></details>
      <div id="pp-editor" class="pp-editor" tabindex="-1">${cards()}</div>
      <article class="panel pp-module pp-session-persona"><div class="panel-header"><div><p class="eyebrow">SESSION / READ ONLY</p><h2>当前会话人设</h2><p>来自固定测试快照；编辑初始模板不会覆盖已有会话。</p></div></div><pre id="pp-current-character" class="pp-readable"></pre></article>
      <article class="panel pp-module"><div class="panel-header"><div><p class="eyebrow">SANDBOX ONLY</p><h2>临时扮演与测试材料</h2><p>替换本次测试的人设与记忆，不写入线上会话。取消勾选即恢复快照材料。</p></div></div><div class="pp-editor-body"><label class="pp-check"><input id="pp-persona-edit" type="checkbox">使用临时测试人设 / 记忆</label><label>临时人设（完整替换）<textarea id="pp-character" rows="6" readonly></textarea></label><label>会话记忆 / 临时测试记忆<textarea id="pp-memory" rows="6" readonly></textarea></label></div></article>
      <details class="panel pp-assembled"><summary>完整组装正文与历史筛选明细</summary><p class="field-hint">上方配置同时包含群聊、私聊与提炼规则；实际请求按选中的流程与场景组装。</p><div id="pp-request-blocks"></div></details>
      <details class="panel pp-config-json"><summary>高级 · 配置 JSON</summary>${editor('json')}</details></div>
      <section class="pp-json-view"><p class="field-hint">完整请求体，包含全部 messages 与 tools；以当前选中的测试流程为准。</p><textarea id="pp-request-json" class="mono" rows="28" readonly aria-label="完整请求 JSON"></textarea><details class="pp-advanced"><summary>高级 · 请求 JSON 临时实验</summary><label class="pp-check"><input type="checkbox" id="pp-request-edit">临时编辑请求（不作为发布依据）</label>${button('reset-request', '恢复自动组装')}</details></section></section>
      <section class="panel pp-test" id="pp-test-stage" tabindex="-1"><div class="panel-header"><div><h2>单次试聊</h2><p>真实调用模型并计入用量。测试消息与记忆留在沙盒，不向 QQ 发送。</p></div></div><div class="pp-test-inputs"><label>输入消息<textarea id="pp-input" rows="3">记住，我不吃香菜。</textarea></label><label>预期表现<textarea id="pp-expected" rows="3" placeholder="例如：调用 remember_fact，确认保存；不调用 draw。"></textarea></label></div><div class="pp-row">${button('test', '运行一次', 'id="pp-test"')}<span id="pp-running" role="status"></span></div><button type="button" class="text-button pp-request-link" data-pp-action="show-json">查看完整请求 JSON ↗</button><div id="pp-result"><p class="pp-idle">输入一句话，运行后在这里查看结果。</p></div><details class="pp-advanced"><summary>高级 · 流程、工具与版本对比</summary><div class="pp-fields"><label>测试流程<select id="pp-kind"><option value="chat">聊天与工具调用</option><option value="distill">记忆 / 人设提炼</option></select></label><label>工具模式<select id="pp-mode"><option value="simulate">模拟绘图 · 记忆写入沙盒</option><option value="execute">真实绘图（计费用量）· 记忆写入沙盒</option></select></label></div>${button('compare', '对比发布版与草稿（各调用一次）', 'id="pp-compare"')}<p class="field-hint">每次运行独立，输出不追加到会话历史。</p></details><details class="pp-advanced"><summary>高级 · 固定测试场景与快照</summary><p id="pp-snapshot-info" class="field-hint"></p><p class="field-hint">载入后固定历史、人设与时间，用同一份材料对比版本。</p>${button('snapshot', '重新载入快照')}</details></section>
</div>
      <details class="pp-delivery"><summary>检查、发布与运行记录</summary>
      <section class="panel pp-release" id="pp-release-stage" tabindex="-1"><div class="pp-row"><h2>检查与发布</h2>${button('publish', '发布版本', 'id="pp-publish" disabled')}${button('reload', '重新读取')}</div><p id="pp-publish-reason" class="notice info" role="status"></p><div id="pp-diff">${diffView()}</div><label>发布说明<input id="pp-note" maxlength="1000" placeholder="这次改动改善了什么"></label><p class="field-hint">通用规则与工具配置用于后续请求；初始人设仅用于新建或重置会话。运行中的请求继续使用原版本。</p><details><summary>版本历史 / 回退</summary><div class="pp-row"><select id="pp-version">${[...s.workspace.versions].reverse().map((v) => `<option value="${escape(v.id)}">v${v.number} · ${escape(v.note || '无说明')}</option>`).join('')}</select>${button('restore', '载入为草稿')}</div><p class="field-hint">回退也经过测试和发布，不会直接覆盖线上配置。保留最近 50 个版本。</p></details></section>
      <section class="panel pp-recent" id="pp-runs-stage" tabindex="-1"><div class="panel-header"><div><h2>最近实际请求与测试</h2><p>保留最近 50 次运行；密钥、图片数据及敏感 URL 参数会省略并标记。</p></div>${button('refresh-runs', '刷新记录')}</div><div id="pp-runs"></div></section></details>
      <details class="pp-appearance-bar"><summary>显示密度</summary><p id="pp-style-description">${styles[appearance].description}</p><div class="pp-style-switch" aria-label="编辑区密度">${Object.entries(styles).map(([key, style]) => `<button type="button" data-pp-style="${key}" aria-pressed="${key === appearance}">${style.label}</button>`).join('')}</div></details>
    </div>`;
  }

  function updateStatus() {
    if (!current() || !$('#pp-save-state')) return;
    const dirty = appState.dirty;
    const tests = s.workspace.tests.filter((t) => t.revision === s.workspace.draft.revision && t.review?.passed && t.status === 'completed' && !t.override && t.target === 'draft');
    const canPublish = publishReadiness(s.workspace, s.config, dirty);
    $('#pp-save-state').textContent = dirty ? '有未保存修改 · 旧测试不能代表当前编辑内容' : `草稿已保存 · 当前版本 ${tests.length} 项测试评审通过`;
    $('#pp-save').disabled = appState.saving || !!s.invalidJson;
    $('#pp-publish').disabled = appState.saving || !canPublish;
    const needs = pendingPublishTests(s.workspace, s.config);
    $('#pp-publish-reason').textContent = dirty ? '下一步：保存草稿，再测试当前版本。' : canPublish ? '发布条件已满足。检查下方差异与发布说明后，可发布版本。' : `下一步：运行并评审通过${needs.join('、') || '当前草稿测试'}。`;
    $('#pp-publish').title = $('#pp-publish-reason').textContent;
    $('#pp-test').disabled = $('#pp-compare').disabled = appState.saving || dirty || !s.snapshot;
    $('#pp-diff').innerHTML = diffView();
    syncEditing();
  }
  function displaySnapshot() {
    if (!s.snapshot) return;
    $('#pp-session').value = s.snapshot.sessionKey ?? `new-${s.snapshot.event.message_type}`;
    $('#pp-actor').value = s.snapshot.event.user_id;
    $('#pp-current-character').textContent = s.snapshot.persona.character ?? s.config.prompts.seed;
    $('#pp-persona-source').textContent = s.snapshot.sessionKey ?? '全新会话 · 使用模板';
    $('#pp-character').value = s.snapshot.persona.character ?? s.config.prompts.seed;
    $('#pp-memory').value = s.snapshot.persona.memory;
    $('#pp-persona-edit').checked = false;
    $('#pp-character').readOnly = $('#pp-memory').readOnly = true;
    $('#pp-snapshot-info').textContent = `${s.snapshot.sessionKey ?? '全新会话'} · 快照包含 ${s.snapshot.historyCount} 条候选历史 · 发言者 ${s.snapshot.event.user_id} · ${new Date(s.snapshot.nowMs).toLocaleString()}`;
  }
  function caseBody() {
    return { revision: s.workspace.draft.revision, target: 'draft', snapshotId: s.snapshot?.id, kind: $('#pp-kind').value, input: $('#pp-input').value, expected: $('#pp-expected').value, mode: $('#pp-mode').value,
      ...($('#pp-persona-edit').checked ? { persona: { character: $('#pp-character').value, memory: $('#pp-memory').value } } : {}) };
  }
  function showError(error) {
    if (!current()) return;
    $('#pp-error').hidden = false;
    $('#pp-error').textContent = error.message;
  }
  async function preview() {
    if (!s.snapshot || s.invalidJson || !current()) return;
    const sequence = ++previewSequence;
    const pageSequence = appState.sequence;
    const result = await api('/prompt/preview', { method: 'POST', body: { ...caseBody(), config: s.config } });
    if (sequence !== previewSequence || pageSequence !== appState.sequence || !current()) return;
    s.preview = result;
    $('#pp-preview-state').textContent = `${appState.dirty ? '未保存草稿' : '已保存草稿'} · 仅预览，尚未发送${result.redacted ? ' · 有脱敏 / 省略' : ''}`;
    const summary = result.summary;
    $('#pp-request-blocks').innerHTML = `<div class="pp-budget"><strong>${summary.candidates} → ${summary.filtered ?? summary.candidates} → ${summary.limited ?? summary.sent} → ${summary.sent}</strong><p>候选 → 筛选 → 条数 → 实际附带</p></div>${result.request.messages.map((m, i) => `<details class="pp-message"><summary><span class="badge neutral">${escape(m.role)}</span> ${i === 0 ? '系统提示词' : i === result.request.messages.length - 1 ? '本轮输入' : '历史消息'}${i === 0 ? ' · 人设 / 记忆 / 规则 / 场景' : ''}</summary><pre>${escape(typeof m.content === 'string' ? m.content : json(m.content))}</pre></details>`).join('')}<details class="pp-message"><summary>tools · ${(result.request.tools ?? []).length} 个可用工具</summary>${result.availability.map((t) => `<p><strong>${escape(names[t.name])}</strong> · ${escape(t.available ? '可用' : t.reason)} · ${escape(t.effect)}</p>`).join('')}</details><details class="pp-message"><summary>历史筛选明细</summary>${result.inspections.map((m) => `<div class="pp-history-row"><small>${escape(m.role)} · ${escape(m.reason || '已纳入')}</small><p>${escape(m.content.slice(0, 180))}</p></div>`).join('') || '<p>没有历史记录</p>'}</details>`;
    if (!$('#pp-request-edit').checked) $('#pp-request-json').value = json(result.request);
    for (const tool of result.availability) {
      const node = root.querySelector(`[data-pp-tool-status="${tool.name}"]`);
      if (node) node.textContent = `${tool.available ? '当前测试发言者可用' : tool.reason} · ${tool.effect}`;
    }
  }
  async function loadSnapshot() {
    const sequence = ++snapshotSequence;
    const pageSequence = appState.sequence;
    const selected = $('#pp-session').value;
    const snapshot = await api('/prompt/snapshot', { method: 'POST', body: { sessionKey: selected.startsWith('new-') ? '' : selected, scene: selected === 'new-private' ? 'private' : 'group', ...($('#pp-actor').value.trim() ? { actorId: $('#pp-actor').value.trim() } : {}) } });
    if (!current() || sequence !== snapshotSequence || pageSequence !== appState.sequence) return;
    s.snapshot = snapshot;
    displaySnapshot(); updateStatus(); await preview();
  }
  function renderRuns() {
    $('#pp-runs').innerHTML = s.runs.length ? `<div class="table-wrap"><table><thead><tr><th>来源 / 会话</th><th>版本 / 流程</th><th>状态</th><th></th></tr></thead><tbody>${s.runs.map((r) => `<tr><td>${r.source === 'test' ? '测试' : '线上'} · ${escape(r.sessionKey ?? '全新会话')}<small class="cell-sub">${escape(new Date(r.createdAt).toLocaleString())}</small></td><td>${r.version === null || r.version === undefined ? '草稿' : `v${r.version}`} · ${r.kind === 'distill' ? '提炼' : '聊天'}</td><td>${escape(statuses[r.status] ?? r.status)}</td><td>${button('run-detail', '查看', `data-run-id="${escape(r.id)}"`)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="field-hint">尚无运行记录。</p>';
  }
  function resultView(run, title = '') {
    const evidence = s.workspace.tests.find((t) => t.id === run.id);
    const reviewable = !appState.dirty && run.status === 'completed' && run.target === 'draft' && run.revision === s.workspace.draft.revision && !run.override;
    return `<article class="pp-run" data-run="${escape(run.id)}"><div class="pp-row"><h3>${escape(title || (run.source === 'live' ? '线上运行' : run.target === 'published' ? '已发布版' : '草稿测试'))}</h3><span class="badge ${run.status === 'failed' ? 'danger' : ''}">${escape(statuses[run.status] ?? run.status)}</span>${run.source === 'test' ? `<span>${run.mode === 'execute' ? '真实绘图 / 记忆沙盒' : '模拟绘图 / 记忆沙盒'}</span>` : ''}</div>${run.redacted ? '<p class="field-hint">记录含脱敏、图片省略或长内容截断；展示不是完整原文。</p>' : ''}${run.override ? '<p class="notice info">请求 JSON 临时实验：不能作为发布依据。</p>' : ''}${run.expected ? `<p class="field-hint">预期：${escape(run.expected)}</p>` : ''}${run.error ? `<p class="notice danger">${escape(run.error)}</p>` : ''}<div class="pp-answer">${escape(run.content || '')}</div>${run.imageCount ? button('images', `查看生成图片（${run.imageCount}）`, `data-run-id="${run.id}" data-count="${run.imageCount}"`) + `<div class="pp-images" id="images-${run.id}"></div>` : ''}<div class="pp-trace">${run.trace.map((entry, i) => `<details><summary>${i + 1}. ${phases[entry.phase] || escape(entry.phase)}${entry.name ? ` · ${escape(entry.name)}` : ''}${entry.reused ? ' · 复用结果，未重复执行' : ''}${entry.elapsedMs !== undefined ? ` · ${entry.elapsedMs} ms` : ''}</summary><pre>${escape(json(entry.request ?? entry))}</pre></details>`).join('')}</div>${run.sandboxMemory !== undefined ? `<details><summary>测试后的沙盒记忆</summary><pre>${escape(run.sandboxMemory)}</pre></details>` : ''}${run.patch ? `<details><summary>提炼结果（未写入线上）</summary><pre>${escape(json(run.patch))}</pre></details>` : ''}<p class="field-hint">${evidence?.review ? `评审：${evidence.review.passed ? '通过' : '未通过'} · ${escape(evidence.review.note)}` : '运行成功不等于符合预期，请检查回复和工具行为。'}${run.revision !== s.workspace.draft.revision && run.target === 'draft' ? ' 此测试属于旧草稿。' : ''}</p>${reviewable ? `<label>评审备注<input data-review-note="${run.id}" maxlength="1000" placeholder="工具选择、参数和回复是否符合预期"></label><div class="pp-row">${button('pass', '评审通过', `data-run-id="${run.id}"`)}${button('fail', '标记未通过', `data-run-id="${run.id}"`)}</div>` : ''}</article>`;
  }
  async function runTest(target, base) {
    const response = await api('/prompt/tests', { method: 'POST', body: { ...base, target } });
    let run;
    while (current()) {
      run = await api(`/prompt/runs/${response.id}`);
      if (run.status !== 'running') return run;
      $('#pp-running').textContent = `${target === 'draft' ? '草稿' : '发布版'}测试运行中…`;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return null;
  }
  async function test(compare) {
    if (appState.dirty) throw new Error('请先保存草稿，再运行测试。');
    const body = caseBody();
    if ($('#pp-request-edit').checked) {
      if (compare) throw new Error('临时 JSON 实验不参与版本对比，请恢复自动组装。');
      body.requestOverride = JSON.parse($('#pp-request-json').value);
    }
    s.results = [];
    $('#pp-result').innerHTML = '';
    for (const target of compare ? ['published', 'draft'] : ['draft']) {
      const run = await runTest(target, body);
      if (!run || !current()) return;
      s.results.push(run);
      $('#pp-result').innerHTML = s.results.map((r) => resultView(r)).join('');
    }
    s.workspace = await api('/prompt/workspace');
    $('#pp-result').innerHTML = s.results.map((r) => resultView(r)).join('');
    $('#pp-running').textContent = '测试完成。请检查结果，再评审。';
    s.runs = (await api('/prompt/runs')).items;
    renderRuns();
  }
  async function action(node) {
    const name = node.dataset.ppAction;
    if (appState.saving) return;
    if (name === 'show-json') { switchView('json'); $('#pp-request-json').scrollIntoView({ block: 'start' }); return; }
    if (name === 'edit') { s.editing = true; s.editBackup = structuredClone(s.config); updateStatus(); return; }
    if (name === 'cancel-edit') {
      s.config = s.editBackup; s.editing = false; s.invalidJson = false; appState.dirty = false;
      $('#pp-editor').innerHTML = cards();
      root.querySelector('[data-pp-field="configJson"]').value = json(s.config);
      if (!s.snapshot?.persona.character && !$('#pp-persona-edit').checked) $('#pp-character').value = s.config.prompts.seed;
      if (s.snapshot) $('#pp-current-character').textContent = s.snapshot.persona.character ?? s.config.prompts.seed;
      updateStatus(); await preview(); return;
    }
    if (name === 'save' && !appState.dirty) { s.editing = false; updateStatus(); return; }
    if (name === 'variable') {
      const field = root.querySelector('[data-pp-field="prompts.scene"]');
      field.setRangeText(`{{${node.dataset.variable}}}`, field.selectionStart, field.selectionEnd, 'end');
      s.config.prompts.scene = field.value; setDirty(); await preview(); return;
    }
    if (name === 'copy-request') { await navigator.clipboard.writeText($('#pp-request-json').value); toast('JSON 已复制'); return; }
    if (name === 'reset-request') { $('#pp-request-edit').checked = false; $('#pp-request-json').readOnly = true; await preview(); return; }
    if (name === 'apply-json') {
      const value = JSON.parse(root.querySelector('[data-pp-field="configJson"]').value);
      await api('/prompt/preview', { method: 'POST', body: { ...caseBody(), config: value } });
      s.config = value; s.invalidJson = false; $('#pp-editor').innerHTML = cards(); setDirty(); await preview(); return;
    }
    if (name === 'preview') { await preview(); return; }
    if (name === 'snapshot') { await loadSnapshot(); return; }
    if (name === 'images') {
      const images = [];
      for (let i = 0; i < Number(node.dataset.count); i++) images.push(await api(`/prompt/runs/${node.dataset.runId}/images/${i}`));
      if (!current()) return;
      const container = $(`#images-${node.dataset.runId}`);
      if (container) container.innerHTML = images.map((im) => `<img alt="${escape(im.prompt)}" src="data:image/${im.b64.startsWith('/9j/') ? 'jpeg' : im.b64.startsWith('UklGR') ? 'webp' : 'png'};base64,${escape(im.b64)}">`).join('');
      return;
    }
    appState.saving = true; updateStatus();
    const controls = [...root.querySelectorAll('input,select,textarea,button')].filter((el) => !el.hasAttribute('data-pp-style'));
    const previous = controls.map((el) => el.disabled); controls.forEach((el) => { el.disabled = true; });
    try {
      if (name === 'save') {
        s.workspace = await api('/prompt/draft', { method: 'PUT', body: { revision: s.workspace.draft.revision, config: s.config } });
        appState.dirty = false; s.editing = false;
        $('#pp-result').innerHTML = '';
        $('#pp-running').textContent = '草稿已保存，请运行当前版本的测试。';
        await preview();
        toast('草稿已保存，线上配置尚未改变。');
      } else if (name === 'test' || name === 'compare') await test(name === 'compare');
      else if (name === 'pass' || name === 'fail') {
        s.workspace = await api('/prompt/review', { method: 'POST', body: { id: node.dataset.runId, revision: s.workspace.draft.revision, passed: name === 'pass', note: root.querySelector(`[data-review-note="${node.dataset.runId}"]`).value } });
        $('#pp-result').innerHTML = (s.results ?? []).map((r) => resultView(r)).join('');
        toast(name === 'pass' ? '已标记通过，可以检查差异并发布。' : '已标记未通过。');
      } else if (name === 'publish') {
        s.workspace = await api('/prompt/publish', { method: 'POST', body: { revision: s.workspace.draft.revision, note: $('#pp-note').value } });
        s.config = structuredClone(s.workspace.draft.config); appState.dirty = false;
        toast(`v${s.workspace.published.number} 已发布，新请求将使用该版本。`);
        await reloadView();
      } else if (name === 'restore') {
        if (appState.dirty && !window.confirm('载入历史版本将替换本页尚未保存的编辑。继续？')) return;
        s.workspace = await api('/prompt/restore', { method: 'POST', body: { revision: s.workspace.draft.revision, versionId: $('#pp-version').value } });
        appState.dirty = false; await reloadView(); toast('历史版本已载入草稿，请测试后发布。');
      } else if (name === 'reload') {
        if (appState.dirty && !window.confirm('放弃本页未保存的编辑并重新读取？')) return;
        appState.dirty = false; await reloadView();
      } else if (name === 'refresh-runs') { s.runs = (await api('/prompt/runs')).items; renderRuns(); }
      else if (name === 'run-detail') {
        const run = await api(`/prompt/runs/${node.dataset.runId}`); s.results = [run];
        $('#pp-result').innerHTML = resultView(run);
        $('#pp-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } finally {
      controls.forEach((el, i) => { el.disabled = previous[i]; }); appState.saving = false; updateStatus();
    }
  }
  async function reloadView() {
    s.workspace = await api('/prompt/workspace');
    s.config = structuredClone(s.workspace.draft.config); s.invalidJson = false; s.editing = false;
    const holder = root;
    holder.innerHTML = shell();
    attach(holder);
  }
  function onInput(event) {
    const field = event.target;
    const path = field.dataset.ppField;
    if (path) {
      if (path === 'configJson') s.invalidJson = true;
      else setValue(path, field.type === 'checkbox' ? field.checked : field.type === 'number' ? Number(field.value) : field.value);
      if (field.tagName === 'TEXTAREA' && path !== 'configJson') { field.style.height = 'auto'; field.style.height = field.scrollHeight + 3 + 'px'; }
      if (path !== 'configJson' && !s.invalidJson) root.querySelector('[data-pp-field="configJson"]').value = json(s.config);
      setDirty();
      if (path === 'prompts.seed' && !s.snapshot?.persona.character && !$('#pp-persona-edit').checked) $('#pp-character').value = s.config.prompts.seed;
    }
    if (path === 'prompts.seed' && !s.snapshot?.persona.character) $('#pp-current-character').textContent = s.config.prompts.seed;
    if (field.id === 'pp-persona-edit') $('#pp-character').readOnly = $('#pp-memory').readOnly = !field.checked;
    if (field.id === 'pp-request-edit') { $('#pp-request-json').readOnly = !field.checked; if (!field.checked && s.preview) $('#pp-request-json').value = json(s.preview.request); }
    if (path || ['pp-input', 'pp-kind', 'pp-persona-edit', 'pp-character', 'pp-memory'].includes(field.id)) {
      clearTimeout(timer); timer = setTimeout(() => preview().catch(showError), 450);
    }
  }
  function attach(container) {
    listeners?.abort(); listeners = new AbortController(); root = container;
    root.addEventListener('input', onInput, { signal: listeners.signal });
    root.addEventListener('change', onInput, { signal: listeners.signal });
    root.addEventListener('click', (event) => {
      const viewButton = event.target.closest('[data-pp-view]');
      if (viewButton) { switchView(viewButton.dataset.ppView); return; }
      const jump = event.target.closest('[data-pp-jump]');
      if (jump) {
        const target = $({ edit: '#pp-editor', test: '#pp-test-stage', release: '#pp-release-stage', runs: '#pp-runs-stage' }[jump.dataset.ppJump]);
        target?.scrollIntoView({ block: 'start' });
        target?.focus({ preventScroll: true });
        return;
      }
      const styleButton = event.target.closest('[data-pp-style]');
      if (styleButton) { switchStyle(styleButton.dataset.ppStyle); return; }
      const node = event.target.closest('[data-pp-action]');
      if (node) { $('#pp-error').hidden = true; action(node).catch(showError); }
    }, { signal: listeners.signal });
    renderRuns();
    if (s.snapshot) { displaySnapshot(); preview().catch(showError); }
    else loadSnapshot().catch(showError);
    updateStatus();
  }
  return {
    async render(sequence) {
      previewSequence++; snapshotSequence++;
      const [workspace, sessions, runs] = await Promise.all([api('/prompt/workspace'), api('/prompt/sessions'), api('/prompt/runs')]);
      if (sequence !== appState.sequence || !appState.token) return '';
      s = { workspace, config: structuredClone(workspace.draft.config), sessions: sessions.items, runs: runs.items, section: 'seed', snapshot: null };
      return shell();
    }, attach,
    clear() { listeners?.abort(); clearTimeout(timer); previewSequence++; snapshotSequence++; s = {}; root = null; },
  };
}
