const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function scalar(value) {
  const type = value === null ? 'null' : typeof value;
  return `<span class="json-value json-${type}">${escape(JSON.stringify(value))}</span>`;
}

function field(key) {
  if (key === undefined) return '';
  const label = typeof key === 'number' ? `[${key}]` : JSON.stringify(key);
  return `<span class="json-key">${escape(label)}</span><span aria-hidden="true">:</span>`;
}

function pathLabel(id) {
  return '$' + JSON.parse(id).map((key) => {
    if (typeof key === 'string' && /^[A-Za-z_$][\w$]*$/.test(key)) return `.${key}`;
    return `[${JSON.stringify(key)}]`;
  }).join('');
}

function node(value, path, expanded) {
  const label = field(path.at(-1));
  const id = JSON.stringify(path);
  const saved = expanded.get(id);
  if (value !== null && typeof value === 'object') {
    const array = Array.isArray(value);
    const entries = Object.entries(value);
    const brackets = array ? '[ ]' : '{ }';
    if (!entries.length) return `<div class="json-row">${label}<span class="json-shape">${brackets}</span></div>`;
    const open = saved ?? (path.length === 0 || (path.length === 1 && entries.length <= 4));
    const preview = !array && path.length > 0 && entries.find(([, item]) =>
      item === null || ['boolean', 'number'].includes(typeof item) || (typeof item === 'string' && item.length <= 28));
    return `<details class="json-branch json-depth-${path.length % 3}" data-json-path="${escape(id)}"${open ? ' open' : ''}>
      <summary><span class="json-row">${label}<span class="json-shape">${brackets}</span><span class="json-count">${entries.length} 项</span>${preview ? `<span class="json-preview">${field(preview[0])}${scalar(preview[1])}</span>` : ''}</span></summary>
      <div class="json-children">${entries.map(([key, item]) => node(item, [...path, array ? Number(key) : key], expanded)).join('')}</div>
    </details>`;
  }
  if (typeof value === 'string' && (value.length > 96 || value.includes('\n'))) {
    return `<details class="json-text" data-json-path="${escape(id)}"${saved ? ' open' : ''}>
      <summary><span class="json-row">${label}${scalar(value.split('\n', 1)[0].slice(0, 72))}<span class="json-count">${value.length} 字符</span></span></summary>
      <pre class="json-text-body"><span>${escape(value)}</span></pre>
    </details>`;
  }
  return `<div class="json-row">${label}${scalar(value)}</div>`;
}

// Render parsed JSON while retaining the scope, disclosures, and keyboard focus.
export function updateJsonViewer(container, value) {
  if (!container.querySelector('.json-tree')) {
    container.innerHTML = `<div class="json-toolbar">
      <label>操作范围 <select class="json-scope"></select></label>
      <button type="button" class="button small" data-json-open="true">全部展开</button>
      <button type="button" class="button small" data-json-open="false">全部收起</button>
    </div><div class="json-tree"></div>`;
    const scope = container.querySelector('.json-scope');
    container.querySelector('.json-toolbar').addEventListener('click', (event) => {
      const button = event.target.closest('[data-json-open]');
      if (!button) return;
      const target = Array.from(container.querySelectorAll('[data-json-path]'))
        .find((element) => element.dataset.jsonPath === scope.value);
      if (!target) return;
      const open = button.dataset.jsonOpen === 'true';
      for (const element of [target, ...target.querySelectorAll('[data-json-path]')]) element.open = open;
      if (open) {
        for (let parent = target.parentElement.closest('details'); parent && container.contains(parent); parent = parent.parentElement.closest('details')) {
          parent.open = true;
        }
      }
    });
  }
  const disclosures = () => Array.from(container.querySelectorAll('[data-json-path]'));
  const scope = container.querySelector('.json-scope');
  const selected = scope.value;
  const active = container.ownerDocument?.activeElement;
  const focused = active && container.contains(active) ? active.parentElement?.dataset.jsonPath : undefined;
  const expanded = new Map(disclosures().map((element) => [element.dataset.jsonPath, element.open]));
  container.querySelector('.json-tree').innerHTML = node(value, [], expanded);
  const paths = disclosures().map((element) => element.dataset.jsonPath);
  scope.innerHTML = '<option value="[]">整个 JSON</option>' + paths.filter((id) => id !== '[]')
    .map((id) => `<option value="${escape(id)}">${escape(pathLabel(id))}</option>`).join('');
  scope.value = paths.includes(selected) ? selected : '[]';
  for (const control of container.querySelector('.json-toolbar').querySelectorAll('select, button')) {
    control.disabled = paths.length === 0;
  }
  if (focused !== undefined) {
    disclosures().find((element) => element.dataset.jsonPath === focused)?.firstElementChild.focus({ preventScroll: true });
  }
}
