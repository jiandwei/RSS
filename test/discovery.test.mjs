import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../sources.json' with { type: 'json' };
import { crossrefDate, dateWindow, inWindow, publicationDate, rssDate } from '../src/window.mjs';
import { abstractText, reconstructAbstract, supplyChainAbstract } from '../src/topic.mjs';
import { collectLiterature, dateResearcherPapers, metadataClient, readRSS } from '../src/discovery.mjs';

const window = dateWindow(new Date('2026-10-26T04:00:00Z'));
const d = config.discovery;
const dated = (value = '2026-10-10') => ({ value, precision: 'day', source: 'Publisher' });
function cache() {
  const entries = new Map();
  return { entries, get: (key, now) => entries.get(key)?.until > now ? entries.get(key).value : undefined,
    set: (key, value, until) => entries.set(key, { value, until }) };
}
const cr = (id, overrides = {}) => ({ DOI: `10.5555/${id}`, title: [`Paper about ${id}`], ISSN: ['0025-1909'],
  type: 'journal-article', author: [{ given: 'Nicholas', family: 'Bloom' }],
  'published-online': { 'date-parts': [[2026, 10, 10]] }, abstract: 'Supply chain finance evidence.', ...overrides });

test('rolling window uses two calendar months, inclusive boundaries, Shanghai date and clamped month ends', () => {
  assert.deepEqual(window, { from: '2026-08-26', to: '2026-10-26', months: 2, timeZone: 'Asia/Shanghai' });
  assert.equal(dateWindow(new Date('2026-10-26T17:00:00Z')).to, '2026-10-27');
  assert.equal(dateWindow(new Date('2026-04-30T00:00:00Z')).from, '2026-02-28');
  assert.equal(dateWindow(new Date('2024-04-30T00:00:00Z')).from, '2024-02-29');
  assert.ok(inWindow(dated('2026-08-26'), window)); assert.ok(inWindow(dated('2026-10-26'), window));
  assert.equal(inWindow(dated('2026-08-25'), window), false);
  assert.equal(inWindow(dated('2026-10-27'), window), false);
  assert.equal(inWindow(publicationDate([2026, 8], 'Publisher'), window), false, 'partial lower-bound month cannot prove recency');
  assert.ok(inWindow(publicationDate([2026, 9], 'Publisher'), window));
  assert.equal(publicationDate([2026], 'Publisher'), null);
  assert.equal(publicationDate([2026, 2, 30], 'Publisher'), null);
});

test('dates never use indexing/deposit/detection time or a recent print date for an old online DOI', () => {
  assert.equal(crossrefDate({ created: { 'date-parts': [[2026, 10, 26]] }, indexed: { 'date-parts': [[2026, 10, 26]] } }), null);
  const date = crossrefDate({ 'published-online': { 'date-parts': [[2025, 1, 1]] }, 'published-print': { 'date-parts': [[2026, 10, 1]] } });
  assert.equal(date.value, '2025-01-01'); assert.equal(inWindow(date, window), false);
  assert.equal(crossrefDate({ 'published-online': { 'date-parts': [[2025]] }, 'published-print': { 'date-parts': [[2026, 10, 1]] } }), null);
  assert.equal(rssDate('Thu, 15 Oct 2026 00:00:00 +0100').value, '2026-10-15');
  assert.equal(rssDate('not a date'), null);
});

test('abstract-only matching handles JATS, plurals, hyphens, Unicode, Chinese and inverted indexes', () => {
  for (const abstract of ['<jats:p>We study supply <i>chain</i> finance.</jats:p>', 'SUPPLY-CHAINS are important.',
    'Supply\u2011chain disruption.', 'Supply&nbsp;chain risks.', '供应链金融的研究']) assert.ok(supplyChainAbstract(abstract));
  assert.equal(supplyChainAbstract('This abstract studies banking.'), false);
  assert.equal(supplyChainAbstract(''), false);
  assert.equal(abstractText('&lt;p&gt;Abstract: Supply chain.&lt;/p&gt;'), 'Supply chain.');
  assert.equal(reconstructAbstract({ chains: [2], Supply: [0], resilient: [1] }), 'Supply resilient chains');
});

test('publisher RSS preserves calendar pubDate and complete dc:creator without inventing missing dates', () => {
  const records = readRSS('<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>Networks &amp; Credit</title><link>https://example.com/paper</link><description><![CDATA[<p>Supply chain finance.</p>]]></description><dc:creator>Jane Doe</dc:creator><dc:creator>John Smith</dc:creator><pubDate>Thu, 15 Oct 2026 00:00:00 +0100</pubDate></item><item><title>No date available</title><link>https://example.com/other</link></item></channel></rss>');
  assert.deepEqual(records[0].authors, ['Jane Doe', 'John Smith']); assert.equal(records[0].date.value, '2026-10-15');
  assert.equal(records[0].abstract, 'Supply chain finance.'); assert.equal(records[1].date, null);
  assert.throws(() => readRSS('<html>blocked</html>'), /RSS/);
});

