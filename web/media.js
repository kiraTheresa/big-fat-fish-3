// Read-only media gallery. Authenticated files are kept as revocable page-local blobs.
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const count = (value) => Number(value ?? 0).toLocaleString('zh-CN');
const date = (value) => {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed);
};
const size = (value) => !value ? '无本地原图' : value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const typeNames = { image: '图片表情', mface: 'QQ 商城表情', face: 'QQ 内置表情' };
const statusNames = { available: '可用', disabled: '已停用', incomplete: '信息不完整', uncollected: '未加入收藏' };
const scope = (value) => value?.startsWith('g-') ? `群 ${value.slice(2)}` : value?.startsWith('p-') ? `私聊 ${value.slice(2)}` : value || '未记录会话';
const picture = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 16-5-5L5 21"/></svg>';
const native = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14a8 8 0 1 0-6 6l6-6Z"/><path d="M14 20v-4a2 2 0 0 1 2-2h4M8 10h.01M14 10h.01M8 14c1.5 1.5 3.5 1.5 5 0"/></svg>';
const options = (items, selected) => items.map(([value, label]) => `<option value="${escape(value)}"${value === selected ? ' selected' : ''}>${escape(label)}</option>`).join('');
const titleOf = (item) => item.name || item.prompt || (item.kind === 'generated' ? '未命名作品' : '未命名表情');
const badge = (item) => item.kind === 'generated' ? '<span class="media-badge">绘图作品</span>'
  : `<span class="media-badge media-status-${escape(item.status)}">${escape(statusNames[item.status] || '待检查')}</span>`;

