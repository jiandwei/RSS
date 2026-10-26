import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';

// Tiny hand-written fixtures model each site's relevant structure. Real source
// downloads are deliberately not committed. Integration runs native workerd,
// HTMLRewriter and SQLite Durable Objects, not a mocked HTML parser or database.
function fixture(url, revised = false) {
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
    bindings: { REFRESH_TOKEN: 'test-long-secret', MAX_FEED_ITEMS: '200', ...extra },
    outboundService
  });
}

test('one real Worker feed: cold-start lock, deduplication, failures, validators and authenticated refresh', async t => {
  let calls = 0; let broken = false; let revised = false;
  const mf = worker(request => { calls++; return broken ? new Response('blocked', { status: 403 }) : fixture(new URL(request.url), revised); });
  t.after(() => mf.dispose());
  const rssURL = 'https://rss.example/feed.xml';
  const [a, b] = await Promise.all([mf.dispatchFetch(rssURL), mf.dispatchFetch(rssURL)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const xml = await a.text();
  assert.equal(calls, 8, 'concurrent first readers share one eight-page crawl');
  assert.equal((xml.match(/<item>/g) ?? []).length, 5);
  assert.equal((xml.match(/<title>Management and Firm Dynamism<\/title>/g) ?? []).length, 1);
  assert.match(xml, /<category>Nicholas Bloom<\/category>/);
  assert.match(xml, /<category>John Van Reenen<\/category>/);
  assert.doesNotMatch(xml, /Online Appendix|Updated slides|Management data|Quarterly Data/);
  assert.equal(a.headers.get('X-Feed-Health'), 'degraded');
  let report = await (await mf.dispatchFetch('https://rss.example/status.json')).json();
  assert.equal(report.researcherCount, 6);
  assert.equal(report.pages.filter(page => page.error).length, 1);
  assert.equal(report.pages.find(page => page.id.startsWith('peter-klenow')).error, 'HTTP 503');

  const notModified = await mf.dispatchFetch(rssURL, { headers: { 'If-None-Match': 'W/' + a.headers.get('ETag') } });
  assert.equal(notModified.status, 304);
  assert.equal(calls, 8);
  const head = await mf.dispatchFetch(rssURL, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await mf.dispatchFetch(rssURL, { method: 'POST' })).status, 405);
  assert.equal((await mf.dispatchFetch('https://rss.example/feeds/david-autor.xml')).status, 404);
  const opml = await (await mf.dispatchFetch('https://rss.example/feed.opml')).text();
  assert.equal((opml.match(/<outline /g) ?? []).length, 1);
  assert.equal((await mf.dispatchFetch('https://rss.example/refresh', { method: 'POST' })).status, 401);
  assert.equal(calls, 8, 'unauthenticated refresh never fetches upstream pages');

  const refresh = () => mf.dispatchFetch('https://rss.example/refresh', { method: 'POST', headers: { Authorization: 'Bearer test-long-secret' } });
  const guid = xml.match(/urn:scholar-rss:[a-f0-9]+/)[0];
  await refresh();
  assert.equal((await mf.dispatchFetch(rssURL)).headers.get('ETag'), a.headers.get('ETag'), 'unchanged pages keep the same ETag');
  revised = true;
  await refresh();
  assert.match(await (await mf.dispatchFetch(rssURL)).text(), /A New Theory of Innovation/);
  broken = true;
  report = await (await refresh()).json();
  assert.equal(report.pages.filter(page => page.error).length, 8);
  const stale = await mf.dispatchFetch(rssURL);
  assert.equal(stale.status, 200);
  assert.match(await stale.text(), new RegExp(guid), 'upstream failure never deletes previous papers');
});

test('all failed sources produce an honest 503 with retry backoff, not a fake feed', async t => {
  let calls = 0;
  const mf = worker(() => { calls++; return new Response('<html>No papers here</html>', { headers: { 'Content-Type': 'text/html' } }); });
  t.after(() => mf.dispose());
  assert.equal((await mf.dispatchFetch('https://empty.example/feed.xml')).status, 503);
  assert.equal(calls, 8);
  assert.equal((await mf.dispatchFetch('https://empty.example/feed.xml')).status, 503);
  assert.equal(calls, 8);
  const report = await (await mf.dispatchFetch('https://empty.example/status.json')).json();
  assert.ok(report.pages.every(page => page.error.includes('No papers extracted')));
});

test('refresh endpoint is absent when no secret has been configured', async t => {
  const mf = worker(request => fixture(new URL(request.url)), { REFRESH_TOKEN: '' });
  t.after(() => mf.dispose());
  assert.equal((await mf.dispatchFetch('https://rss.example/refresh', { method: 'POST' })).status, 404);
});