test('bounded collector paginates Crossref and CEPR, validates journal scope, enriches exact DOIs and reports gaps', async () => {
  let crossrefPages = 0; let ceprPages = 0; let supplementPages = 0;
  const missing = cr('missing', { abstract: undefined });
  const titleOnly = cr('title-only', { title: ['Supply Chain in Title'], abstract: 'Employment evidence.' });
  const nber = { ...cr('nber', { abstract: undefined }), DOI: '10.3386/w12345', ISSN: [], type: 'report' };
  const rss = items => `<rss><channel>${items.map(i => `<item><title>${i.title}</title><link>${i.url}</link><description><![CDATA[${i.abstract ?? ''}]]></description>${i.date ? `<pubDate>${i.date}</pubDate>` : ''}</item>`).join('')}</channel></rss>`;
  const client = { errors: [],
    async request(url, format) {
      url = new URL(url);
      if (url.hostname === 'api.crossref.org') {
        assert.match(url.searchParams.get('filter'), /from-pub-date:2026-08-26/);
        if (url.pathname.includes('/prefixes/')) return { message: { items: [nber], 'total-results': 1 } };
        assert.ok((url.searchParams.get('filter').match(/issn:/g) ?? []).length >= 51, 'one OR query, not 51 separate requests');
        crossrefPages++;
        return { message: { items: crossrefPages === 1 ? [cr('positive'), missing, titleOnly] : [
          cr('outside', { ISSN: ['9999-9999'] }), cr('undated', { 'published-online': null }),
          cr('expired', { 'published-online': { 'date-parts': [[2025, 10, 10]] } })], 'total-results': 6, 'next-cursor': 'second-page' } };
      }
      if (url.hostname === 'api.openalex.org') {
        supplementPages++;
        return { results: [{ id: 'https://openalex.org/W123', doi: null, type: 'article', title: 'Practitioner Paper About Trade',
          publication_date: '2026-10-11', primary_location: { source: { issn: ['0017-8012'] }, landing_page_url: 'https://hbr.org/paper' },
          abstract_inverted_index: { Supply: [0], chain: [1], evidence: [2] } }], meta: { count: 1, next_cursor: null } };
      }
      assert.equal(format, 'xml');
      if (url.hostname === 'back.nber.org') return rss([{ title: 'NBER title', url: 'https://www.nber.org/papers/w12345#fromrss', abstract: 'Supply-chain credit evidence.' }]);
      ceprPages++;
      return rss([{ title: `Discussion ${ceprPages}`, url: `https://cepr.org/publications/dp${ceprPages}`, abstract: 'Supply chain research.',
        date: ceprPages === 1 ? 'Mon, 26 Oct 2026 00:00:00 +0000' : 'Mon, 20 Jul 2026 00:00:00 +0000' }]);
    },
    async abstracts(records) {
      for (const record of records) if (record.doi === missing.DOI) { record.abstract = 'Supply chain evidence supplemented.'; record.abstractSource = 'OpenAlex (DOI matched)'; }
    }
  };
  const result = await collectLiterature(d, client, window);
  assert.equal(crossrefPages, 2); assert.equal(ceprPages, 2); assert.equal(supplementPages, 1);
  assert.equal(result.incoming.length, 5); // Crossref + supplemented + NBER + CEPR + non-DOI HBR.
  assert.ok(result.incoming.some(r => r.doi === nber.DOI && r.date.value === '2026-10-10'));
  assert.ok(result.incoming.some(r => r.journal === 'Harvard Business Review' && !r.doi));
  assert.ok(!result.incoming.some(r => /Title|outside|expired|undated|Discussion 2/.test(r.title)));
  assert.equal(result.statuses[0].missingDate, 1); assert.ok(result.statuses.every(s => s.complete));
});

