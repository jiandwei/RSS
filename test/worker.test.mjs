import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import workerHandler, { FeedStore } from '../dist/index.js';
import { JSDOM } from 'jsdom';
import { renderReadingPage } from '../src/reading.mjs';
import { readerOptions, readerPapers } from './fixtures/reader.mjs';

const ACCESS_KEY = 'test-reader-secret-0123456789abcdef0123456789';
const recent = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const ancient = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
const xmlEscape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
function work(title, id, authors, abstract = '', date = recent) {
  return { DOI: `10.5555/${id}`, title: [title], author: authors.map(name => ({ given: name.split(' ')[0], family: name.split(' ').slice(1).join(' ') })),
    abstract, ISSN: ['0025-1909'], type: 'journal-article', 'published-online': { 'date-parts': [date.split('-').map(Number)] } };
}
function metadataFixture(url, revised) {
  const papers = [
    work('Research on Trade and Globalization', 'trade', ['Marc Melitz']),
    work('Tasks, Technology and Labor Demand', 'tasks', ['David Autor']),
    work('Trade and Inequality across Local Markets', 'inequality', ['David Dorn']),
    work('Management and Firm Dynamism', 'management', ['Nicholas Bloom', 'John Van Reenen']),
    work(revised ? 'A New Theory of Innovation' : 'Innovation and Long Run Growth', 'innovation', ['John Van Reenen']),
    work('Global Networks and Financial Resilience', 'networks', ['A. Author'], '<p>We study supply-chain disruptions and credit.</p>'),
    work('Supply Chain in the Title Only', 'title-only', ['A. Author'], 'This abstract concerns employment.'),
    work('Logistics and Corporate Resilience', 'logistics', ['A. Author']),
    work('Old Research on Supplier Networks', 'old', ['A. Author'], 'Supply chain evidence.', ancient),
    { ...work('Outside the Journal Whitelist', 'outside', ['A. Author'], 'Supply chain evidence.'), ISSN: ['9999-9999'] }
  ];
  const nber = { ...work('Global Networks and Trade Credit', 'nber', ['N. Researcher']), DOI: '10.3386/w12345', type: 'report', ISSN: [] };
  if (url.hostname === 'api.crossref.org') {
    const items = url.pathname.includes('/prefixes/') ? [nber] : url.searchParams.has('query.title') ?
      papers.filter(p => p.title[0] === url.searchParams.get('query.title')) : papers;
    return Response.json({ message: { items, 'total-results': items.length, 'next-cursor': 'finished' } });
  }
  if (url.hostname === 'api.openalex.org') {
    const filter = url.searchParams.get('filter') ?? '';
    const results = filter.startsWith('doi:') && filter.includes('10.5555/logistics') ? [{ doi: 'https://doi.org/10.5555/logistics',
      abstract_inverted_index: { We: [0], investigate: [1], supply: [2], chains: [3], empirically: [4] } }] : [];
    return Response.json({ results, meta: { count: results.length, next_cursor: null } });
  }
  const rss = items => new Response(`<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>${items.map(item =>
    `<item><title>${xmlEscape(item.title)}</title><link>${item.url}</link><description><![CDATA[${item.abstract}]]></description>${item.date ? `<pubDate>${new Date(item.date).toUTCString()}</pubDate>` : ''}<dc:creator>A. Author</dc:creator></item>`).join('')}</channel></rss>`,
    { headers: { 'Content-Type': 'application/rss+xml' } });
  if (url.hostname === 'back.nber.org') return rss([{ title: nber.title[0], url: 'https://www.nber.org/papers/w12345#fromrss', abstract: 'We analyze supply chains and trade credit.' }]);
  return rss(url.searchParams.has('page') ? [{ title: 'An Expired Discussion Paper', url: 'https://cepr.org/publications/dp1', abstract: 'Supply chain risks.', date: ancient }] : [
    { title: 'DP2 Global Networks and Financial Resilience', url: 'https://cepr.org/publications/dp2', abstract: 'Supply chain risk and finance.', date: recent },
    { title: 'Production Networks and Bank Lending', url: 'https://cepr.org/publications/dp3', abstract: 'Evidence about supply chains.', date: recent }
  ]);
}
function read(mf, url, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${ACCESS_KEY}`);
  return mf.dispatchFetch(url, { ...init, headers });
}

// Tiny hand-written fixtures model each site's relevant structure. Real source
// downloads are deliberately not committed. Integration runs native workerd,
// HTMLRewriter and SQLite Durable Objects, not a mocked HTML parser or database.
function fixture(url, revised = false) {
  if (['api.crossref.org', 'api.openalex.org', 'back.nber.org', 'cepr.org'].includes(url.hostname)) return metadataFixture(url, revised);
  let content;
  if (url.hostname.includes('klenow')) return new Response('unavailable', { status: 503 });
  if (url.hostname.includes('harvard')) content = `<div class="csl-entry"><a href="/publications/trade">Research on Trade and Globalization</a></div>`;
  else if (url.hostname.includes('mit.edu')) content = `<h3 class="publication-teaser__title"><a href="/papers/tasks.pdf">Tasks, Technology and Labor Demand</a></h3>`;
  else if (url.hostname.includes('ddorn')) content = `<div class="section"><p><a href="papers/trade.pdf">Trade and Inequality across Local Markets.</a><br><a href="papers/appendix.pdf">Online Appendix</a>`;
  else if (url.hostname.includes('stanford')) content = `<div class="su-wysiwyg-text"><p><a href="https://example.com/management.pdf?rlkey=keep&amp;dl=0">Management and Firm Dynamism</a><a href="slides.pdf">Updated slides</a><a href="https://example.com/data">Management data</a><a href="https://example.com/quarterly.zip">Quarterly Data</a></p></div>`;
  else content = `<div class="wixui-rich-text"><p><span>“Management and Firm Dynamism” (with Nicholas Bloom),</span></p><p><a href="https://other.example.com/dynamism.pdf">ungated</a></p><p>“${revised ? 'A New Theory of Innovation' : 'Innovation and Long Run Growth'}” (with a coauthor), <a href="https://example.com/innovation.pdf">ungated</a></p></div>`;
  return new Response(`<!doctype html><html><body>${content}</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function worker(outboundService, extra = {}) {
  return new Miniflare({
    modules: true, scriptPath: new URL('../dist/index.js', import.meta.url).pathname,
    compatibilityDate: '2026-07-01',
    durableObjects: { FEED_STORE: { className: 'FeedStore', useSQLite: true } },
    bindings: { ACCESS_KEY, REFRESH_TOKEN: 'test-long-secret', MAX_FEED_ITEMS: '200', ...extra },
    outboundService
  });
}

test('one real Worker feed: cold-start lock, deduplication, failures, validators and authenticated refresh', async t => {
  let calls = 0; let broken = false; let revised = false;
  const mf = worker(request => { calls++; return broken ? new Response('blocked', { status: 403 }) : fixture(new URL(request.url), revised); });
  t.after(() => mf.dispose());
  const rssURL = 'https://rss.example/feed.xml';
  const [a, b] = await Promise.all([read(mf, rssURL), read(mf, rssURL)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const xml = await a.text();
  const firstCalls = calls;
  assert.equal(calls, 15, 'concurrent first readers share one crawl of pages and metadata');
  assert.equal((xml.match(/<item>/g) ?? []).length, 9);
  assert.equal((xml.match(/<title>Management and Firm Dynamism<\/title>/g) ?? []).length, 1);
  assert.match(xml, /<category>Nicholas Bloom<\/category>/);
  assert.match(xml, /<category>John Van Reenen<\/category>/);
  for (const group of ['UTD24', 'FT50', 'NBER', 'CEPR']) assert.match(xml, new RegExp(`<category>${group}</category>`));
  assert.doesNotMatch(xml, /Supply Chain in the Title Only|Old Research on Supplier Networks|Outside the Journal Whitelist|Expired Discussion/);
  assert.match(xml, /OpenAlex \(DOI matched\)/);
  assert.doesNotMatch(xml, /Online Appendix|Updated slides|Management data|Quarterly Data/);
  assert.equal(a.headers.get('X-Feed-Health'), 'degraded');
  let report = await (await read(mf, 'https://rss.example/status.json')).json();
  assert.equal(report.researcherCount, 6);
  assert.equal(report.journalCount, 51);
  assert.equal(report.providers.find(p => p.id === 'cepr').pages, 2);
  assert.equal(report.pages.filter(page => page.error).length, 1);
  assert.equal(report.pages.find(page => page.id.startsWith('peter-klenow')).error, 'HTTP 503');

  const notModified = await read(mf, rssURL, { headers: { 'If-None-Match': 'W/' + a.headers.get('ETag') } });
  assert.equal(notModified.status, 304);
  assert.equal(calls, firstCalls);
  const head = await read(mf, rssURL, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await read(mf, rssURL, { method: 'POST' })).status, 405);
  assert.equal((await read(mf, 'https://rss.example/feeds/david-autor.xml')).status, 404);
  const opml = await (await read(mf, 'https://rss.example/feed.opml')).text();
  assert.equal((opml.match(/<outline /g) ?? []).length, 1);
  assert.equal((await read(mf, 'https://rss.example/refresh', { method: 'POST' })).status, 401);
  assert.equal(calls, firstCalls, 'unauthenticated refresh never fetches upstream pages');

  const refresh = () => read(mf, 'https://rss.example/refresh', { method: 'POST', headers: { Authorization: 'Bearer test-long-secret' } });
  const guid = xml.match(/urn:scholar-rss:[a-f0-9]+/)[0];
  await refresh();
  assert.equal((await read(mf, rssURL)).headers.get('ETag'), a.headers.get('ETag'), 'unchanged pages keep the same ETag');
  revised = true;
  await refresh();
  assert.match(await (await read(mf, rssURL)).text(), /A New Theory of Innovation/);
  broken = true;
  report = await (await refresh()).json();
  assert.equal(report.pages.filter(page => page.error).length, 8);
  const stale = await read(mf, rssURL);
  assert.equal(stale.status, 200);
  assert.match(await stale.text(), new RegExp(guid), 'upstream failure never deletes previous papers');
});

test('all failed sources produce an honest 503 with retry backoff, not a fake feed', async t => {
  let calls = 0;
  const mf = worker(() => { calls++; return new Response('<html>No papers here</html>', { headers: { 'Content-Type': 'text/html' } }); });
  t.after(() => mf.dispose());
  assert.equal((await read(mf, 'https://empty.example/feed.xml')).status, 503);
  const firstCalls = calls;
  assert.ok(calls <= 45);
  assert.equal((await read(mf, 'https://empty.example/feed.xml')).status, 503);
  assert.equal(calls, firstCalls);
  const report = await (await read(mf, 'https://empty.example/status.json')).json();
  assert.ok(report.pages.every(page => page.error.includes('No papers extracted')));
  const reading = await read(mf, 'https://empty.example/papers.html');
  assert.equal(reading.status, 503);
  assert.equal(reading.headers.get('Retry-After'), '900');
  assert.match(await reading.text(), /暂未取得可用的论文数据/);
  assert.equal(calls, firstCalls, 'opening the reading file also respects failure backoff');
});

test('successful scans without qualifying recent papers return one empty RSS and do not crawl again on reads', async t => {
  let calls = 0;
  const mf = worker(request => {
    calls++; const url = new URL(request.url);
    if (url.hostname === 'api.crossref.org') return Response.json({ message: { items: [], 'total-results': 0 } });
    if (url.hostname === 'api.openalex.org') return Response.json({ results: [], meta: { count: 0 } });
    if (['cepr.org', 'back.nber.org'].includes(url.hostname)) return new Response('<rss><channel></channel></rss>');
    return fixture(url);
  });
  t.after(() => mf.dispose());
  const response = await read(mf, 'https://rss.example/feed.xml');
  assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /<item>/);
  const first = calls;
  assert.equal((await read(mf, 'https://rss.example/feed.xml')).status, 200);
  assert.equal(calls, first); assert.ok(calls <= 45);
  const reading = await read(mf, 'https://rss.example/papers.html');
  assert.equal(reading.status, 200);
  assert.match(await reading.text(), /暂时没有符合条件的论文/);
  assert.equal(calls, first);
});

test('refresh endpoint is absent when no secret has been configured', async t => {
  const mf = worker(request => fixture(new URL(request.url)), { REFRESH_TOKEN: '' });
  t.after(() => mf.dispose());
  assert.equal((await read(mf, 'https://rss.example/refresh', { method: 'POST' })).status, 404);
});

test('private read routes reject anonymous, invalid and duplicate credentials before DO lookup', async () => {
  const env = { ACCESS_KEY, FEED_STORE: { idFromName() { throw new Error('Unauthorized request touched storage'); } } };
  for (const path of ['/', '/feed.xml', '/papers.html', '/feed.opml', '/status.json', '/sources.json']) {
    for (const suffix of [ ...(path === '/' ? [] : ['']), '?key=wrong', `?key=${ACCESS_KEY}&key=${ACCESS_KEY}`]) {
      const response = await workerHandler.fetch(new Request(`https://private.example${path}${suffix}`), env);
      assert.equal(response.status, 401, path + suffix);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
      assert.doesNotMatch(await response.text(), new RegExp(ACCESS_KEY));
    }
    const head = await workerHandler.fetch(new Request(`https://private.example${path}`, { method: 'HEAD', headers: { 'If-None-Match': '*', Authorization: 'Bearer wrong' } }), env);
    assert.equal(head.status, 401, 'HEAD/conditional requests cannot bypass auth');
  }
  const ambiguous = await workerHandler.fetch(new Request(`https://private.example/feed.xml?key=${ACCESS_KEY}`, {
    headers: { Authorization: 'Bearer wrong' }
  }), env);
  assert.equal(ambiguous.status, 401);
});

test('missing and invalid reader keys have distinct actionable errors; both fail closed without storage or crawling', async () => {
  for (const key of [undefined, '', 'short', 'replace-with-a-random-64-character-hex-key',
    'a'.repeat(31), 'a'.repeat(129), 'invalid secret value with spaces 0123456789',
    '"' + ACCESS_KEY + '"', ACCESS_KEY + '\n', ACCESS_KEY + '=', '中'.repeat(32)]) {
    const env = { ACCESS_KEY: key, FEED_STORE: { idFromName() { throw new Error('Unconfigured service touched storage'); } } };
    const response = await workerHandler.fetch(new Request(`https://private.example/feed.xml?key=${ACCESS_KEY}`), env);
    assert.equal(response.status, 503);
    const message = await response.text();
    assert.match(message, key ? /ACCESS_KEY is set but invalid.*32-128/ : /configure ACCESS_KEY.*then deploy/);
    if (key && key.length > 8) assert.ok(!message.includes(key), 'configuration errors must not echo the secret');
    await workerHandler.scheduled({}, env, { waitUntil() { throw new Error('Unconfigured Cron started work'); } });
  }
});

test('Zotero query key works; private OPML preserves it, RSS and source requests never expose it', async t => {
  let calls = 0;
  const mf = worker(request => {
    calls++;
    assert.ok(!request.url.includes(ACCESS_KEY));
    assert.equal(request.headers.get('Authorization'), null);
    return fixture(new URL(request.url));
  });
  t.after(() => mf.dispose());
  const privateURL = `https://private.example/feed.xml?key=${ACCESS_KEY}`;
  const rss = await mf.dispatchFetch(privateURL);
  assert.equal(rss.status, 200);
  const firstCalls = calls;
  assert.equal(rss.headers.get('Cache-Control'), 'private, no-store');
  assert.doesNotMatch(await rss.text(), new RegExp(ACCESS_KEY));
  const opml = await read(mf, 'https://private.example/feed.opml');
  const opmlXML = await opml.text();
  assert.match(opmlXML, new RegExp(`feed.xml\\?key=${ACCESS_KEY}`));
  assert.equal((opmlXML.match(/<outline /g) ?? []).length, 1);
  const home = await mf.dispatchFetch(`https://private.example/?key=${ACCESS_KEY}`);
  assert.match(await home.text(), new RegExp(`feed.xml\\?key=${ACCESS_KEY}`));
  assert.equal(home.headers.get('Referrer-Policy'), 'no-referrer');
  for (const path of ['/feed.xml', '/papers.html', '/feed.opml', '/status.json', '/sources.json']) {
    assert.equal((await mf.dispatchFetch(`https://private.example${path}`)).status, 401);
  }
  assert.equal((await mf.dispatchFetch('https://private.example/refresh', { method: 'POST', headers: { Authorization: `Bearer ${ACCESS_KEY}` } })).status, 401);
  assert.equal(calls, firstCalls, 'reading or attacking endpoints cannot trigger extra crawls');
  assert.equal((await mf.dispatchFetch('https://private.example/feed.xml', { headers: { Authorization: 'Bearer test-long-secret' } })).status, 401, 'admin token does not grant read access');
});

test('Visit shows a public overview; the private reading file initializes once and uses saved results', async t => {
  let calls = 0;
  const mf = worker(request => { calls++; return fixture(new URL(request.url)); });
  t.after(() => mf.dispose());
  const before = await mf.dispatchFetch('https://rss.example/');
  assert.equal(before.status, 200);
  assert.equal(before.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(before.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(before.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(before.headers.get('Content-Security-Policy'), /form-action 'self'/);
  const initial = await before.text();
  assert.match(initial, /尚未开始抓取/);
  assert.match(initial, /Marc Melitz/);
  assert.match(initial, /name="key" type="password"/);
  assert.doesNotMatch(initial, new RegExp(ACCESS_KEY));
  assert.equal(calls, 0, 'viewing an empty dashboard does not initialize a crawl');
  const head = await mf.dispatchFetch('https://rss.example/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const post = await mf.dispatchFetch('https://rss.example/', { method: 'POST' });
  assert.equal(post.status, 405); assert.equal(post.headers.get('Allow'), 'GET, HEAD');
  assert.equal((await mf.dispatchFetch('https://rss.example/overview')).status, 404, 'internal overview route is not exposed');
  assert.equal(calls, 0);

  const reading = await mf.dispatchFetch(`https://rss.example/papers.html?key=${ACCESS_KEY}`);
  assert.equal(reading.status, 200);
  assert.equal(reading.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(reading.headers.get('Content-Disposition'), 'inline; filename="scholar-papers.html"');
  assert.equal(reading.headers.get('Cache-Control'), 'private, no-store');
  const readingHTML = await reading.text();
  assert.equal((readingHTML.match(/<article class="paper" data-paper-id=/g) ?? []).length, 9);
  assert.match(reading.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.doesNotMatch(before.headers.get('Content-Security-Policy'), /script-src 'self'/, 'only the private reader allows its same-origin script');
  assert.match(readingHTML, /Research on Trade and Globalization/);
  assert.match(readingHTML, /全文|原文/);
  assert.match(readingHTML, /OpenAlex \(DOI matched\)/);
  assert.match(readingHTML, new RegExp(`feed.xml\\?key=${ACCESS_KEY}`));
  const firstCalls = calls;
  assert.ok(firstCalls > 0);
  const readingHead = await read(mf, 'https://rss.example/papers.html', { method: 'HEAD' });
  assert.equal(readingHead.status, 200); assert.equal(await readingHead.text(), '');
  assert.equal((await read(mf, 'https://rss.example/papers.html', { method: 'POST' })).status, 405);
  assert.equal((await read(mf, 'https://rss.example/feed.xml')).status, 200);
  const report = await (await read(mf, 'https://rss.example/status.json')).json();
  const after = await (await mf.dispatchFetch('https://rss.example/')).text();
  assert.match(after, new RegExp(`窗口内 ${report.itemCount} 条`));
  assert.doesNotMatch(after, /最近成功：尚无记录/);
  assert.match(after, /北京时间/);
  assert.match(after, /成功，1 条/);
  assert.match(after, /抓取失败/);
  assert.match(after, /摘要命中/);
  assert.doesNotMatch(after, /尚未开始抓取|HTTP 503/);
  assert.doesNotMatch(after, new RegExp(ACCESS_KEY));
  assert.equal(calls, firstCalls, 'viewing the dashboard only reads the saved snapshot');
  assert.equal((await mf.dispatchFetch(`https://rss.example/?key=${ACCESS_KEY}`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
});

test('the built reader script is credential-free, uses no storage on the Worker, and activates collection controls', async t => {
  const env = { FEED_STORE: { idFromName() { throw new Error('Static script touched storage'); } } };
  const response = await workerHandler.fetch(new Request('https://reader.example/reader.js'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/javascript; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const script = await response.text();
  assert.ok(!script.includes(ACCESS_KEY));
  const head = await workerHandler.fetch(new Request('https://reader.example/reader.js', { method: 'HEAD' }), env);
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await workerHandler.fetch(new Request('https://reader.example/reader.js', { method: 'POST' }), env)).status, 405);
  const dom = new JSDOM(renderReadingPage(readerPapers, readerOptions), { url: 'https://reader.example/papers.html', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.eval(script);
  assert.equal(dom.window.document.getElementById('reader-tools').hidden, false);
  dom.window.document.querySelector('[data-favorite-id]').click();
  assert.equal(dom.window.document.getElementById('favorite-count').textContent, '1');
});

test('public configuration page stays readable with missing or invalid keys and never touches storage', async () => {
  for (const key of [undefined, '', 'short', 'replace-with-a-random-64-character-hex-key', 'secret with spaces 012345678901234567890123456789']) {
    const env = { ACCESS_KEY: key, FEED_STORE: { idFromName() { throw new Error('Unconfigured overview touched storage'); } } };
    const response = await workerHandler.fetch(new Request('https://rss.example/'), env);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /抓取已暂停/);
    assert.match(body, key ? /ACCESS_KEY 格式不合规/ : /ACCESS_KEY 尚未配置/);
    assert.match(body, /点击“部署”/);
    if (key) assert.ok(!body.includes(key), 'configuration page must not echo the secret');
    const head = await workerHandler.fetch(new Request('https://rss.example/', { method: 'HEAD' }), env);
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
  }
});

test('public overview excludes raw errors, provider credentials and private subscription links', () => {
  const secretError = `upstream failed with private credential ${ACCESS_KEY}`;
  const report = { health: 'degraded', window: { from: '2026-08-27', to: '2026-10-27' },
    itemCount: 1, storedItemCount: 2, lastAttempt: '2026-10-27T00:00:00Z', lastSuccess: '2026-10-27T00:00:00Z',
    pages: [{ id: 'marc-melitz/publications', error: secretError }],
    providers: [{ id: 'crossref', matched: 1, missingAbstract: 2, error: secretError },
      { id: 'nber', matched: 0, missingAbstract: 0, abstractFeedError: secretError }] };
  const store = { report: () => report, env: { ACCESS_KEY } };
  const body = FeedStore.prototype.home.call(store, 'https://rss.example', true);
  assert.match(body, /抓取失败/); assert.match(body, /部分抓取失败/);
  assert.doesNotMatch(body, new RegExp(ACCESS_KEY));
  assert.doesNotMatch(body, /upstream failed|feed.xml\?key=|papers.html\?key=|feed.opml\?key=|status.json\?key=/);
  const privateBody = FeedStore.prototype.home.call(store, 'https://rss.example');
  assert.match(privateBody, new RegExp(`feed.xml\\?key=${ACCESS_KEY}`));
});

test('reusing the reader key as admin secret disables manual refresh', async t => {
  const mf = worker(() => { throw new Error('Disabled refresh crawled a source'); }, { REFRESH_TOKEN: ACCESS_KEY });
  t.after(() => mf.dispose());
  const response = await mf.dispatchFetch('https://private.example/refresh', { method: 'POST', headers: { Authorization: `Bearer ${ACCESS_KEY}` } });
  assert.equal(response.status, 404);
});


