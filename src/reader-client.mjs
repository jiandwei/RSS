// Keep this function self-contained: the Worker serves its source as a classic
// browser script. Integration tests execute the built /reader.js response.
// wrangler.jsonc disables keep_names so the source has no outer esbuild helpers.
export function readerClient() {
  'use strict';
  const seed = document.getElementById('reader-data');
  const list = document.getElementById('papers-list');
  const tools = document.getElementById('reader-tools');
  if (!seed || !list || !tools) return;
  let data;
  try { data = JSON.parse(seed.textContent); } catch { return; }
  const key = 'scholar-rss:favorites:v1';
  const search = document.getElementById('paper-search');
  const filter = document.getElementById('database-filter');
  const toggle = document.getElementById('show-favorites');
  const exportButton = document.getElementById('export-favorites');
  const status = document.getElementById('reader-status');
  const warning = document.getElementById('storage-warning');
  const viewTitle = document.getElementById('reader-title');
  const listTitle = document.getElementById('list-title');
  const listHint = document.getElementById('list-hint');
  const emptyServerMessage = list.querySelector('.empty');
  let onlyFavorites = false;
  let allowPersistence = true;
  let pendingLocalChanges = false;
  let favorites = new Map();

  const text = (value, max = 1000) => typeof value === 'string' ? value.slice(0, max).trim() : '';
  const strings = (values, max = 100) => Array.isArray(values) ? [...new Set(values.filter(value => typeof value === 'string').map(value => text(value, 300)).filter(Boolean))].slice(0, max) : [];
  function safeLink(value) {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  function paper(value) {
    if (!value || typeof value !== 'object' || !text(value.id, 300) || !text(value.title, 700) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value.date?.value ?? '') || Number.isNaN(Date.parse(value.date.value))) return null;
    return {
      id: text(value.id, 300), title: text(value.title, 700), url: safeLink(value.url),
      authors: strings(value.authors), journal: text(value.journal), doi: text(value.doi, 300),
      date: { value: value.date.value, precision: value.date.precision === 'month' ? 'month' : 'day', source: text(value.date.source, 300) },
      abstract: typeof value.abstract === 'string' ? value.abstract.trim() : '', abstractSource: text(value.abstractSource, 300),
      categories: strings(value.categories, 40),
      databases: (Array.isArray(value.databases) ? value.databases : []).filter(database => database && /^[a-z0-9-]{1,80}$/.test(database.id) && text(database.name)).slice(0, 40).map(database => ({ id: database.id, name: text(database.name, 150) })),
      sources: (Array.isArray(value.sources) ? value.sources : []).filter(source => source && safeLink(source.url)).slice(0, 40).map(source => ({ url: safeLink(source.url), label: text(source.label, 300) || '文献来源' })),
      alternatives: (Array.isArray(value.alternatives) ? value.alternatives : []).map(safeLink).filter(Boolean).slice(0, 20),
      savedAt: typeof value.savedAt === 'string' && !Number.isNaN(Date.parse(value.savedAt)) ? new Date(value.savedAt).toISOString() : ''
    };
  }
  const current = new Map((data.papers ?? []).map(paper).filter(Boolean).map(item => [item.id, item]));
  const currentCards = new Map([...list.querySelectorAll('[data-paper-id]')].map(card => [card.dataset.paperId, card]));
  function storageWarning(message) { warning.textContent = message; warning.hidden = !message; }
  function readStore(raw) {
    if (raw === null) return { items: new Map(), damaged: false };
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || !Array.isArray(parsed.papers)) throw new Error('Unknown favorites format');
    const items = parsed.papers.slice(0, 5000).map(paper);
    return { items: new Map(items.filter(Boolean).map(item => [item.id, item])), damaged: items.some(item => !item) || parsed.papers.length > 5000 };
  }
  try {
    const stored = readStore(window.localStorage.getItem(key));
    favorites = stored.items;
    if (stored.damaged) {
      allowPersistence = false;
      storageWarning('部分收藏数据无法读取，原始数据未被覆盖。可导出仍能读取的收藏；本次新增收藏仅临时保留。');
    }
  } catch {
    allowPersistence = false;
    storageWarning('无法读取浏览器收藏，原始数据未被覆盖。本页仍可临时收藏和导出，关闭页面前请导出备份。');
  }
  function persist() {
    if (!allowPersistence) { pendingLocalChanges = true; return false; }
    try {
      window.localStorage.setItem(key, JSON.stringify({ version: 1, papers: [...favorites.values()] }));
      pendingLocalChanges = false;
      storageWarning('');
      return true;
    } catch {
      pendingLocalChanges = true;
      storageWarning('浏览器未能保存收藏（存储空间不足或被禁用）。本次更改仅在当前页面保留，请及时导出 Markdown。');
      return false;
    }
  }

  function node(tag, className, content) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (content !== undefined) result.textContent = content;
    return result;
  }
  function anchor(url, label, className) {
    const result = node('a', className, label);
    result.href = safeLink(url);
    result.rel = 'noreferrer noopener';
    return result;
  }
  function displayDate(item) { return item.date.precision === 'month' ? item.date.value.slice(0, 7) + '（月精度）' : item.date.value; }
  function favoriteButton(item) {
    const button = node('button', 'favorite-button');
    button.type = 'button'; button.dataset.favoriteId = item.id;
    return button;
  }
  function savedCard(item, index) {
    const article = node('article', 'paper'); article.dataset.paperId = item.id;
    const rail = node('div', 'paper-index');
    rail.append(node('strong', '', String(index + 1).padStart(2, '0')));
    const date = node('time', '', item.date.precision === 'month' ? item.date.value.slice(0, 7) : item.date.value);
    date.dateTime = date.textContent; rail.append(date);
    const body = node('div', 'paper-body');
    const heading = node('div', 'paper-heading'); const tags = node('div', 'tags');
    for (const category of item.categories) tags.append(node('span', 'tag', category));
    for (const database of item.databases) tags.append(node('span', 'tag database-tag', database.name));
    heading.append(tags, favoriteButton(item)); body.append(heading);
    const title = node('h2', 'paper-title'); title.append(item.url ? anchor(item.url, item.title) : document.createTextNode(item.title)); body.append(title);
    const details = node('div', 'paper-details');
    const table = node('table', 'paper-meta'); const tbody = node('tbody');
    table.setAttribute('role', 'presentation');
    const metadata = [['作者', item.authors.join(' · ') || '作者信息暂缺'], ['发表日期', displayDate(item)]];
    if (item.journal) metadata.push(['期刊', item.journal]);
    if (item.doi) metadata.push(['DOI', anchor('https://doi.org/' + item.doi.split('/').map(encodeURIComponent).join('/'), item.doi)]);
    if (item.databases.length) metadata.push(['摘要提及', item.databases.map(database => database.name).join(' · ')]);
    for (const [label, value] of metadata) {
      const row = node('tr'); const th = node('th', '', label); th.scope = 'row'; const td = node('td');
      td.append(typeof value === 'string' ? document.createTextNode(value) : value); row.append(th, td); tbody.append(row);
    }
    table.append(tbody); details.append(table, node('h3', '', '摘要'));
    for (const paragraph of (item.abstract || '原始来源暂未提供摘要；可通过论文链接查看原文。').split(/\r?\n\s*\r?\n/).filter(value => value.trim())) details.append(node('p', '', paragraph));
    if (item.abstractSource) details.append(node('p', 'provenance', '摘要来源：' + item.abstractSource));
    details.append(node('p', 'provenance', '日期依据：' + item.date.source));
    if (item.sources.length || item.alternatives.length) {
      const sources = node('div', 'paper-sources'); sources.append(node('strong', '', '发现来源与其他版本')); const links = node('ul');
      for (const source of item.sources) { const li = node('li'); li.append(anchor(source.url, source.label)); links.append(li); }
      item.alternatives.forEach((url, i) => { const li = node('li'); li.append(anchor(url, '其他论文链接 ' + (i + 1))); links.append(li); });
      sources.append(links); details.append(sources);
    }
    body.append(details);
    const actions = node('div', 'paper-actions');
    if (item.url) actions.append(anchor(item.url, '阅读全文 ↗', 'primary-link'));
    actions.append(node('small', '', '收藏快照 · 不受订阅时间窗口限制')); body.append(actions);
    article.append(rail, body); return article;
  }
  function updateButtons() {
    for (const button of list.querySelectorAll('[data-favorite-id]')) {
      const selected = favorites.has(button.dataset.favoriteId);
      button.hidden = false; button.setAttribute('aria-pressed', String(selected));
      button.textContent = selected ? '★ 已收藏' : '☆ 收藏';
      button.setAttribute('aria-label', selected ? '取消收藏这篇论文' : '收藏这篇论文');
    }
    document.getElementById('favorite-count').textContent = String(favorites.size);
    exportButton.disabled = favorites.size === 0;
  }
  const normalized = value => String(value).normalize('NFKC').toLowerCase();
  function render() {
    const pool = onlyFavorites ? [...favorites.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.title.localeCompare(b.title)) : [...current.values()];
    const words = normalized(search.value).trim().split(/\s+/).filter(Boolean);
    const selected = pool.filter(item => {
      const terms = normalized([item.title, item.abstract, item.doi, item.journal, ...item.authors, ...item.categories, ...item.databases.map(database => database.name)].join(' '));
      return words.every(word => terms.includes(word)) && (!filter.value || (filter.value === 'none' ? !item.databases.length : item.databases.some(database => database.id === filter.value)));
    });
    const cards = selected.map((item, index) => onlyFavorites ? savedCard(item, index) : currentCards.get(item.id)).filter(Boolean);
    if (!cards.length) {
      if (!onlyFavorites && !current.size && !words.length && !filter.value && emptyServerMessage) cards.push(emptyServerMessage);
      else {
        const empty = node('section', 'empty');
        empty.append(node('h2', '', onlyFavorites && !favorites.size ? '还没有收藏论文' : '没有符合筛选条件的论文'));
        empty.append(node('p', '', onlyFavorites && !favorites.size ? '在论文卡片上点击“收藏”，就能在这里继续阅读和导出。' : '试试其他关键词，或清除搜索与数据库筛选。'));
        if (words.length || filter.value) { const clear = node('button', 'secondary-button', '清除筛选'); clear.type = 'button'; clear.addEventListener('click', () => { search.value = ''; filter.value = ''; render(); search.focus(); }); empty.append(clear); }
        cards.push(empty);
      }
    }
    list.replaceChildren(...cards);
    toggle.setAttribute('aria-pressed', String(onlyFavorites));
    viewTitle.textContent = onlyFavorites ? '我的研究收藏' : '最近两个月的研究';
    listTitle.textContent = onlyFavorites ? '我的收藏' : '论文列表';
    listHint.textContent = onlyFavorites ? '按收藏时间排序 · 当前浏览器' : '按发表日期排序 · 每 6 小时更新';
    document.getElementById('shown-count').textContent = String(pool.length);
    status.textContent = '显示 ' + selected.length + ' / ' + pool.length + ' 篇' + (onlyFavorites ? '收藏；导出按钮会导出全部收藏。' : '论文；可按标题、作者、摘要、DOI 搜索。');
    updateButtons();
  }

  list.addEventListener('click', event => {
    const button = event.target.closest('[data-favorite-id]');
    if (!button || !list.contains(button)) return;
    const id = button.dataset.favoriteId;
    const wasSaved = favorites.has(id);
    // Storage events can arrive after a click in a different tab. Refresh the
    // durable state before an action, without dropping unsaved local changes.
    if (allowPersistence && !pendingLocalChanges) {
      try {
        const stored = readStore(window.localStorage.getItem(key));
        if (stored.damaged) throw new Error('Damaged favorites');
        favorites = stored.items;
      } catch {
        allowPersistence = false;
        storageWarning('浏览器收藏已发生异常，原始数据未被覆盖。本页更改将临时保留，请导出备份。');
      }
    }
    let saved = false;
    if (wasSaved) favorites.delete(id);
    else {
      const source = current.get(id);
      if (!source) return;
      if (favorites.size >= 5000) { status.textContent = '收藏已达 5000 篇，请先导出备份后整理。'; return; }
      favorites.set(id, { ...source, savedAt: new Date().toISOString() }); saved = true;
    }
    const persistent = persist();
    render();
    status.textContent = (saved ? '已' + (persistent ? '' : '临时') + '收藏。' : '已取消收藏。') + (persistent ? '收藏保存在当前浏览器。' : '当前更改未保存到浏览器，请及时导出。');
    ([...list.querySelectorAll('[data-favorite-id]')].find(item => item.dataset.favoriteId === id) || toggle).focus();
  });
  search.addEventListener('input', render); filter.addEventListener('change', render);
  toggle.addEventListener('click', () => { onlyFavorites = !onlyFavorites; render(); });

  function markdownText(value) {
    return String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replace(/[\\`*_\[\]]/g, '\\$&').replace(/^(\s*)(#{1,6}|[-+>]|\d+[.)])(?=\s)/gm, '$1\\$2');
  }
  function markdownLink(url, label) {
    const href = safeLink(url);
    return href ? '[' + markdownText(label) + '](<' + href.replace(/[<>"\\\s]/g, encodeURIComponent) + '>)' : markdownText(label);
  }
  exportButton.addEventListener('click', () => {
    if (!favorites.size) return;
    const now = new Date();
    const papers = [...favorites.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.title.localeCompare(b.title));
    const lines = ['# 研究论文收藏', '', '导出时间：' + now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）', '收藏数量：' + papers.length, '', '以下为收藏时保存的论文快照，可能包含已退出订阅窗口的论文。', ''];
    papers.forEach((item, index) => {
      lines.push('## ' + (index + 1) + '. ' + markdownLink(item.url, item.title), '', '- **作者**：' + markdownText(item.authors.join(' · ') || '作者信息暂缺'), '- **发表日期**：' + markdownText(displayDate(item)));
      if (item.journal) lines.push('- **期刊**：' + markdownText(item.journal));
      if (item.doi) lines.push('- **DOI**：' + markdownLink('https://doi.org/' + item.doi.split('/').map(encodeURIComponent).join('/'), item.doi));
      if (item.categories.length) lines.push('- **收录来源**：' + markdownText(item.categories.join(' · ')));
      if (item.databases.length) lines.push('- **摘要提及数据库**：' + markdownText(item.databases.map(database => database.name).join(' · ')));
      lines.push('', '### 摘要', '', markdownText(item.abstract || '原始来源暂未提供摘要。'), '');
      if (item.abstractSource) lines.push('摘要来源：' + markdownText(item.abstractSource), '');
      lines.push('日期依据：' + markdownText(item.date.source), '');
      if (item.sources.length || item.alternatives.length) {
        lines.push('### 发现来源与其他版本', '');
        for (const source of item.sources) lines.push('- ' + markdownLink(source.url, source.label));
        item.alternatives.forEach((url, i) => lines.push('- ' + markdownLink(url, '其他论文链接 ' + (i + 1))));
        lines.push('');
      }
      lines.push('---', '');
    });
    let objectURL;
    try {
      objectURL = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }));
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
      const download = node('a'); download.href = objectURL; download.download = 'research-favorites-' + parts.year + '-' + parts.month + '-' + parts.day + '.md'; download.hidden = true;
      document.body.append(download); download.click(); download.remove();
      status.textContent = '已导出全部 ' + papers.length + ' 篇收藏为 Markdown。';
    } catch { status.textContent = '导出失败，收藏仍保留在当前页面；请重试或检查浏览器下载权限。'; }
    finally { if (objectURL) setTimeout(() => URL.revokeObjectURL(objectURL), 1000); }
  });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    if (pendingLocalChanges) {
      storageWarning('另一标签页更新了收藏；本页有尚未保存的更改，已保留本页内容。请先导出备份，再刷新以同步。');
      return;
    }
    try {
      const stored = readStore(event.newValue);
      favorites = stored.items; allowPersistence = !stored.damaged;
      storageWarning(stored.damaged ? '另一标签页的收藏包含无效数据，本页不会覆盖原始数据。' : ''); render();
    } catch { storageWarning('另一标签页的收藏数据无法读取，已保留本页内容。'); }
  });
  tools.hidden = false;
  render();
}

export const readerScript = '(' + readerClient.toString() + ')();\n';
