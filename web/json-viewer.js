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

function nodeView(id, kind, label, content = '', open = false) {
  return `<div class="${kind}" data-json-path="${escape(id)}">
    <button type="button" class="json-node-row json-select" aria-pressed="false"${content ? ` aria-expanded="${open}"` : ''}>
      <span class="json-toggle" aria-hidden="true"></span><span class="json-row">${label}</span>
    </button>
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
    if (!entries.length) return nodeView(id, 'json-leaf', `${label}<span class="json-shape">${brackets}</span>`);
    const open = saved ?? (path.length === 0 || (path.length === 1 && entries.length <= 4));
    const preview = !array && path.length > 0 && entries.find(([, item]) =>
      item === null || ['boolean', 'number'].includes(typeof item) || (typeof item === 'string' && item.length <= 28));
    return nodeView(id, `json-branch json-depth-${path.length % 3}`,
      `${label}<span class="json-shape">${brackets}</span><span class="json-count">${entries.length} 项</span>${preview ? `<span class="json-preview">${field(preview[0])}${scalar(preview[1])}</span>` : ''}`,
      `<div class="json-children"${open ? '' : ' hidden'}>${entries.map(([key, item]) => node(item, [...path, array ? Number(key) : key], expanded)).join('')}</div>`, open);
  }
  if (typeof value === 'string' && (value.length > 96 || value.includes('\n'))) {
    return nodeView(id, 'json-text',
      `${label}${scalar(value.split('\n', 1)[0].slice(0, 72))}<span class="json-count">${value.length} 字符</span>`,
      `<pre class="json-text-body"${saved ? '' : ' hidden'}>${escape(value)}</pre>`, saved ?? false);
  }
  return nodeView(id, 'json-leaf', `${label}${scalar(value)}`);
}

const selectedRow = (container) => container.querySelector('.json-select[aria-pressed="true"]');

function selectRow(container, row) {
  selectedRow(container)?.setAttribute('aria-pressed', 'false');
  row?.setAttribute('aria-pressed', 'true');
  container.querySelector('.json-scope-label').textContent = row
    ? `当前节点 · ${pathLabel(row.parentElement.dataset.jsonPath)}` : '整个 JSON';
  container.querySelector('.json-clear-selection').hidden = !row;
  const target = row?.parentElement ?? container.querySelector('[data-json-path]');
  for (const button of container.querySelectorAll('[data-json-open]')) {
    button.disabled = !target?.firstElementChild.hasAttribute('aria-expanded');
  }
}

function setExpanded(element, open) {
  if (!element.firstElementChild.hasAttribute('aria-expanded')) return;
  element.firstElementChild.setAttribute('aria-expanded', String(open));
  element.lastElementChild.hidden = !open;
}

// Render parsed JSON while retaining the scope, disclosures, and keyboard focus.
export function updateJsonViewer(container, value) {
  if (!container.querySelector('.json-tree')) {
    container.innerHTML = `<div class="json-toolbar">
      <span class="json-scope"><strong class="json-scope-label" aria-live="polite"></strong></span>
      <button type="button" class="text-button json-clear-selection" hidden>取消选择</button>
      <button type="button" class="button small" data-json-open="true">全部展开</button>
      <button type="button" class="button small" data-json-open="false">全部收起</button>
    </div><div class="json-tree"></div>`;
    container.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      const selection = container.ownerDocument.getSelection();
      if (event.detail && (!button || button.matches('.json-select')) && selection && !selection.isCollapsed && container.contains(selection.anchorNode)) return;
      if (!button) {
        if (event.target.matches('.json-viewer, .json-tree, .json-children, .json-toolbar')) selectRow(container, null);
        return;
      }
      if (button.matches('.json-select')) {
        selectRow(container, button);
        setExpanded(button.parentElement, button.getAttribute('aria-expanded') !== 'true');
        return;
      }
      if (button.matches('.json-clear-selection')) {
        selectRow(container, null);
        container.querySelector('[data-json-open]:not(:disabled), .json-select').focus({ preventScroll: true });
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
    container.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      selectRow(container, null);
      if (event.target.matches('.json-clear-selection')) container.querySelector('.json-select').focus({ preventScroll: true });
      event.stopPropagation();
    });
  }
  const disclosures = () => Array.from(container.querySelectorAll('[data-json-path]'));
  const selected = selectedRow(container)?.closest('[data-json-path]').dataset.jsonPath;
  const active = container.ownerDocument.activeElement;
  const focused = container.contains(active) ? active.closest('[data-json-path]')?.dataset.jsonPath : undefined;
  const expanded = new Map(disclosures().filter((element) => element.firstElementChild.hasAttribute('aria-expanded'))
    .map((element) => [element.dataset.jsonPath, element.firstElementChild.getAttribute('aria-expanded') === 'true']));
  container.querySelector('.json-tree').innerHTML = node(value, [], expanded);
  const nodes = disclosures();
  selectRow(container, nodes.find((element) => element.dataset.jsonPath === selected)?.firstElementChild);
  if (focused !== undefined) {
    const target = nodes.find((element) => element.dataset.jsonPath === focused) ?? nodes[0];
    target.firstElementChild.focus({ preventScroll: true });
  }
}