test('metadata client caches missing abstracts, matches exact DOIs and keeps API secrets out of URLs', async () => {
  const cached = cache(); let calls = 0;
  const client = metadataClient(d, { OPENALEX_API_KEY: 'private-openalex-key' }, cached, Date.now(), async (url, init) => {
    calls++; assert.ok(!String(url).includes('private-openalex-key'));
    assert.equal(init.headers.Authorization, 'Bearer private-openalex-key');
    return Response.json({ results: [
      { doi: 'https://doi.org/10.5555/right', abstract_inverted_index: { Supply: [0], chain: [1], risks: [2] } },
      { doi: 'https://doi.org/10.5555/wrong', abstract_inverted_index: { Supply: [0], chain: [1] } }
    ] });
  }, 0);
  const records = [{ doi: '10.5555/right' }, { doi: '10.5555/absent' }];
  await client.abstracts(records);
  assert.equal(records[0].abstract, 'Supply chain risks'); assert.equal(records[1].abstract, undefined);
  await client.abstracts([{ doi: '10.5555/right' }, { doi: '10.5555/absent' }]); assert.equal(calls, 1);
  assert.equal(cached.get('abstract:10.5555/absent', Date.now()), '', 'negative cached without borrowing another DOI abstract');
  const exhausted = metadataClient({ ...d, limits: { ...d.limits, requests: 1 } }, {}, cached, Date.now(), () => { throw Error('Must not fetch'); }, 1);
  await assert.rejects(() => exhausted.request('https://api.crossref.org/works'), /budget/);
});

test('database-name admission still enforces the journal whitelist, abstract requirement and publication window', async () => {
  const works = [
    cr('database', { abstract: 'We use FactSet Revere to study firm linkages.' }),
    cr('finance', { abstract: 'FactSet analyst forecasts explain earnings.' }),
    cr('title-database', { title: ['Using FactSet Revere'], abstract: 'Employment evidence.' }),
    cr('missing-abstract', { abstract: undefined }),
    cr('missing-date', { abstract: 'Panjiva customs records.', 'published-online': undefined }),
    cr('old-database', { abstract: 'Panjiva customs records.', 'published-online': { 'date-parts': [[2024, 1, 1]] } }),
    cr('outside-database', { abstract: 'Panjiva customs records.', ISSN: ['9999-9999'] })
  ];
  const client = { errors: [], async abstracts() {}, async request(url, format) {
    url = new URL(url);
    if (format === 'xml') return '<rss><channel></channel></rss>';
    if (url.hostname === 'api.openalex.org') return { results: [], meta: { count: 0 } };
    const items = url.pathname.includes('/prefixes/') ? [] : works;
    return { message: { items, 'total-results': items.length } };
  } };
  const result = await collectLiterature(d, client, window);
  assert.deepEqual(result.incoming.map(record => record.doi), ['10.5555/database']);
  assert.equal(result.statuses[0].missingAbstract, 1);
  assert.equal(result.statuses[0].missingDate, 1);
});

test('metadata redirects stay within HTTPS site aliases, consume budget and never leak API keys', async () => {
  const calls = [];
  const client = metadataClient(d, { OPENALEX_API_KEY: 'private-key' }, cache(), Date.now(), async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    return calls.length === 1 ? new Response(null, { status: 301, headers: { Location: 'https://www.api.openalex.org/works' } }) : Response.json({ results: [] });
  }, 0);
  await client.request('https://api.openalex.org/works');
  assert.equal(client.requests, 2); assert.equal(calls[0].auth, 'Bearer private-key'); assert.equal(calls[1].auth, undefined);
  let unsafeCalls = 0;
  const unsafe = metadataClient(d, {}, cache(), Date.now(), async () => {
    unsafeCalls++; return new Response(null, { status: 302, headers: { Location: 'https://different.example/steal' } });
  }, 0);
  await assert.rejects(() => unsafe.request('https://api.openalex.org/works'), /HTTP 302/); assert.equal(unsafeCalls, 1);
});

test('scholar dates require exact titles and author identity; missing/old dates never become crawl dates', async () => {
  const candidates = ['Exact Title', 'Missing Date', 'Old Paper', 'Other Person'].map((title, position) => ({ title,
    researcher: 'Nicholas Bloom', pageID: 'nicholas-bloom/research', pageURL: 'https://example.com', url: `https://example.com/${position}`, position }));
  const corpus = [
    { title: 'Exact Title', authors: ['Nicholas Bloom'], date: dated(), doi: '10.5555/exact' },
    { title: 'Missing Date', authors: ['Nicholas Bloom'], date: null },
    { title: 'Old Paper', authors: ['Nicholas Bloom'], date: dated('2025-01-01') }
  ];
  const client = { remaining: 10, request: async () => ({ message: { items: [cr('other', { title: ['Other Person'], author: [{ given: 'William', family: 'Bloom' }] })] } }) };
  const result = await dateResearcherPapers(candidates, corpus, d, client, cache(), Date.now(), window);
  assert.equal(result.incoming.length, 1); assert.equal(result.incoming[0].title, 'Exact Title');
  assert.equal(result.status.missingDate, 2); assert.equal(result.status.outsideWindow, 1);
});