export function createMediaGallery({ api, fetchFile, toast, kind = 'generated' }) {
  if (!['generated', 'memes'].includes(kind)) throw new Error('Unsupported media gallery kind');
  const isGenerated = kind === 'generated';
  const initial = () => ({ kind, q: '', sessionKey: '', status: '', offset: 0, limit: 24 });
  let filters = initial();
  let result = { items: [], total: 0, nextOffset: null, counts: {}, sessions: [], warnings: 0 };
  let root;
  let generation = 0;
  let listeners;
  let observer;
  let queue = [];
  let active = 0;
  let modalSequence = 0;
  let selected;
  let opener;
  const urls = new Set();
  const cache = new Map();
  const $ = (selector) => root?.querySelector(selector);
  const current = (ticket) => ticket === generation && root?.isConnected;
  function rememberUrl(blob) { const url = URL.createObjectURL(blob); urls.add(url); return url; }
  function cleanup() {
    observer?.disconnect(); observer = null;
    listeners?.abort(); listeners = null;
    queue = [];
    modalSequence++;
    const dialog = $('#media-dialog');
    if (dialog?.open) dialog.close();
    selected = null;
    root?.querySelectorAll('[data-media-thumb]').forEach((element) => {
      element.querySelectorAll('img').forEach((image) => image.remove());
      if (!element.querySelector('.media-preview-message')) {
        const message = document.createElement('span');
        message.className = 'media-preview-message';
        message.innerHTML = `${picture}<span>等待预览</span>`;
        element.prepend(message);
      }
    });
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear(); cache.clear();
  }
  function detach() { generation++; cleanup(); root = null; }
  function clear() { detach(); filters = initial(); result = { items: [], total: 0, nextOffset: null, counts: {}, sessions: [], warnings: 0 }; }
  function placeholder(item, detail = false) {
    const isNative = ['mface', 'face'].includes(item.memeType);
    return `<span class="media-placeholder${detail ? ' media-placeholder-large' : ''}">${isNative ? native : picture}<strong>${isNative ? 'QQ 原生表情' : '暂无图片预览'}</strong><span>${isNative ? '暂无本地预览' : item.originalAvailable ? '当前格式不支持预览' : '尚未保存本地原图'}</span></span>`;
  }
  function card(item, index) {
    const type = item.kind === 'generated' ? item.model || '生成图片' : typeNames[item.memeType] || '表情素材';
    return `<button type="button" class="media-card" data-media-open="${index}" aria-label="查看${escape(titleOf(item))}">
      <span class="media-card-image" ${item.previewVariant ? `data-media-thumb="${index}"` : ''}>
        ${item.previewVariant ? `<span class="media-preview-message">${picture}<span>等待预览</span></span>` : placeholder(item)}
        ${item.mimeType === 'image/gif' ? '<span class="media-format">GIF 动图</span>' : ''}
      </span>
      <span class="media-card-body"><span class="media-card-top">${badge(item)}<span class="media-card-date">${escape(date(item.createdAt))}</span></span>
      <strong class="media-card-name">${escape(titleOf(item))}</strong><span class="media-card-sub">${escape(type)}</span>
      <span class="media-card-scope">${escape(scope(item.sessions?.[0] || item.sessionKey))}${item.sessions?.length > 1 ? ` 等 ${item.sessions.length} 个会话` : ''}</span></span>
    </button>`;
  }
  function markup() {
    const filtered = !!(filters.q || filters.sessionKey || filters.status);
    const items = result.items || [];
    return `<section id="media-gallery" class="media-gallery" aria-label="${isGenerated ? '绘图作品' : '表情收藏'}">
      <div class="media-heading"><div><h2>${isGenerated ? '已保存的作品' : '共享表情收藏'}</h2><p>${isGenerated ? '生成的新图片会自动保存，可在此查看和下载原图。' : '群聊和私聊共用；来源筛选仅查看收藏来源，不限制使用范围。'}</p></div><div class="media-counts"><span>${isGenerated ? '作品' : '表情'} <strong>${count(result.counts[kind])}</strong></span></div></div>
      <form id="media-filters" class="media-filters"><label class="media-search" for="media-query">搜索${isGenerated ? '作品' : '表情'}<input id="media-query" name="q" type="search" maxlength="300" value="${escape(filters.q)}" placeholder="${isGenerated ? '提示词、作品名称' : '名称、标签、表情含义'}"></label>
      <label for="media-session">来源会话<select id="media-session" name="sessionKey">${options([['', '全部会话'], ...(result.sessions || []).map((session) => [session, scope(session)])], filters.sessionKey)}</select></label>
      ${!isGenerated ? `<label for="media-status">收藏状态<select id="media-status" name="status">${options([['', '全部状态'], ['available', '可用'], ['disabled', '已停用'], ['incomplete', '信息不完整'], ['uncollected', '未加入收藏']], filters.status)}</select></label>` : ''}
      <div class="media-filter-actions"><button type="submit" class="button primary">查找</button><button type="button" class="button" data-media-reset ${filtered ? '' : 'disabled'}>重置</button></div></form>
      <p id="media-feedback" class="media-feedback" role="alert" hidden></p>
      ${result.warnings ? `<p class="media-notice">有 ${count(result.warnings)} 条素材记录暂时无法读取，其余素材仍可浏览。</p>` : ''}
      <div class="media-results-heading"><p role="status">${filtered ? '筛选结果' : isGenerated ? '最近的创作' : '收藏的表情'} <strong>${count(result.total)}</strong></p><span>按保存时间 · 新到旧</span></div>
      ${items.length ? `<div class="media-grid">${items.map(card).join('')}</div>` : `<div class="media-empty">${isGenerated ? picture : native}<h3>${filtered ? `没有找到匹配的${isGenerated ? '作品' : '表情'}` : isGenerated ? '还没有保存的绘图作品' : '这里还没有表情收藏'}</h3><p>${filtered ? '试试更短的关键词，或重置筛选条件。' : isGenerated ? '肥鱼生成的新图片会自动保存在这里。' : '在 QQ 中引用一个表情，对肥鱼说“收下这个”，或使用 /meme save 名称。'}</p>${filtered ? '<button class="button" type="button" data-media-reset>重置筛选</button>' : ''}</div>`}
      <div class="media-pagination"><span>${result.total ? `${count(filters.offset + 1)}–${count(filters.offset + items.length)} / ${count(result.total)}` : `0 ${isGenerated ? '张作品' : '个表情'}`}</span><div><button type="button" class="button" data-media-page="previous" ${filters.offset === 0 ? 'disabled' : ''}>上一页</button><button type="button" class="button" data-media-page="next" ${result.nextOffset == null ? 'disabled' : ''}>下一页</button></div></div>
      <dialog id="media-dialog" class="media-dialog" aria-labelledby="media-dialog-title"><div class="media-dialog-heading"><div><p class="eyebrow">素材详情</p><h2 id="media-dialog-title">预览</h2></div><button type="button" class="media-close" data-media-close aria-label="关闭素材详情">×</button></div><div id="media-dialog-body"></div></dialog>
    </section>`;
  }
  async function render() {
    const ticket = ++generation;
    cleanup();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== '') params.set(key, value);
    const next = await api(`/media?${params}`);
    if (ticket !== generation) return '';
    result = next;
    return markup();
  }
  async function reload(focusSelector) {
    const host = root;
    if (!host) return;
    host.setAttribute('aria-busy', 'true');
    const expected = generation + 1;
    const controls = [...host.querySelectorAll('form button, .media-pagination button')]
      .map((button) => [button, button.disabled]);
    controls.forEach(([button]) => { button.disabled = true; });
    const feedback = $('#media-feedback'); if (feedback) feedback.hidden = true;
    try {
      const html = await render();
      if (generation !== expected || !host.isConnected) return;
      host.innerHTML = html;
      attach(host);
      if (focusSelector) $(focusSelector)?.focus();
    } catch (error) {
      if (generation !== expected || !host.isConnected) return;
      attach(host);
      const feedback = $('#media-feedback');
      if (feedback) { feedback.textContent = `读取失败：${error.message} 请重新查找或刷新页面。`; feedback.hidden = false; }
    } finally {
      if (generation === expected && host.isConnected) {
        host.setAttribute('aria-busy', 'false');
        controls.forEach(([button, disabled]) => { if (button.isConnected) button.disabled = disabled; });
      }
    }
  }
  function cacheKey(item, variant) { return `${item.key}:${variant}`; }
  async function imageUrl(item, variant, ticket) {
    const key = cacheKey(item, variant);
    if (cache.has(key)) return cache.get(key);
    const blob = await fetchFile(item.key, variant);
    if (!current(ticket)) return null;
    const url = rememberUrl(blob);
    cache.set(key, url);
    return url;
  }
  function pump() {
    while (active < 4 && queue.length) {
      const { element, index, ticket } = queue.shift();
      if (!current(ticket) || !element.isConnected) continue;
      const item = result.items[index];
      if (!item?.previewVariant) continue;
      active++;
      imageUrl(item, item.previewVariant, ticket).then((url) => {
        if (!url || !current(ticket) || !element.isConnected) return;
        const message = element.querySelector('.media-preview-message');
        const image = document.createElement('img');
        image.alt = '';
        image.decoding = 'async';
        image.src = url;
        image.addEventListener('load', () => message?.remove(), { once: true });
        image.addEventListener('error', () => { image.remove(); if (message) message.innerHTML = `${picture}<span>预览不可用 · 点击查看详情</span>`; }, { once: true });
        element.prepend(image);
      }).catch(() => {
        if (!current(ticket) || !element.isConnected) return;
        const message = element.querySelector('.media-preview-message');
        if (message) message.innerHTML = `${picture}<span>预览加载失败 · 点击重试</span>`;
      }).finally(() => { active--; pump(); });
    }
  }
  function keyValue(label, value) { return `<div><dt>${escape(label)}</dt><dd>${escape(value ?? '—')}</dd></div>`; }
  function modalContent(item) {
    const sessions = item.sessions?.length ? item.sessions : item.sessionKey ? [item.sessionKey] : [];
    return `<div class="media-detail-layout"><div class="media-detail-visual" id="media-detail-image">${item.previewVariant ? `<div class="media-preview-message">${picture}<span>正在加载预览…</span></div>` : placeholder(item, true)}</div><div class="media-detail-info">
      <div class="media-detail-badges">${badge(item)}${item.mimeType === 'image/gif' ? '<span class="media-badge">GIF 动图</span>' : ''}</div>
      ${item.kind === 'generated' ? `<section class="media-prompt"><h3>绘图提示词</h3><p>${escape(item.prompt || '未记录提示词')}</p></section>` : `<section class="media-prompt"><h3>名称与含义</h3><p>${escape(titleOf(item))}</p></section>${item.tags?.length ? `<div class="media-tags">${item.tags.map((tag) => `<span>${escape(tag)}</span>`).join('')}</div>` : ''}`}
      <dl class="media-details">${keyValue('保存时间', date(item.createdAt))}${keyValue('来源会话', sessions.length ? sessions.map(scope).join('、') : '未记录会话')}
      ${item.kind === 'generated' ? keyValue('绘图模型', item.model) + keyValue('请求尺寸', item.size) : keyValue('表情类型', typeNames[item.memeType] || '图片素材') + keyValue('使用次数', count(item.usedCount)) + keyValue('最近使用', date(item.lastUsedAt))}
      ${keyValue('原图大小', size(item.bytes))}${keyValue('图片格式', item.mimeType?.startsWith('image/') ? item.mimeType.slice(6).toUpperCase() : '无可预览原图')}</dl>
      ${item.missingParameters?.length ? '<p class="media-notice">这份收藏的信息还不完整，暂不能原样发送。</p>' : ''}
      ${['mface', 'face'].includes(item.memeType) ? '<p class="media-detail-note">原生表情通过 QQ 参数发送。本地预览不代表 QQ 客户端的播放效果。</p>' : ''}
      <div class="media-detail-actions">${item.originalAvailable ? '<button type="button" class="button primary" data-media-download>下载原图</button>' : ''}${item.previewVariant ? '<button type="button" class="button" data-media-retry>重新加载预览</button>' : ''}</div>
      <details class="media-identifier"><summary>素材编号</summary><code>${escape(item.id)}</code></details>
    </div></div>`;
  }
  async function loadDetail(item) {
    const ticket = generation;
    const sequence = ++modalSequence;
    if (!item.previewVariant) return;
    root.querySelectorAll('[data-media-retry]').forEach((button) => { button.disabled = true; });
    const visual = $('#media-detail-image');
    visual.innerHTML = `<div class="media-preview-message">${picture}<span>正在加载预览…</span></div>`;
    try {
      const url = await imageUrl(item, item.previewVariant, ticket);
      if (!url || !current(ticket) || sequence !== modalSequence || !$('#media-dialog')?.open) return;
      const image = document.createElement('img');
      image.alt = titleOf(item); image.src = url;
      image.addEventListener('error', () => { if (sequence === modalSequence && visual.isConnected) visual.innerHTML = '<p class="media-detail-note">当前文件无法预览，可尝试下载原图。</p>'; }, { once: true });
      visual.replaceChildren(image);
    } catch (error) {
      if (current(ticket) && sequence === modalSequence && $('#media-dialog')?.open) visual.innerHTML = `<div class="media-preview-message">${picture}<span>预览加载失败</span><p>${escape(error.message)}</p><button type="button" class="button" data-media-retry>重试预览</button></div>`;
    } finally {
      if (current(ticket) && sequence === modalSequence) root.querySelectorAll('[data-media-retry]').forEach((button) => { button.disabled = false; });
    }
  }
  function open(index, button) {
    selected = result.items[index];
    if (!selected) return;
    opener = button;
    $('#media-dialog-title').textContent = selected.kind === 'generated' ? '绘图作品' : typeNames[selected.memeType] || '表情详情';
    $('#media-dialog-body').innerHTML = modalContent(selected);
    $('#media-dialog').showModal();
    $('[data-media-close]')?.focus();
    loadDetail(selected);
  }
  function retryDetail() {
    if (!selected) return;
    const key = cacheKey(selected, selected.previewVariant);
    const previous = cache.get(key);
    cache.delete(key);
    // Remove the old detail image synchronously. Keep a shared thumbnail URL alive,
    // but release detail-only blobs before another retry allocates their replacement.
    loadDetail(selected);
    if (previous && ![...root.querySelectorAll('img')].some((image) => image.getAttribute('src') === previous)) {
      URL.revokeObjectURL(previous);
      urls.delete(previous);
    }
  }
  async function download(button) {
    const item = selected;
    const ticket = generation;
    const sequence = modalSequence;
    if (!item?.originalAvailable) return;
    button.disabled = true; button.textContent = '正在准备…';
    try {
      const url = await imageUrl(item, 'original', ticket);
      if (!url || !current(ticket) || sequence !== modalSequence || !$('#media-dialog')?.open) return;
      const link = document.createElement('a');
      link.href = url;
      const suffix = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[item.mimeType] || 'bin';
      link.download = `fish-${item.id}.${suffix}`;
      link.click();
    } catch (error) { if (current(ticket) && sequence === modalSequence) toast?.(`下载失败：${error.message}`, true); }
    finally { if (button.isConnected) { button.disabled = false; button.textContent = '下载原图'; } }
  }
  function attach(host) {
    root = host;
    listeners?.abort(); listeners = new AbortController();
    const signal = listeners.signal;
    root.addEventListener('submit', (event) => {
      if (event.target.id !== 'media-filters') return;
      event.preventDefault();
      const form = new FormData(event.target);
      filters = { ...filters, q: String(form.get('q') || '').trim(), sessionKey: String(form.get('sessionKey') || ''), status: String(form.get('status') || ''), offset: 0 };
      reload('#media-query');
    }, { signal });
    root.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button || !root.contains(button)) return;
      if (button.hasAttribute('data-media-reset')) { filters = initial(); reload('#media-query'); }
      else if (button.dataset.mediaPage) {
        filters.offset = button.dataset.mediaPage === 'next' ? result.nextOffset ?? filters.offset : Math.max(0, filters.offset - filters.limit);
        reload('#media-query');
      } else if (button.hasAttribute('data-media-open')) open(Number(button.dataset.mediaOpen), button);
      else if (button.hasAttribute('data-media-close')) $('#media-dialog').close();
      else if (button.hasAttribute('data-media-retry') && selected) retryDetail();
      else if (button.hasAttribute('data-media-download')) download(button);
    }, { signal });
    const dialog = $('#media-dialog');
    dialog?.addEventListener('close', () => { modalSequence++; selected = null; if (opener?.isConnected) opener.focus(); opener = null; }, { signal });
    dialog?.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }, { signal });
    const ticket = generation;
    const enqueue = (element) => { queue.push({ element, index: Number(element.dataset.mediaThumb), ticket }); pump(); };
    const thumbs = root.querySelectorAll('[data-media-thumb]');
    observer?.disconnect();
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver((entries) => { for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); enqueue(entry.target); } }, { rootMargin: '160px' });
      thumbs.forEach((element) => observer.observe(element));
    } else thumbs.forEach(enqueue);
  }
  return { render, attach, detach, clear };
}
