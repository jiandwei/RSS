import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import worker, { FeedStore } from '../../dist/index.js';
import { readerOptions, readerPapers } from '../fixtures/reader.mjs';

// Use the production Worker router, CSP, serializer and browser script against a
// deterministic saved-state store. Native SQLite/crawling runs in worker.test.
test('Chrome: CSP-safe favorites, window-independent snapshots, Markdown download and responsive layout', { timeout: 60000 }, async t => {
  const executablePath = process.env.CHROME_BIN || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
  assert.ok(executablePath, 'Install Chrome/Chromium or set CHROME_BIN before running test:browser');
  let items = readerPapers.map(item => {
    const date = { ...item.date, value: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10), precision: 'day' };
    return { ...item, date, firstSeen: new Date().toISOString(), records: [{ ...item, date, kind: 'researcher', researcher: 'Example Researcher',
      groups: item.categories, pageURL: 'https://example.com/source', pageID: 'example/' + item.id }] };
  });
  const now = new Date().toISOString();
  const env = { ACCESS_KEY: readerOptions.accessKey, FEED_TITLE: '功能测试 · 示例论文（非实时抓取）' };
  const store = { env, getItems: () => items, report: () => ({ health: 'healthy' }),
    getMeta: name => ({ schema: '2', lastAttempt: now, scanSucceeded: '1', contentUpdatedAt: now })[name] };
  env.FEED_STORE = { idFromName: () => 'fixture', get: () => ({ fetch: (request, init) => FeedStore.prototype.fetch.call(store, new Request(request, init)) }) };
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    try {
      requests.push({ path: request.url, referer: request.headers.referer });
      const result = await worker.fetch(new Request('http://' + request.headers.host + request.url, { method: request.method, headers: request.headers }), env);
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    } catch { response.writeHead(500); response.end('Test server failure'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 1100 } });
  const page = await context.newPage(); const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const url = 'http://127.0.0.1:' + server.address().port + '/papers.html?key=' + readerOptions.accessKey;
  await page.goto(url);
  await page.waitForFunction(() => !document.getElementById('reader-tools').hidden);
  assert.equal(await page.locator('#papers-list article.paper').count(), 3);
  const asset = requests.find(request => request.path === '/reader.js');
  assert.ok(asset); assert.equal(asset.referer, undefined, 'reader credentials never travel in the script referrer');
  const requestsAfterLoad = requests.length;
  await page.locator('[data-paper-id="paper-a"] [data-favorite-id]').click();
  await page.locator('[data-paper-id="paper-b"] [data-favorite-id]').click();
  assert.equal(await page.locator('#favorite-count').textContent(), '2');
  const raw = await page.evaluate(() => localStorage.getItem('scholar-rss:favorites:v1'));
  assert.ok(!raw.includes(readerOptions.accessKey));
  await page.locator('#paper-search').fill('Panjiva');
  assert.equal(await page.locator('#papers-list article.paper').count(), 1);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-favorites').click()]);
  assert.match(download.suggestedFilename(), /^research-favorites-\d{4}-\d{2}-\d{2}\.md$/);
  const chunks = []; for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const markdown = Buffer.concat(chunks).toString('utf8');
  assert.match(markdown, /^# 研究论文收藏\n/);
  assert.match(markdown, /收藏数量：2/);
  assert.match(markdown, /Production Networks and Resilience/);
  assert.match(markdown, /Trade Finance with Customs Records/);
  assert.ok(!markdown.includes(readerOptions.accessKey));
  assert.equal(requests.length, requestsAfterLoad, 'favorite/search/download operations make no server requests');

  items = []; // A later feed snapshot no longer includes the saved papers.
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('reader-tools').hidden);
  assert.equal(await page.locator('#papers-list article.paper').count(), 0);
  await page.locator('#show-favorites').click();
  assert.equal(await page.locator('#papers-list article.paper').count(), 2);
  await page.locator('#database-filter').selectOption('factset-revere');
  assert.equal(await page.locator('#papers-list article.paper').count(), 1);
  await page.locator('#database-filter').selectOption('');
  const screenshotDir = process.env.READER_SCREENSHOT_DIR;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'horizontal overflow at ' + width);
    if (screenshotDir && [1280, 390].includes(width)) await page.screenshot({ path: join(screenshotDir, 'favorites-' + width + '.png'), fullPage: true });
  }
  await page.locator('.database-catalog summary').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'expanded aliases fit a narrow screen');
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('#reader-tools').evaluate(element => getComputedStyle(element).display), 'none');
  assert.equal(await page.locator('.favorite-button').first().evaluate(element => getComputedStyle(element).display), 'none');
  assert.deepEqual(pageErrors, []);
});
