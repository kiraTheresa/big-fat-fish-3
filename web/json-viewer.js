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
  if (id === '[]') return '整个 JSON';
  return '$' + JSON.parse(id).map((key) => {
    if (typeof key === 'string' && /^[A-Za-z_$][\w$]*$/.test(key)) return `.${key}`;
    return `[${JSON.stringify(key)}]`;
  }).join('');
}

function disclosure(id, kind, label, content, open) {
  return `<div class="${kind}" data-json-path="${escape(id)}">
    <div class="json-node-row">
      <button type="button" class="json-toggle" aria-expanded="${open}" aria-label="${escape(pathLabel(id))} 的内容"></button>
      <button type="button" class="json-row json-select" aria-pressed="false">${label}</button>
    </div>
    ${content}
  </div>`;
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
    return disclosure(id, `json-branch json-depth-${path.length % 3}`,
      `${label}<span class="json-shape">${brackets}</span><span class="json-count">${entries.length} 项</span>${preview ? `<span class="json-preview">${field(preview[0])}${scalar(preview[1])}</span>` : ''}`,
      `<div class="json-children"${open ? '' : ' hidden'}>${entries.map(([key, item]) => node(item, [...path, array ? Number(key) : key], expanded)).join('')}</div>`, open);
  }
  if (typeof value === 'string' && (value.length > 96 || value.includes('\n'))) {
    return disclosure(id, 'json-text',
      `${label}${scalar(value.split('\n', 1)[0].slice(0, 72))}<span class="json-count">${value.length} 字符</span>`,
      `<pre class="json-text-body"${saved ? '' : ' hidden'}>${escape(value)}</pre>`, saved ?? false);
  }
  return `<div class="json-row">${label}${scalar(value)}</div>`;
}

const selectedRow = (container) => container.querySelector('.json-select[aria-pressed="true"]');

function selectRow(container, row) {
  selectedRow(container)?.setAttribute('aria-pressed', 'false');
  row?.setAttribute('aria-pressed', 'true');
  container.querySelector('.json-scope-label').textContent = pathLabel(row?.closest('[data-json-path]').dataset.jsonPath ?? '[]');
  container.querySelector('.json-clear-selection').hidden = !row;
}

function setExpanded(element, open) {
  element.firstElementChild.querySelector('.json-toggle').setAttribute('aria-expanded', String(open));
  element.lastElementChild.hidden = !open;
}

// Render parsed JSON while retaining the scope, disclosures, and keyboard focus.
export function updateJsonViewer(container, value) {
  if (!container.querySelector('.json-tree')) {
    container.innerHTML = `<div class="json-toolbar">
      <span class="json-scope">范围 <strong class="json-scope-label" aria-live="polite"></strong></span>
      <button type="button" class="text-button json-clear-selection" hidden>取消选择</button>
      <button type="button" class="button small" data-json-open="true">全部展开</button>
      <button type="button" class="button small" data-json-open="false">全部收起</button>
    </div><div class="json-tree"></div>`;
    container.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.matches('.json-select')) {
        selectRow(container, button === selectedRow(container) ? null : button);
        return;
      }
      if (button.matches('.json-toggle')) {
        const target = button.closest('[data-json-path]');
        setExpanded(target, target.lastElementChild.hidden);
        return;
      }
      if (button.matches('.json-clear-selection')) {
        selectRow(container, null);
        container.querySelector('[data-json-open]').focus({ preventScroll: true });
        return;
      }
      if (!button.matches('[data-json-open]')) return;
      const target = selectedRow(container)?.closest('[data-json-path]') ?? container.querySelector('[data-json-path]');
      if (!target) return;
      const open = button.dataset.jsonOpen === 'true';
      for (const element of [target, ...target.querySelectorAll('[data-json-path]')]) setExpanded(element, open);
      for (let parent = target.parentElement.closest('[data-json-path]'); open && parent && container.contains(parent); parent = parent.parentElement.closest('[data-json-path]')) {
        setExpanded(parent, true);
      }
    });
  }
  const disclosures = () => Array.from(container.querySelectorAll('[data-json-path]'));
  const selected = selectedRow(container)?.closest('[data-json-path]').dataset.jsonPath;
  const active = container.ownerDocument.activeElement;
  const focused = container.contains(active) ? active.closest('[data-json-path]')?.dataset.jsonPath : undefined;
  const expanded = new Map(disclosures().map((element) => [element.dataset.jsonPath, !element.lastElementChild.hidden]));
  container.querySelector('.json-tree').innerHTML = node(value, [], expanded);
  const nodes = disclosures();
  selectRow(container, nodes.find((element) => element.dataset.jsonPath === selected)?.firstElementChild.querySelector('.json-select'));
  container.querySelector('.json-toolbar').hidden = nodes.length === 0;
  if (focused !== undefined) {
    const control = active.matches('.json-toggle') ? '.json-toggle' : '.json-select';
    nodes.find((element) => element.dataset.jsonPath === focused)?.firstElementChild.querySelector(control).focus({ preventScroll: true });
  }
}
