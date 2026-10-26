import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sources from '../sources.json' with { type: 'json' };
import { cleanText, escapeXML, isPaperTitle, mergeItems, normalizeTitle, renderOPML, renderRSS, safeURL, validateSources } from '../src/feed.mjs';

const candidate = (overrides = {}) => ({ title: 'Trade, Management & Productivity', url: 'https://example.com/paper.pdf',
  researcher: 'Nicholas Bloom', pageID: 'nicholas-bloom/research', pageURL: 'https://example.com/research', position: 0, ...overrides });

test('configuration has exactly the requested six researchers in one file', () => {
  validateSources(sources);
  assert.deepEqual(sources.map(source => source.name), ['Marc Melitz', 'David Autor', 'David Dorn', 'Nicholas Bloom', 'John Van Reenen', 'Peter Klenow']);
  assert.throws(() => validateSources([...sources, sources[0]]), /duplicate/);
});

test('canonical titles and links handle markup, Unicode and query strings safely', () => {
  assert.equal(normalizeTitle('Trade—Management &amp; Productivity.'), normalizeTitle('Trade Management & Productivity'));
  assert.equal(cleanText('A\u200b &amp; B\u0001'), 'A & B');
  assert.equal(escapeXML('<A & "B">'), '&lt;A &amp; &quot;B&quot;&gt;');
  assert.equal(safeURL('javascript:alert(1)', 'https://example.com'), null);
  assert.equal(safeURL('/paper.pdf?rlkey=keep&utm_source=no#page=2', 'https://example.com'), 'https://example.com/paper.pdf?rlkey=keep');
  assert.ok(isPaperTitle('Disaster Management'), 'short real titles must not be discarded');
  assert.equal(isPaperTitle('Online Appendix'), false);
});

test('cross-homepage duplicate papers merge researchers and preserve first observation', async () => {
  const first = '2026-10-26T08:00:00.000Z'; const later = '2026-10-27T08:00:00.000Z';
  const initial = await mergeItems([], [candidate()], first);
  const merged = await mergeItems(initial.items, [candidate({ researcher: 'John Van Reenen',
    pageID: 'john-van-reenen/work-in-progress', url: 'https://another.example/paper.pdf' })], later);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].refs.length, 2);
  assert.equal(merged.items[0].firstSeen, first);
  assert.equal(merged.items[0].id, initial.items[0].id);
  assert.equal(merged.items[0].url, 'https://example.com/paper.pdf');
  const unchanged = await mergeItems(merged.items, [candidate()], later);
  assert.equal(unchanged.changed, false);
  assert.equal((await mergeItems(merged.items, [], later)).items.length, 1);
});

test('history retention keeps new papers, not only the initial batch', async () => {
  const old = await mergeItems([], [candidate()], '2026-10-25T08:00:00.000Z');
  const result = await mergeItems(old.items, [candidate({ title: 'Brand New Research on Productivity' })], '2026-10-26T08:00:00.000Z', 1);
  assert.equal(result.items[0].title, 'Brand New Research on Productivity');
});

test('RSS emits stable GUIDs, escaped XML and explicitly labeled observation dates', async () => {
  const { items } = await mergeItems([], [candidate()], '2026-10-26T08:00:00.000Z');
  const xml = renderRSS(items, { title: 'A & B', origin: 'https://rss.example', updatedAt: items[0].firstSeen });
  assert.match(xml, /<title>A &amp; B<\/title>/);
  assert.match(xml, /Trade, Management &amp; Productivity/);
  assert.match(xml, /urn:scholar-rss:[a-f0-9]{64}/);
  assert.match(xml, /<pubDate>Mon, 26 Oct 2026 08:00:00 GMT<\/pubDate>/);
  assert.match(xml, /not the paper&apos;s publication date/);
  assert.doesNotMatch(xml, /<dc:creator>/);
});

test('OPML imports a single combined feed, not six feeds', () => {
  const xml = renderOPML('https://rss.example', 'Combined feed');
  assert.equal((xml.match(/<outline /g) ?? []).length, 1);
  assert.match(xml, /xmlUrl="https:\/\/rss.example\/feed.xml"/);
  const privateXML = renderOPML('https://rss.example', 'Private feed', 'reader-secret-0123456789abcdef0123456789');
  assert.equal((privateXML.match(/<outline /g) ?? []).length, 1);
  assert.match(privateXML, /xmlUrl="https:\/\/rss.example\/feed.xml\?key=reader-secret-/);
});

test('one-click deployment requests the mandatory reader key, not an optional admin secret', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /\[!\[Deploy to Cloudflare\].*\]\(https:\/\/deploy\.workers\.cloudflare\.com\/\?url=https:\/\/github\.com\/jiandwei\/RSS\)/);
  const example = await readFile(new URL('../.dev.vars.example', import.meta.url), 'utf8');
  assert.deepEqual(example.split('\n').filter(line => line.trim() && !line.trim().startsWith('#')), ['ACCESS_KEY=']);
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.durable_objects.bindings[0].class_name, 'FeedStore');
  assert.deepEqual(config.migrations[0].new_sqlite_classes, ['FeedStore']);
  assert.deepEqual(config.triggers.crons, ['0 */6 * * *']);
  assert.equal(config.observability.logs.invocation_logs, false);
  assert.ok(!Object.hasOwn(config.vars, 'ACCESS_KEY'));
});

