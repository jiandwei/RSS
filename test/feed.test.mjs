import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import config from '../sources.json' with { type: 'json' };
import { XMLParser, XMLValidator } from 'fast-xml-parser';
const sources = config.researchers;
const window = { from: '2026-08-26', to: '2026-10-26', timeZone: 'Asia/Shanghai' };
import { cleanText, escapeXML, isPaperTitle, mergeItems, feedItems, normalizeTitle, renderOPML, renderRSS, safeURL, validateSources } from '../src/feed.mjs';

const candidate = (overrides = {}) => ({ title: 'Trade, Management & Productivity', url: 'https://example.com/paper.pdf',
  researcher: 'Nicholas Bloom', pageID: 'nicholas-bloom/research', pageURL: 'https://example.com/research', position: 0, kind: 'researcher', date: { value: '2026-10-20', precision: 'day', source: 'Publisher' }, authors: ['Nicholas Bloom'], ...overrides });

test('configuration has exactly the requested six researchers in one file', () => {
  validateSources(config);
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

test('RSS emits stable GUIDs, actual publication dates and metadata authors', async () => {
  const { items } = await mergeItems([], [candidate()], '2026-10-26T08:00:00.000Z');
  const xml = renderRSS(feedItems(items, window), { window, title: 'A & B', origin: 'https://rss.example', updatedAt: items[0].firstSeen });
  assert.match(xml, /<title>A &amp; B<\/title>/);
  assert.match(xml, /Trade, Management &amp; Productivity/);
  assert.match(xml, /urn:scholar-rss:[a-f0-9]{64}/);
  assert.match(xml, /<pubDate>Tue, 20 Oct 2026 00:00:00 GMT<\/pubDate>/);
  const description = new XMLParser().parse(xml).rss.channel.item.description;
  assert.match(description, /发表日期/);
  assert.match(description, /2026-10-20/);
  assert.match(xml, /<dc:creator>Nicholas Bloom<\/dc:creator>/);
});

test('formatted RSS descriptions preserve safe HTML and linked metadata after one XML parse', async () => {
  const { items } = await mergeItems([], [candidate({
    title: 'Safe Paper on Production Networks', doi: '10.5555/networks',
    authors: ['A. Researcher & B. Author'], journal: 'Journal of Trade & Networks',
    abstract: 'First paragraph about trade.\n\nSecond paragraph: <img src=x onerror=alert(1)> &lt;script&gt;alert(1)&lt;/script&gt; ]]>',
    abstractSource: 'Publisher <script>untrusted</script>', pageURL: 'https://example.com/research?a=1&b=2'
  })], '2026-10-26T08:00:00Z');
  const visible = feedItems(items, window);
  visible[0].records.push({ ...visible[0].records[0], pageURL: 'javascript:alert(1)', url: 'data:text/html,bad', researcher: 'Bad link' });
  const xml = renderRSS(visible, { window, title: 'Research', origin: 'https://rss.example', updatedAt: items[0].firstSeen });
  assert.equal(XMLValidator.validate(xml), true);
  const item = new XMLParser().parse(xml).rss.channel.item;
  assert.equal(item['dc:creator'], 'A. Researcher & B. Author');
  assert.match(item.description, /<table[^>]*>/);
  assert.match(item.description, /<h3[^>]*>摘要<\/h3>/);
  assert.match(item.description, /<\/p><p[^>]*>Second paragraph/);
  assert.match(item.description, /href="https:\/\/doi.org\/10.5555\/networks"/);
  assert.match(item.description, /href="https:\/\/example.com\/research\?a=1&amp;b=2"/);
  assert.match(item.description, /&lt;img/);
  assert.match(item.description, /&lt;script&gt;/);
  assert.doesNotMatch(item.description, /<script\b|<img\b|href="(?:javascript|data):/i);
});

test('OPML imports a single combined feed, not six feeds', () => {
  const xml = renderOPML('https://rss.example', 'Combined feed');
  assert.equal((xml.match(/<outline /g) ?? []).length, 1);
  assert.match(xml, /xmlUrl="https:\/\/rss.example\/feed.xml"/);
  const privateXML = renderOPML('https://rss.example', 'Private feed', 'reader-secret-0123456789abcdef0123456789');
  assert.equal((privateXML.match(/<outline /g) ?? []).length, 1);
  assert.match(privateXML, /xmlUrl="https:\/\/rss.example\/feed.xml\?key=reader-secret-/);
});

test('database-only abstract matches survive feed selection and appear as RSS categories and metadata', async () => {
  const { items } = await mergeItems([], [candidate({ kind: 'literature', researcher: null, groups: ['FT50'],
    abstract: 'We use FactSet Revere to examine production networks.', pageID: 'discovery/journals' })], '2026-10-26T08:00:00Z');
  const visible = feedItems(items, window);
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0].databases, [{ id: 'factset-revere', name: 'FactSet Revere' }]);
  const xml = renderRSS(visible, { window, title: 'Research', origin: 'https://rss.example', updatedAt: items[0].firstSeen });
  assert.match(xml, /<category>FactSet Revere<\/category>/);
  const parsed = new XMLParser().parse(xml);
  assert.match(parsed.rss.channel.item.description, /摘要提及/);
  assert.match(parsed.rss.channel.item.description, /FactSet Revere/);
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


test('journal list is UTD24 plus current FT50 with correct overlap', () => {
  assert.equal(config.discovery.journals.length, 51);
  const group = name => config.discovery.journals.filter(j => j.groups.includes(name));
  assert.equal(group('UTD24').length, 24); assert.equal(group('FT50').length, 50);
  assert.ok(group('UTD24').some(j => j.name === 'Journal of International Business Studies'));
  assert.ok(!group('UTD24').some(j => j.name === 'Journal of Management Information Systems'));
  assert.ok(group('FT50').some(j => j.name === 'Psychological Science'));
  assert.ok(!group('FT50').some(j => j.name === 'Journal of Business Ethics'));
  assert.throws(() => validateSources({ ...config, discovery: { ...config.discovery, limits: { ...config.discovery.limits, requests: 1000 } } }), /limit/);
});

test('one DOI joins alternate titles, eligible versions determine categories, expired/legacy data stays hidden', async () => {
  const a = candidate({ doi: '10.5555/paper', kind: 'literature', researcher: null, groups: ['UTD24', 'FT50'],
    abstract: 'We study supply chain risks.', pageID: 'discovery/journals' });
  const first = await mergeItems([], [a], '2026-10-26T00:00:00Z');
  const both = await mergeItems(first.items, [candidate({ title: 'An Alternate Published Title', doi: a.doi })], '2026-10-26T01:00:00Z');
  assert.equal(both.items.length, 1); assert.equal(both.items[0].id, first.items[0].id);
  assert.deepEqual(new Set(feedItems(both.items, window)[0].categories), new Set(['UTD24', 'FT50', 'Nicholas Bloom']));
  assert.equal(feedItems(both.items, { ...window, from: '2026-10-21' }).length, 0, 'expiry is checked when reading, without a new crawl');
  assert.equal(feedItems([{ id: 'legacy', firstSeen: '2026-10-26', title: 'Old paper detected today' }], window).length, 0);
  const titleOnly = await mergeItems([], [candidate({ kind: 'literature', title: 'Supply Chain Management and Finance', abstract: 'Banking evidence.', date: a.date })], '2026-10-26T00:00:00Z');
  assert.equal(feedItems(titleOnly.items, window).length, 0);
});

