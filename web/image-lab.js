import { updateJsonViewer } from './json-viewer.js';
import { buildImageLabRequest, imageLabEndpoint, imageLabModels, referenceTypes } from './image-lab-request.js';

function parameterField(field) {
  const { name, label, options, value = '', min, max, check, required, suggestions, placeholder = '' } = field;
  if (check) return `<label class="image-lab-check"><input name="${name}" type="checkbox" value="1">${label}</label>`;
  if (options) return `<label>${label}<select name="${name}">${required ? '' : '<option value="">服务默认</option>'}${options.map((option) => `<option${value === option ? ' selected' : ''}>${option}</option>`).join('')}</select></label>`;
  if (min !== undefined) return `<label>${label}<input name="${name}" type="number" min="${min}" max="${max}" step="1" value="${value}"></label>`;
  return `<label>${label}<input name="${name}" list="image-lab-${name}" value="${value}" maxlength="12" placeholder="${placeholder}"><datalist id="image-lab-${name}">${suggestions.map((item) => `<option value="${item}"></option>`).join('')}</datalist></label>`;
}

const taskStatus = { queued: '排队中', running: '生成中', completed: '已完成', failed: '失败', interrupted: '已中断' };
const active = (task) => ['queued', 'running'].includes(task.status);
const date = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export function createImageLab({ api, fetchMediaFile, toast }) {
  const element = document.createElement('section');
  element.className = 'image-lab';
  element.innerHTML = `
    <div class="image-lab-toolbar">
      <div><strong>老张 API</strong><p class="field-hint">每次运行会调用老张 API 并计入用量。</p></div>
      <div class="pp-style-switch" role="group" aria-label="请求显示方式">
        <button type="button" aria-pressed="true" data-lab-view="text">正文</button>
        <button type="button" aria-pressed="false" data-lab-view="json">请求 JSON</button>
      </div>
    </div>
    <div class="image-lab-grid">
      <section class="panel">
        <header class="panel-header"><div><h2>请求工作区</h2><p data-lab-endpoint class="mono"></p></div></header>
        <form id="image-lab-form" class="image-lab-fields" novalidate>
          <label>模型<select name="model">${Object.entries(imageLabModels).map(([id, profile]) => `<option value="${id}">${profile.label}</option>`).join('')}</select></label>
          <label>任务<select name="operation"><option value="generations">文生图</option><option value="edits">参考图编辑</option></select></label>
          <label data-lab-references hidden>参考图<input name="reference" type="file" accept="${referenceTypes.join(',')}" multiple disabled><span class="field-hint"></span></label>
          <label>提示词<textarea name="prompt" rows="7" maxlength="4000" required placeholder="例如：一只蓝色玻璃鱼，放在白色桌面上，午后侧光，产品摄影。"></textarea></label>
          <div class="image-lab-options" data-lab-parameters></div>
        </form>
        <div data-lab-json hidden>
          <div class="image-lab-json-head"><p class="field-hint" data-lab-format></p><button type="button" class="button small" data-lab-copy>复制 JSON</button></div>
          <div class="json-viewer" data-lab-tree></div>
        </div>
        <p class="form-error" role="alert" data-lab-error hidden></p>
        <button class="button primary" type="submit" form="image-lab-form" data-lab-run>生成图片</button>
      </section>
      <section class="panel image-lab-result">
        <header class="panel-header"><h2>任务记录</h2><a href="#images">绘图作品</a></header>
        <div class="image-lab-tasks" data-lab-tasks aria-label="绘图任务"></div>
        <button class="button small" type="button" data-lab-more hidden>加载更早的任务</button>
        <p class="field-hint" data-lab-history-error role="status" hidden></p>
        <div class="image-lab-selected" data-lab-selected hidden>
          <div class="image-lab-json-head"><h3>任务详情</h3><button class="button small" type="button" data-lab-reuse>沿用参数</button></div>
          <p class="image-lab-status" role="status"></p>
          <p class="field-hint" data-lab-task-error hidden></p>
          <div data-lab-results></div>
          <p data-lab-text class="image-lab-output-text" hidden></p>
          <details data-lab-sent hidden><summary>请求与用量</summary><div class="json-viewer" data-lab-sent-tree></div></details>
        </div>
      </section>
    </div>`;
  const $ = (selector) => element.querySelector(selector);
  const form = $('form');
  const status = $('.image-lab-status');
  const error = $('[data-lab-error]');
  const run = $('[data-lab-run]');
  let settings;
  const resultUrls = [];
  let renderedModel;
  let submitting = false;
  let selectedId;
  let selectedTask;
  let selectionVersion = 0;
  let pollTimer;
  let refreshVersion = 0;
  let tasks = [];
  let nextCursor;
  let disposed = false;

  function clearResult() {
    for (const url of resultUrls.splice(0)) URL.revokeObjectURL(url);
    $('[data-lab-results]').replaceChildren();
    $('[data-lab-text]').textContent = '';
    $('[data-lab-text]').hidden = true;
    $('[data-lab-sent]').hidden = true;
    $('[data-lab-sent]').open = false;
    updateJsonViewer($('[data-lab-sent-tree]'), {});
  }

  function preview(payload) {
    const { request, references, protocol } = buildImageLabRequest(payload);
    if (protocol === 'gemini' || !references.length) return request;
    const files = references.map(({ name, type, size }) => ({ name, type, bytes: size }));
    return { ...request, ...(files.length === 1 ? { image: files[0] } : { 'image[]': files }) };
  }

  function showError(message = '') {
    error.hidden = !message;
    error.textContent = message;
  }

  function update() {
    const { model, operation, reference } = form.elements;
    const profile = imageLabModels[model.value];
    const edit = operation.value === 'edits';
    if (renderedModel !== model.value) {
      renderedModel = model.value;
      $('[data-lab-parameters]').innerHTML = profile.fields.map(parameterField).join('');
    }
    for (const field of profile.fields) {
      const input = form.elements[field.name];
      input.disabled = Boolean((edit && field.generationOnly) || (field.jpegOnly && form.elements.mimeType.value !== 'image/jpeg'));
      input.closest('label').hidden = input.disabled;
    }
    const gemini = profile.protocol === 'gemini';
    $('[data-lab-references]').hidden = !edit;
    $('[data-lab-references] .field-hint').textContent = `PNG、JPEG 或 WebP，最多 ${profile.maxReferences} 张，合计不超过 ${gemini ? 14 : 20} MiB。`;
    reference.disabled = !edit;
    $('[data-lab-endpoint]').textContent = `POST ${imageLabEndpoint(model.value, operation.value)}`;
    $('[data-lab-format]').textContent = gemini
      ? (edit ? 'application/json · 附件内容以文件信息代替 Base64。' : 'application/json · 请求正文')
      : edit ? 'multipart/form-data 字段预览。参考图以文件上传。' : 'application/json · 请求正文';
    const output = form.elements.responseModalities;
    if (output) {
      const searchEnabled = form.elements.webSearch.checked || form.elements.imageSearch.checked;
      if (searchEnabled) output.value = 'TEXT + IMAGE';
      output.options[0].disabled = searchEnabled;
    }
    run.disabled = submitting || !settings.available;
    if ($('[data-lab-json]').hidden) return;
    try {
      updateJsonViewer($('[data-lab-tree]'), preview(new FormData(form)));
      $('[data-lab-copy]').disabled = false;
      showError();
    } catch (err) {
      updateJsonViewer($('[data-lab-tree]'), {});
      $('[data-lab-copy]').disabled = true;
      showError(err.message);
    }
  }

  function setView(view) {
    form.hidden = view === 'json';
    $('[data-lab-json]').hidden = view !== 'json';
    for (const button of element.querySelectorAll('[data-lab-view]')) {
      button.setAttribute('aria-pressed', String(button.dataset.labView === view));
    }
    showError();
    update();
  }

  form.addEventListener('input', () => { showError(); update(); });
  function renderTasks() {
    const container = $('[data-lab-tasks]');
    const focusedId = container.contains(document.activeElement) ? document.activeElement.dataset.taskId : null;
    const previous = new Map([...container.querySelectorAll('button')].map((button) => [button.dataset.taskId, button]));
    const buttons = tasks.map((task) => {
      const button = previous.get(task.id) ?? document.createElement('button');
      if (!previous.has(task.id)) {
        button.type = 'button';
        button.dataset.taskId = task.id;
        const heading = document.createElement('strong');
        const info = document.createElement('span');
        button.append(heading, info);
      }
      button.setAttribute('aria-pressed', String(task.id === selectedId));
      button.children[0].textContent = task.prompt;
      button.children[1].textContent = `${taskStatus[task.status]} · ${imageLabModels[task.model]?.label ?? task.model} · ${date.format(task.createdAt)}`;
      return button;
    });
    if (!buttons.length) {
      const empty = document.createElement('p');
      empty.className = 'field-hint';
      empty.textContent = '提交提示词后，绘图任务会出现在这里。';
      buttons.push(empty);
    }
    container.replaceChildren(...buttons);
    if (focusedId) previous.get(focusedId)?.focus({ preventScroll: true });
    $('[data-lab-more]').hidden = !nextCursor;
  }

  function historyError(message = '') {
    const target = $('[data-lab-history-error]');
    target.textContent = message;
    target.hidden = !message;
  }

  async function refresh({ older = false } = {}) {
    if (disposed) return;
    clearTimeout(pollTimer);
    const version = ++refreshVersion;
    try {
      const before = older && nextCursor ? `?before=${encodeURIComponent(nextCursor)}` : '';
      const page = await api('/image-lab/tasks' + before);
      if (disposed || version !== refreshVersion) return;
      if (older) {
        tasks.push(...page.items);
      } else {
        const latest = new Set(page.items.map((task) => task.id));
        const last = page.items.at(-1)?.id;
        tasks = [...page.items, ...tasks.filter((task) => last && task.id < last && !latest.has(task.id))];
      }
      if (older || tasks.length === page.items.length) nextCursor = page.nextCursor;
      selectedId ??= tasks[0]?.id;
      renderTasks();
      historyError();
      const selection = tasks.find((task) => task.id === selectedId);
      if (selectedId && (selectedTask?.id !== selectedId || active(selectedTask) || selection?.status !== selectedTask.status)) {
        await selectTask(selectedId);
      }
    } catch (err) {
      if (!disposed && version === refreshVersion) historyError(`任务记录读取失败 · ${err.message}`);
    } finally {
      if (!disposed && version === refreshVersion && element.isConnected
        && (tasks.some(active) || selectedTask && active(selectedTask))) {
        pollTimer = setTimeout(refresh, 1800);
      }
    }
  }

  async function selectTask(id) {
    if (id !== selectedId || !selectedTask) {
      selectedId = id;
      selectedTask = null;
      $('[data-lab-selected]').hidden = true;
      renderTasks();
    }
    const version = ++selectionVersion;
    try {
      const task = await api(`/image-lab/tasks/${encodeURIComponent(id)}`);
      if (disposed || version !== selectionVersion) return;
      if (selectedTask?.status === task.status && selectedTask?.images.length === task.images.length) return;
      selectedTask = task;
      clearResult();
      $('[data-lab-selected]').hidden = false;
      status.textContent = [taskStatus[task.status], task.elapsedMs != null && `${(task.elapsedMs / 1000).toFixed(1)} 秒`,
        task.images.length > 0 && `${task.images.length} 张已收入绘图作品`].filter(Boolean).join(' · ');
      $('[data-lab-task-error]').textContent = task.error ?? '';
      $('[data-lab-task-error]').hidden = !task.error;
      $('[data-lab-text]').textContent = task.text ?? '';
      $('[data-lab-text]').hidden = !task.text;
      const { endpoint, request, references, httpStatus, elapsedMs, usage } = task;
      updateJsonViewer($('[data-lab-sent-tree]'), { endpoint, request, references, httpStatus, elapsedMs, usage });
      $('[data-lab-sent]').hidden = false;
      for (const [index, image] of task.images.entries()) showImage(image, index);
    } catch (err) {
      if (!disposed && version === selectionVersion) historyError(err.message);
    }
  }

  function reuseTask() {
    const { parameters, references } = selectedTask;
    form.reset();
    form.elements.model.value = parameters.model;
    form.elements.operation.value = parameters.operation;
    form.elements.prompt.value = parameters.prompt;
    update();
    for (const { name } of imageLabModels[parameters.model].fields) {
      const field = form.elements[name];
      if (field.type === 'checkbox') field.checked = parameters[name] === '1';
      else field.value = parameters[name] ?? '';
    }
    setView('text');
    form.elements.prompt.focus();
    if (references.length) showError('已载入提示词和参数，请重新选择参考图。');
  }

  element.addEventListener('click', async (event) => {
    const view = event.target.closest('[data-lab-view]')?.dataset.labView;
    if (view) setView(view);
    const id = event.target.closest('[data-task-id]')?.dataset.taskId;
    if (id) await selectTask(id);
    if (event.target.closest('[data-lab-more]')) await refresh({ older: true });
    if (event.target.closest('[data-lab-reuse]') && selectedTask) reuseTask();
    if (!event.target.closest('[data-lab-copy]')) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(preview(new FormData(form)), null, 2));
      toast('已复制请求 JSON');
    } catch (err) { showError(err.message); }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting || !settings.available) return;
    const body = new FormData(form);
    try { preview(body); }
    catch (err) { showError(err.message); return; }
    showError();
    submitting = true;
    run.disabled = true;
    run.textContent = '正在提交…';
    try {
      const { id } = await api('/image-lab', { method: 'POST', body });
      if (disposed) return;
      selectedId = id;
      selectionVersion++;
      selectedTask = null;
      $('[data-lab-selected]').hidden = true;
      await refresh();
    } catch (err) {
      if (!disposed) showError(err.message);
    } finally {
      submitting = false;
      run.textContent = '生成图片';
      run.disabled = !settings.available;
    }
  });

  async function showImage(image, index) {
    const item = document.createElement('div');
    item.className = 'image-lab-output';
    const controls = document.createElement('div');
    controls.className = 'image-lab-json-head';
    const label = document.createElement('span');
    label.className = 'field-hint';
    label.textContent = `正在读取第 ${index + 1} 张作品…`;
    controls.append(label);
    item.append(controls);
    $('[data-lab-results]').append(item);
    try {
      const blob = await fetchMediaFile(image.key);
      if (disposed || !element.contains(item)) return;
      const url = URL.createObjectURL(blob);
      resultUrls.push(url);
      const preview = document.createElement('img');
      preview.alt = `第 ${index + 1} 张生成图片`;
      preview.addEventListener('load', () => { label.textContent = `${preview.naturalWidth} × ${preview.naturalHeight}`; });
      preview.addEventListener('error', () => { preview.hidden = true; label.textContent = '无法预览，请下载原图查看'; });
      preview.src = url;
      item.prepend(preview);
      const download = document.createElement('a');
      download.className = 'button small';
      download.textContent = '下载原图';
      download.href = url;
      download.download = image.filename;
      controls.append(download);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'button small';
      edit.textContent = '用作参考图';
      edit.addEventListener('click', () => {
        reuseTask();
        form.elements.operation.value = 'edits';
        const files = new DataTransfer();
        files.items.add(new File([blob], image.filename, { type: image.mimeType }));
        form.elements.reference.files = files.files;
        form.elements.prompt.value = '';
        showError();
        update();
      });
      controls.append(edit);
    } catch (err) {
      label.textContent = err.message;
    }
  }

  return {
    element,
    setSettings(value) {
      settings = value;
      if (!renderedModel && imageLabModels[value.model]) form.elements.model.value = value.model;
      update();
      if (!value.available) showError(value.reason);
    },
    refresh,
    clear() {
      disposed = true;
      clearTimeout(pollTimer);
      clearResult();
      form.reset();
    },
  };
}
