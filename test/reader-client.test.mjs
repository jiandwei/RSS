import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderReadingPage } from '../src/reading.mjs';
import { readerScript } from '../src/reader-client.mjs';
import { readerOptions, readerPapers } from './fixtures/reader.mjs';

const KEY = 'scholar-rss:favorites:v1';
function reader(t, papers = readerPapers, { stored, storage, script = readerScript } = {}) {
  const dom = new JSDOM(renderReadingPage(papers, readerOptions), { url: readerOptions.origin + '/papers.html?key=' + readerOptions.accessKey, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom; const { document } = window; const blobs = []; const downloads = [];
  window.Blob = Blob;
  window.URL.createObjectURL = blob => { blobs.push(blob); return 'blob:https://reader.example/export'; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { downloads.push({ name: this.download, href: this.href }); };
  if (stored !== undefined) window.localStorage.setItem(KEY, stored);
  if (storage === 'blocked') Object.defineProperty(window, 'localStorage', { get() { throw new window.DOMException('Storage disabled', 'SecurityError'); } });
  if (storage === 'quota') window.Storage.prototype.setItem = () => { throw new window.DOMException('Quota exceeded', 'QuotaExceededError'); };
  window.eval(script);
  const select = selector => document.querySelector(selector);
  const favorite = id => [...document.querySelectorAll('[data-favorite-id]')].find(button => button.dataset.favoriteId === id);
  const search = value => { select('#paper-search').value = value; select('#paper-search').dispatchEvent(new window.Event('input', { bubbles: true })); };
  const filter = value => { select('#database-filter').value = value; select('#database-filter').dispatchEvent(new window.Event('change', { bubbles: true })); };
  return { dom, window, document, blobs, downloads, select, favorite, search, filter, cards: () => [...document.querySelectorAll('#papers-list article.paper')] };
}

test('favorite toggles persist full snapshots, reload correctly, and never store reader credentials', t => {
  const view = reader(t);
  assert.equal(view.select('#reader-tools').hidden, false);
  assert.equal(view.select('#export-favorites').disabled, true);
  view.favorite('paper-a').click();
  assert.equal(view.favorite('paper-a').getAttribute('aria-pressed'), 'true');
  assert.equal(view.select('#favorite-count').textContent, '1');
  const raw = view.window.localStorage.getItem(KEY); const saved = JSON.parse(raw);
  assert.equal(saved.papers[0].abstract, readerPapers[0].abstract);
  assert.equal(saved.papers[0].sources[0].url, 'https://example.com/source');
  assert.equal(saved.papers[0].databases[0].id, 'factset-revere');
  assert.ok(saved.papers[0].savedAt);
  assert.ok(!raw.includes(readerOptions.accessKey));
  const reloaded = reader(t, readerPapers, { stored: raw });
  assert.equal(reloaded.favorite('paper-a').getAttribute('aria-pressed'), 'true');
  reloaded.favorite('paper-a').click();
  assert.equal(reloaded.select('#favorite-count').textContent, '0');
  assert.deepEqual(JSON.parse(reloaded.window.localStorage.getItem(KEY)).papers, []);
});

test('favorites remain readable and exportable after papers leave the live subscription window', async t => {
  const first = reader(t, [{ ...readerPapers[0], date: { ...readerPapers[0].date, value: '2024-01-15' } }]);
  first.favorite('paper-a').click();
  const archived = reader(t, [], { stored: first.window.localStorage.getItem(KEY) });
  assert.equal(archived.cards().length, 0);
  archived.select('#show-favorites').click();
  assert.equal(archived.cards().length, 1);
  assert.match(archived.select('#papers-list').textContent, /Production Networks and Resilience/);
  assert.match(archived.select('#papers-list').textContent, /2024-01-15/);
  assert.equal(archived.select('#reader-title').textContent, '我的研究收藏');
  archived.select('#export-favorites').click();
  assert.match(await archived.blobs[0].text(), /2024-01-15/);
  archived.favorite('paper-a').click();
  assert.equal(archived.cards().length, 0);
  assert.match(archived.select('#papers-list').textContent, /还没有收藏论文/);
});

test('search and database filtering compose in both views; export always includes all favorites', async t => {
  const view = reader(t);
  view.favorite('paper-a').click(); view.favorite('paper-b').click();
  view.search('alice factset'); assert.equal(view.cards().length, 1);
  view.filter('panjiva'); assert.equal(view.cards().length, 0);
  view.select('.empty button').click(); assert.equal(view.cards().length, 3);
  view.filter('none'); assert.equal(view.cards().length, 1); assert.match(view.cards()[0].textContent, /Labor and Management/);
  view.filter(''); view.select('#show-favorites').click(); assert.equal(view.cards().length, 2);
  view.filter('panjiva'); assert.equal(view.cards().length, 1);
  view.select('#export-favorites').click();
  const markdown = await view.blobs[0].text();
  assert.match(markdown, /^# 研究论文收藏\n/);
  assert.match(markdown, /收藏数量：2/);
  assert.match(markdown, /## 1\./); assert.match(markdown, /## 2\./);
  assert.match(markdown, /Production Networks and Resilience/);
  assert.match(markdown, /Trade Finance with Customs Records/);
  assert.match(markdown, /Alice Researcher/);
  assert.match(markdown, /### 摘要\n\n/);
  assert.match(markdown, /A second paragraph preserves the full research abstract\./);
  assert.match(markdown, /10\.5555\/networks/);
  assert.match(markdown, /https:\/\/example.com\/source/);
  assert.match(markdown, /2026-10（月精度）/);
  assert.ok(!markdown.includes(readerOptions.accessKey));
  assert.ok(!markdown.includes('reader.example'));
  assert.equal(view.blobs[0].type, 'text/markdown;charset=utf-8');
  assert.match(view.downloads[0].name, /^research-favorites-\d{4}-\d{2}-\d{2}\.md$/);
});

test('unavailable, full, and corrupt browser storage allow temporary collection and export without claiming persistence', async t => {
  for (const storage of ['blocked', 'quota', 'corrupt']) {
    const raw = '{not valid favorites';
    const view = reader(t, readerPapers, storage === 'corrupt' ? { stored: raw } : { storage });
    view.favorite('paper-a').click();
    assert.equal(view.favorite('paper-a').getAttribute('aria-pressed'), 'true');
    assert.equal(view.select('#storage-warning').hidden, false);
    assert.match(view.select('#reader-status').textContent, /临时收藏/);
    view.select('#export-favorites').click();
    assert.match(await view.blobs[0].text(), /Production Networks/);
    if (storage === 'corrupt') assert.equal(view.window.localStorage.getItem(KEY), raw, 'invalid storage is never overwritten');
  }
});

test('stored content is rendered as text and exported as escaped Markdown; unsafe links and unknown fields are dropped', async t => {
  const malicious = { ...readerPapers[0], title: '<img src=x onerror=alert(1)> [unsafe]', url: 'javascript:alert(1)',
    abstract: '<script>alert(1)</script>\n\n![tracking](https://example.com/image)\n\n# fake heading',
    authors: ['<svg onload=alert(1)>'], sources: [{ label: 'evil', url: 'data:text/html,bad' }], savedAt: '2026-10-28T00:00:00Z',
    privateSubscription: 'https://reader.example/feed.xml?key=' + readerOptions.accessKey };
  const view = reader(t, [], { stored: JSON.stringify({ version: 1, papers: [malicious] }) });
  view.select('#show-favorites').click();
  assert.equal(view.select('#papers-list').querySelectorAll('script,img,svg').length, 0);
  assert.equal(view.select('#papers-list').querySelectorAll('a[href^="javascript:"],a[href^="data:"]').length, 0);
  assert.match(view.select('#papers-list').textContent, /<script>alert/);
  view.select('#export-favorites').click(); const markdown = await view.blobs[0].text();
  assert.doesNotMatch(markdown, /<script|<img|!\[tracking\]/);
  assert.match(markdown, /&lt;script&gt;/);
  assert.ok(markdown.includes('\\# fake heading'));
  assert.ok(!markdown.includes(readerOptions.accessKey));
});

test('storage updates from another tab synchronize counts and saved snapshots', t => {
  const view = reader(t);
  const external = JSON.stringify({ version: 1, papers: [{ ...readerPapers[1], savedAt: '2026-10-28T00:00:00Z' }] });
  view.window.dispatchEvent(new view.window.StorageEvent('storage', { key: KEY, newValue: external }));
  assert.equal(view.select('#favorite-count').textContent, '1');
  view.select('#show-favorites').click(); assert.equal(view.cards().length, 1);
  assert.match(view.cards()[0].textContent, /Trade Finance/);
  view.window.dispatchEvent(new view.window.StorageEvent('storage', { key: KEY, newValue: null }));
  assert.equal(view.select('#favorite-count').textContent, '0');
});

test('export failures retain favorites, and empty collections cannot start a download', t => {
  const view = reader(t);
  view.select('#export-favorites').click(); assert.equal(view.downloads.length, 0);
  view.favorite('paper-a').click();
  view.window.URL.createObjectURL = () => { throw new Error('Downloads blocked'); };
  view.select('#export-favorites').click();
  assert.match(view.select('#reader-status').textContent, /导出失败/);
  assert.equal(view.select('#favorite-count').textContent, '1');
  assert.equal(JSON.parse(view.window.localStorage.getItem(KEY)).papers.length, 1);
});

test('a late storage event cannot make an action overwrite another tab’s saved papers', t => {
  const view = reader(t);
  const external = { ...readerPapers[1], savedAt: '2026-10-28T00:00:00Z' };
  view.window.localStorage.setItem(KEY, JSON.stringify({ version: 1, papers: [external] }));
  // Simulate clicking before the browser delivers the storage event.
  view.favorite('paper-a').click();
  const stored = JSON.parse(view.window.localStorage.getItem(KEY));
  assert.deepEqual(new Set(stored.papers.map(item => item.id)), new Set(['paper-a', 'paper-b']));
});

test('long abstracts are preserved in the saved snapshot and Markdown export without silent truncation', async t => {
  const abstract = 'Evidence about firm linkages. '.repeat(10000) + 'ENDOFABSTRACT';
  const view = reader(t, [{ ...readerPapers[0], abstract }]);
  view.favorite('paper-a').click();
  const stored = JSON.parse(view.window.localStorage.getItem(KEY));
  assert.equal(stored.papers[0].abstract.length, abstract.length);
  view.select('#export-favorites').click();
  assert.ok((await view.blobs[0].text()).includes(abstract));
});
