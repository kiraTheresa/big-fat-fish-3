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
export function publishReadiness(workspace, config, dirty = false) {
  if (dirty) return false;
  const tests = workspace.tests.filter((t) => t.revision === workspace.draft.revision && t.review?.passed && t.status === 'completed' && !t.override && t.target === 'draft');
  const changes = configDiff(workspace.published.config, config);
  const distill = changes.some((d) => d.path === 'prompts.distill');
  const chat = !distill || changes.some((d) => d.path !== 'prompts.distill');
  const seed = changes.some((d) => d.path === 'prompts.seed');
  return tests.length > 0 && (!distill || tests.some((t) => t.kind === 'distill')) && (!chat || tests.some((t) => t.kind === 'chat')) && (!seed || tests.some((t) => t.kind === 'chat' && t.usesSeed));
}
const sections = [
  ['seed', '初始人设', '仅用于新建或重置会话；已有会话的人设继续独立演化。'],
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
const names = { draw: '绘图', remember_fact: '保存记忆', recall_memory: '读取记忆' };
const phases = { request: '发送请求', response: '模型返回', tool: '执行工具', error: '调用失败' };
const statuses = { running: '运行中', completed: '已完成，待评审', failed: '失败', interrupted: '已中断' };
const button = (action, label, extra = '') => `<button type="button" class="button small ${action === 'publish' ? 'primary' : ''}" data-pp-action="${action}" ${extra}>${label}</button>`;
const checkbox = (path, label, checked) => `<label class="pp-check"><input type="checkbox" data-pp-field="${path}" ${checked ? 'checked' : ''}>${escape(label)}</label>`;
const textarea = (path, value, rows = 15) => `<textarea spellcheck="false" class="pp-textarea" rows="${rows}" data-pp-field="${path}">\n${escape(value)}</textarea>`;

export function createPromptConsole({ api, state: appState, toast }) {
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
  function editor() {
    const [key, title, hint] = sections.find((v) => v[0] === s.section);
    let body;
    if (key === 'context') {
      const ctx = s.config.context;
      body = `<div class="pp-fields">${[['historyLimit', '最多附带历史条数', 0, 200], ['maxAgeMinutes', '最近多少分钟（0 为不限）', 0, 525600], ['budgetBytes', 'system + 历史文字预算 / 字节', 512, 1000000]].map(([field, label, min, max]) => `<label>${label}<input type="number" min="${min}" max="${max}" data-pp-field="context.${field}" value="${ctx[field]}"></label>`).join('')}</div><div class="pp-checks">${Object.entries(boolLabels).map(([field, label]) => checkbox(`context.${field}`, label, ctx[field])).join('')}</div><p class="notice info">条数不包含本轮输入。先筛选，再取最近 N 条，最后按字节裁剪。候选范围最多最近 1000 条。字节预算不是 Token 上限。</p><p class="field-hint">历史图片只携带文字占位；语音、戳一戳等接收事件不作为聊天历史处理。当前输入图片仍按现有视觉模型流程处理。</p>`;
    } else if (key === 'tools') {
      body = Object.entries(s.config.tools).map(([name, tool]) => `<article class="pp-tool"><div class="pp-row"><h3>${names[name]} <code>${name}</code></h3>${checkbox(`tools.${name}.enabled`, '开启', tool.enabled)}</div><label>何时调用${textarea(`tools.${name}.description`, tool.description, 4)}</label>${name !== 'recall_memory' ? `<label>参数说明 · <code>${name === 'draw' ? 'prompt' : 'content'}</code>${textarea(`tools.${name}.parameterDescription`, tool.parameterDescription, 2)}</label>` : '<p class="field-hint">无参数；仅可读取当前会话。</p>'}<p class="field-hint" data-pp-tool-status="${name}">正在检查可用状态…</p></article>`).join('') + `<div class="pp-fields">${[['maxToolRounds', '最多工具轮数', 5], ['maxToolCalls', '最多工具执行次数', 8]].map(([field, label, max]) => `<label>${label}<input type="number" min="1" max="${max}" data-pp-field="execution.${field}" value="${s.config.execution[field]}"></label>`).join('')}</div>`;
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
  function shell() {
    return `<div id="prompt-console">
      <section class="panel pp-versionbar"><div><span class="badge">全局配置</span> <strong>已发布 v${s.workspace.published.number}</strong><p id="pp-save-state" class="field-hint"></p></div><div class="pp-row">${button('save', '保存草稿', 'id="pp-save"')}${button('reload', '重新读取')}${button('publish', '发布版本', 'id="pp-publish" disabled')}</div></section>
      <div class="pp-flow" aria-label="发布流程"><span>① 编辑草稿</span><span>→</span><span>② 运行测试</span><span>→</span><span>③ 评审通过</span><span>→</span><span>④ 发布版本</span></div>
      <p id="pp-error" class="notice danger" role="alert" hidden></p>
      <section class="panel pp-scenario"><div class="pp-row"><h2>测试场景</h2><span class="field-hint">快照固定后，可用同一份素材比较两个版本。</span></div><div class="pp-fields"><label>会话<select id="pp-session"><option value="new-group">全新群聊 · 使用初始人设</option><option value="new-private">全新私聊 · 使用初始人设</option>${s.sessions.map((key) => `<option value="${escape(key)}">${escape(key)}</option>`).join('')}</select></label><label>测试发言者 QQ（可留空）<input id="pp-actor" inputmode="numeric" placeholder="默认使用最近发言者"></label>${button('snapshot', '载入快照')}</div><p id="pp-snapshot-info" class="field-hint"></p>
        <details><summary>查看人设与记忆 / 临时修改测试素材</summary><label class="pp-check"><input id="pp-persona-edit" type="checkbox">仅在本次测试中使用修改后的素材</label><div class="pp-diff-columns"><label>当前人设<textarea id="pp-character" rows="6" readonly></textarea></label><label>当前记忆<textarea id="pp-memory" rows="6" readonly></textarea></label></div></details></section>
      <div class="pp-workbench"><nav class="panel pp-sections" aria-label="Prompt 编辑内容">${sections.map(([key, label]) => `<button type="button" data-pp-section="${key}" aria-pressed="${key === s.section}">${label}</button>`).join('')}</nav><section class="panel pp-editor" id="pp-editor">${editor()}</section><section class="panel pp-preview"><div class="panel-header"><div><p class="eyebrow">REQUEST PREVIEW</p><h2>最终请求</h2><p id="pp-preview-state">载入场景后生成</p></div>${button('preview', '刷新')}</div><div id="pp-request-blocks"></div><details class="pp-json"><summary>请求 JSON · 可临时编辑后测试</summary><label class="pp-check"><input type="checkbox" id="pp-request-edit">临时实验（不作为发布依据）</label><textarea id="pp-request-json" class="mono" rows="18" readonly aria-label="最终请求 JSON"></textarea>${button('reset-request', '恢复自动组装')}${button('copy-request', '复制 JSON')}</details></section></div>
      <section class="panel pp-test"><div class="panel-header"><div><p class="eyebrow">TEST BENCH</p><h2>修改后，试着聊一轮</h2><p>真实调用模型并计入用量。测试消息与记忆留在沙盒，不向 QQ 发送。</p></div></div><div class="pp-fields"><label>测试流程<select id="pp-kind"><option value="chat">聊天与工具调用</option><option value="distill">记忆 / 人设提炼</option></select></label><label>工具模式<select id="pp-mode"><option value="simulate">模拟绘图 · 记忆写入沙盒</option><option value="execute">真实绘图（计费用量）· 记忆写入沙盒</option></select></label></div><div class="pp-diff-columns"><label>输入消息<textarea id="pp-input" rows="3">记住，我不吃香菜。</textarea></label><label>预期表现<textarea id="pp-expected" rows="3" placeholder="例如：调用 remember_fact，确认保存；不调用 draw。"></textarea></label></div><div class="pp-row">${button('test', '测试当前草稿', 'id="pp-test"')}${button('compare', '对比发布版与草稿（各调用一次）', 'id="pp-compare"')}<span id="pp-running" role="status"></span></div><div id="pp-result"></div></section>
      <section class="panel pp-release"><h2>发布前检查</h2><div id="pp-diff">${diffView()}</div><label>发布说明<input id="pp-note" maxlength="1000" placeholder="这次改动改善了什么"></label><p class="field-hint">通用规则与工具配置用于后续请求；初始人设仅用于新建或重置会话。运行中的请求继续使用原版本。</p><details><summary>版本历史 / 回退</summary><div class="pp-row"><select id="pp-version">${[...s.workspace.versions].reverse().map((v) => `<option value="${escape(v.id)}">v${v.number} · ${escape(v.note || '无说明')}</option>`).join('')}</select>${button('restore', '载入为草稿')}</div><p class="field-hint">回退也经过测试和发布，不会直接覆盖线上配置。保留最近 50 个版本。</p></details></section>
      <section class="panel pp-recent"><div class="panel-header"><div><h2>最近实际请求与测试</h2><p>保留最近 50 次运行；密钥、图片数据及敏感 URL 参数会省略并标记。</p></div>${button('refresh-runs', '刷新记录')}</div><div id="pp-runs"></div></section>
    </div>`;
  }
  function updateStatus() {
    if (!current() || !$('#pp-save-state')) return;
    const dirty = appState.dirty;
    const tests = s.workspace.tests.filter((t) => t.revision === s.workspace.draft.revision && t.review?.passed && t.status === 'completed' && !t.override && t.target === 'draft');
    const canPublish = publishReadiness(s.workspace, s.config, dirty);
    $('#pp-save-state').textContent = dirty ? '有未保存修改 · 旧测试不能代表当前编辑内容' : `草稿已保存 · 当前版本 ${tests.length} 项测试评审通过`;
    $('#pp-save').disabled = appState.saving || !dirty || !!s.invalidJson;
    $('#pp-publish').disabled = appState.saving || !canPublish;
    $('#pp-test').disabled = $('#pp-compare').disabled = appState.saving || dirty || !s.snapshot;
    $('#pp-diff').innerHTML = diffView();
  }
  function displaySnapshot() {
    if (!s.snapshot) return;
    $('#pp-session').value = s.snapshot.sessionKey ?? `new-${s.snapshot.event.message_type}`;
    $('#pp-actor').value = s.snapshot.event.user_id;
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
      s.config = value; s.invalidJson = false; setDirty(); await preview(); return;
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
    const controls = [...root.querySelectorAll('input,select,textarea,button')];
    const previous = controls.map((el) => el.disabled); controls.forEach((el) => { el.disabled = true; });
    try {
      if (name === 'save') {
        s.workspace = await api('/prompt/draft', { method: 'PUT', body: { revision: s.workspace.draft.revision, config: s.config } });
        appState.dirty = false;
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
    s.config = structuredClone(s.workspace.draft.config); s.invalidJson = false;
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
      setDirty();
      if (path === 'prompts.seed' && !s.snapshot?.persona.character && !$('#pp-persona-edit').checked) $('#pp-character').value = s.config.prompts.seed;
    }
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
      const tab = event.target.closest('[data-pp-section]');
      if (tab && !appState.saving) {
        if (s.invalidJson) { showError(new Error('请先校验并应用配置 JSON，或重新读取以放弃修改。')); return; }
        s.section = tab.dataset.ppSection;
        $('#pp-editor').innerHTML = editor();
        root.querySelectorAll('[data-pp-section]').forEach((el) => el.setAttribute('aria-pressed', String(el === tab)));
        preview().catch(showError);
      }
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
