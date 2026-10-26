import { XMLParser } from 'fast-xml-parser';
import { cleanText, normalizeTitle, safeURL } from './feed.mjs';
import { abstractText, reconstructAbstract, supplyChainAbstract } from './topic.mjs';
import { crossrefDate, inWindow, rssDate } from './window.mjs';

const DAY = 86400000;
const text = value => typeof value === 'string' ? value : value?.['#text'] ?? '';
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const xml = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, processEntities: false,
  parseTagValue: false, trimValues: true });
export function doiOf(value) {
  const doi = cleanText(String(value ?? '')).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : null;
}

export function crossrefRecord(work, scope) {
  const doi = doiOf(work.DOI);
  const title = abstractText(array(work.title)[0]);
  if (!doi || !title) return null;
  return {
    title, doi, url: scope === 'NBER' ? `https://www.nber.org/papers/${doi.split('/')[1]}` : `https://doi.org/${doi}`,
    date: crossrefDate(work), abstract: abstractText(work.abstract),
    abstractSource: work.abstract ? 'Crossref (publisher metadata)' : null,
    authors: array(work.author).map(a => cleanText([a.given, a.family || a.name].filter(Boolean).join(' '))).filter(Boolean),
    issns: array(work.ISSN), journal: cleanText(array(work['container-title'])[0] ?? ''),
    pageID: scope === 'NBER' ? 'discovery/nber' : 'discovery/journals',
    pageURL: scope === 'NBER' ? 'https://www.nber.org/papers' : `https://doi.org/${doi}`,
    kind: 'literature', groups: scope === 'NBER' ? ['NBER'] : [], position: 0
  };
}

export function readRSS(body) {
  const parsed = xml.parse(body);
  if (!parsed?.rss?.channel) throw new Error('Expected RSS channel');
  return array(parsed.rss.channel.item).map(item => ({
    title: abstractText(text(item.title)), url: safeURL(cleanText(text(item.link))),
    abstract: abstractText(text(item.description)), date: rssDate(text(item.pubDate)),
    authors: array(item.creator).map(a => cleanText(text(a))).filter(Boolean)
  })).filter(item => item.title && item.url);
}

// All crawling shares a strict subrequest budget, including the eight researcher pages.
// Cache only metadata, never credentials. Missing abstracts are retried the next day.
export function metadataClient(config, env, cache, now = Date.now(), fetcher = fetch, reservedRequests = 8) {
  let requests = reservedRequests;
  let lastRequest = 0;
  const errors = [];
  const client = {
    get requests() { return requests; }, errors,
    get remaining() { return Math.max(0, config.limits.requests - requests); },
    async request(url, format = 'json') {
      if (requests >= config.limits.requests) throw new Error('Refresh request budget exhausted');
      if (Date.now() - now > 90_000) throw new Error('Refresh time budget exhausted');
      const pause = 250 - (Date.now() - lastRequest);
      if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause));
      lastRequest = Date.now();
      requests++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        url = new URL(url);
        if (url.origin === new URL(config.crossref).origin && env.CROSSREF_MAILTO) url.searchParams.set('mailto', env.CROSSREF_MAILTO);
        const headers = {
          'User-Agent': 'ScholarRSS/2.0 (six-hour research metadata refresh)',
          Accept: format === 'json' ? 'application/json' : 'application/rss+xml,application/xml;q=0.9'
        };
        if (url.origin === new URL(config.openalex).origin && env.OPENALEX_API_KEY) headers.Authorization = `Bearer ${env.OPENALEX_API_KEY}`;
        let response;
        const send = async () => {
          try { return await fetcher(url, { signal: controller.signal, redirect: 'manual', headers }); }
          catch { throw new Error('Metadata network request failed or timed out'); }
        };
        response = await send();
        if ([301, 302, 303, 307, 308].includes(response.status) && client.remaining) {
          const location = response.headers.get('Location');
          const target = location ? new URL(location, url) : null;
          // Follow only HTTPS redirects within the same site (including www aliases).
          // Never forward an API credential to a different origin.
          if (target && target.protocol === 'https:' && target.port === url.port &&
              target.hostname.replace(/^www\./, '') === url.hostname.replace(/^www\./, '')) {
            await response.body?.cancel();
            if (target.origin !== url.origin) delete headers.Authorization;
            url = target; requests++; lastRequest = Date.now(); response = await send();
          }
        }
        if (response.status === 429 && client.remaining && Date.now() - now < 85_000) {
          await response.body?.cancel(); await new Promise(resolve => setTimeout(resolve, 1500));
          requests++; lastRequest = Date.now(); response = await send();
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
        const reader = response.body.getReader(); const decoder = new TextDecoder();
        let body = ''; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > 12_000_000) throw new Error('Metadata response exceeds 12 MB');
            body += decoder.decode(value, { stream: true });
          }
          body += decoder.decode();
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        if (format === 'xml') return body;
        try { return JSON.parse(body); } catch { throw new Error('Invalid metadata JSON'); }
      } finally { clearTimeout(timer); }
    },
    async cached(key, ttl, callback) {
      const found = cache.get(key, now);
      if (found !== undefined) return found;
      const value = await callback(); cache.set(key, value, now + ttl); return value;
    },
    async abstracts(records) {
      const missing = new Map();
      for (const record of records) {
        if (record.abstract || !record.doi) continue;
        const cached = cache.get(`abstract:${record.doi}`, now);
        if (cached !== undefined) { record.abstract = cached; record.abstractSource = cached ? 'OpenAlex (DOI matched)' : null; }
        else missing.set(record.doi, null);
      }
      const dois = [...missing.keys()];
      for (let start = 0; start < dois.length; start += config.limits.openalexBatch) {
        // Reserve requests for author date checks; unprocessed abstracts stay pending, not negative-cached.
        if (client.remaining <= config.limits.authorLookups) {
          errors.push({ provider: 'openalex', error: 'Request budget: some abstracts deferred' }); break;
        }
        const batch = dois.slice(start, start + config.limits.openalexBatch);
        const url = new URL(config.openalex);
        url.searchParams.set('filter', `doi:${batch.join('|')}`);
        url.searchParams.set('per_page', '100');
        url.searchParams.set('select', 'doi,abstract_inverted_index');
        try {
          const data = await client.request(url);
          if (!Array.isArray(data.results)) throw new Error('Invalid OpenAlex results');
          const found = new Map(data.results.map(w => [doiOf(w.doi), reconstructAbstract(w.abstract_inverted_index)]));
          for (const doi of batch) {
            const abstract = found.get(doi) ?? '';
            missing.set(doi, abstract); cache.set(`abstract:${doi}`, abstract, now + (abstract ? 7 * DAY : DAY));
          }
        } catch (error) {
          errors.push({ provider: 'openalex', error: error.message }); break; // Do not hammer a limited/free API.
        }
      }
      for (const record of records) if (!record.abstract && missing.get(record.doi)) {
        record.abstract = missing.get(record.doi); record.abstractSource = 'OpenAlex (DOI matched)';
      }
    }
  };
  return client;
}

const report = id => ({ id, scanned: 0, recent: 0, matched: 0, missingAbstract: 0, missingDate: 0,
  outsideWindow: 0, pages: 0, complete: false, error: null });

async function crossrefPages(client, url, maxPages, status) {
  const works = []; const seen = new Set(); let cursor = '*';
  for (let page = 0; page < maxPages; page++) {
    url.searchParams.set('cursor', cursor);
    try {
      const data = await client.request(url);
      if (!Array.isArray(data.message?.items)) throw new Error('Invalid Crossref results');
      status.pages++; status.totalResults = data.message['total-results'];
      const items = data.message.items;
      for (const item of items) {
        const doi = doiOf(item.DOI); if (!doi || seen.has(doi)) continue;
        seen.add(doi); works.push(item);
      }
      if (!items.length || seen.size >= status.totalResults) { status.complete = true; break; }
      const next = data.message['next-cursor'];
      if (!next) { status.error = 'Crossref pagination cursor missing'; break; }
      // Crossref cursor strings may remain identical while the server advances the snapshot.
      cursor = next;
    } catch (error) { status.error = error.message; break; }
  }
  if (!status.complete && !status.error) status.error = 'Crossref page limit reached; coverage is partial';
  return works;
}

export async function collectLiterature(config, client, window) {
  const journals = report('journals'); const nber = report('nber'); const cepr = report('cepr');
  const statuses = [journals, nber, cepr]; const corpus = [];
  const issns = new Map(config.journals.flatMap(j => j.issns.map(issn => [issn, j])));
  const baseFilter = [`from-pub-date:${window.from}`, `until-pub-date:${window.to}`];
  const fields = 'DOI,title,abstract,ISSN,container-title,author,published-online,published-print,published,issued,type';
  const journalURL = new URL('/works', config.crossref);
  journalURL.searchParams.set('filter', [...[...issns.keys()].map(issn => `issn:${issn}`), ...baseFilter, 'type:journal-article'].join(','));
  journalURL.searchParams.set('rows', String(config.limits.rows)); journalURL.searchParams.set('select', fields);
  for (const work of await crossrefPages(client, journalURL, config.limits.crossrefJournalPages, journals)) {
    const matches = array(work.ISSN).map(issn => issns.get(issn)).filter(Boolean);
    if (!matches.length || work.type !== 'journal-article') continue;
    const record = crossrefRecord(work, 'journals'); if (!record) continue;
    record.groups = [...new Set(matches.flatMap(j => j.groups))];
    record.journal = matches[0].name; corpus.push(record);
  }
  const nberURL = new URL(`/prefixes/${config.nber.prefix}/works`, config.crossref);
  nberURL.searchParams.set('filter', baseFilter.join(',')); nberURL.searchParams.set('rows', String(config.limits.rows));
  nberURL.searchParams.set('select', fields);
  for (const work of await crossrefPages(client, nberURL, config.limits.crossrefNBERPages, nber)) {
    if (!/^10\.3386\/[wt]\d+$/i.test(work.DOI ?? '')) continue;
    const record = crossrefRecord(work, 'NBER'); if (record) corpus.push(record);
  }
  // Some practitioner journals (notably HBR) have little/no Crossref DOI coverage.
  // Supplement only journals with zero recent Crossref records; validate returned ISSNs again.
  const absent = config.journals.filter(j => !corpus.some(r => r.journal === j.name && inWindow(r.date, window)));
  journals.openalexSupplement = { journals: absent.map(j => j.name), pages: 0, complete: !absent.length, error: null };
  if (absent.length) {
    let cursor = '*'; const supplement = journals.openalexSupplement;
    const known = new Set(corpus.map(r => r.doi).filter(Boolean));
    for (let page = 0; page < 3; page++) {
      const url = new URL(config.openalex);
      url.searchParams.set('filter', `primary_location.source.issn:${absent.map(j => j.issns[0]).join('|')},from_publication_date:${window.from},to_publication_date:${window.to}`);
      url.searchParams.set('per_page', '100'); url.searchParams.set('cursor', cursor);
      url.searchParams.set('select', 'id,doi,title,type,publication_date,authorships,primary_location,abstract_inverted_index');
      try {
        const data = await client.request(url); supplement.pages++;
        if (!Array.isArray(data.results)) throw new Error('Invalid OpenAlex journal results');
        for (const work of data.results) {
          if (!['article', 'journal-article', 'review'].includes(work.type)) continue;
          const matches = array(work.primary_location?.source?.issn).map(i => issns.get(i)).filter(Boolean);
          const journal = matches.find(j => absent.some(a => a.name === j.name));
          if (!journal) continue;
          const doi = doiOf(work.doi); if (doi && known.has(doi)) continue;
          const link = safeURL(work.primary_location?.landing_page_url) ?? (doi ? `https://doi.org/${doi}` : safeURL(work.id));
          if (!work.title || !link) continue;
          const abstract = reconstructAbstract(work.abstract_inverted_index);
          const date = rssDate(work.publication_date); if (date) date.source = 'OpenAlex publication_date';
          corpus.push({ title: abstractText(work.title), doi, url: link, date, abstract,
            abstractSource: abstract ? 'OpenAlex journal metadata' : null,
            authors: array(work.authorships).map(a => cleanText(a.author?.display_name ?? '')).filter(Boolean),
            journal: journal.name, groups: journal.groups, kind: 'literature', pageID: 'discovery/journals',
            pageURL: link, position: 0 });
          if (doi) known.add(doi);
        }
        cursor = data.meta?.next_cursor;
        if (!data.results.length || !cursor || (page + 1) * 100 >= data.meta?.count) { supplement.complete = true; break; }
      } catch (error) { supplement.error = error.message; break; }
    }
    if (!supplement.complete) {
      supplement.error ??= 'OpenAlex supplement page limit reached';
      client.errors.push({ provider: 'openalex-journals', error: supplement.error });
    }
  }
  // NBER's weekly RSS has abstracts but no pubDate. Join by paper number; use Crossref's publication date.
  try {
    const abstracts = new Map(readRSS(await client.request(config.nber.feedURL, 'xml')).map(item =>
      [new URL(item.url).pathname.match(/\/papers\/([wt]\d+)/)?.[1], item.abstract]));
    for (const record of corpus) if (record.groups.includes('NBER') && abstracts.get(record.doi.split('/')[1])) {
      record.abstract = abstracts.get(record.doi.split('/')[1]); record.abstractSource = 'NBER official RSS';
    }
  } catch (error) { nber.abstractFeedError = error.message; }

  const ceprSeen = new Set();
  for (let page = 0; page < config.cepr.maxPages; page++) {
    const url = new URL(config.cepr.feedURL); if (page) url.searchParams.set('page', String(page));
    try {
      const items = readRSS(await client.request(url, 'xml')); cepr.pages++;
      if (!items.length) { cepr.complete = true; break; }
      let newItems = 0;
      for (const item of items) {
        const link = new URL(item.url);
        if (link.hostname.replace(/^www\./, '') !== 'cepr.org' || !/^\/publications\/dp\d+\/?$/i.test(link.pathname)) continue;
        if (ceprSeen.has(item.url)) continue;
        ceprSeen.add(item.url); newItems++;
        corpus.push({ ...item, title: item.title.replace(/^DP\d+\s*[:–—-]?\s*/i, ''), kind: 'literature', pageID: 'discovery/cepr', pageURL: config.cepr.feedURL,
          abstractSource: 'CEPR official RSS', groups: ['CEPR'], position: 0, doi: null, journal: '' });
      }
      if (items.some(item => item.date && item.date.value < window.from)) { cepr.complete = true; break; }
      if (!newItems) { cepr.error = 'RSS pagination repeated the same page; coverage is partial'; break; }
    } catch (error) { cepr.error = error.message; break; }
  }
  if (!cepr.complete && !cepr.error) cepr.error = 'CEPR page limit reached; coverage is partial';

  const recent = corpus.filter(record => inWindow(record.date, window));
  await client.abstracts(recent);
  const incoming = [];
  for (const record of corpus) {
    const status = record.groups.includes('NBER') ? nber : record.groups.includes('CEPR') ? cepr : journals;
    status.scanned++;
    if (!record.date) { status.missingDate++; continue; }
    if (!inWindow(record.date, window)) { status.outsideWindow++; continue; }
    status.recent++;
    if (!record.abstract) { status.missingAbstract++; continue; }
    if (!supplyChainAbstract(record.abstract)) continue;
    status.matched++; incoming.push(record);
  }
  journals.coverage = config.journals.map(journal => {
    const records = recent.filter(record => record.journal === journal.name);
    return { journal: journal.name, groups: journal.groups, recentMetadata: records.length,
      withAbstract: records.filter(record => record.abstract).length,
      matched: records.filter(record => supplyChainAbstract(record.abstract)).length };
  });
  return { incoming, corpus, statuses };
}

function authorMatches(record, candidate) {
  const surname = normalizeTitle(candidate.researcher.split(' ').at(-1));
  const initial = candidate.researcher[0].toLowerCase();
  return record.authors.some(name => normalizeTitle(name.split(/\s+/).at(-1)) === surname &&
    normalizeTitle(name).startsWith(initial));
}

export async function dateResearcherPapers(candidates, corpus, config, client, cache, now, window) {
  const dated = []; const pending = []; let lookups = 0;
  const status = { candidates: candidates.length, dateVerified: 0, missingDate: 0, outsideWindow: 0, pending: 0, lookups: 0, errors: [] };
  const byTitle = new Map();
  for (const record of corpus) {
    const key = normalizeTitle(record.title);
    byTitle.set(key, [...(byTitle.get(key) ?? []), record]);
  }
  const save = (candidate, record) => {
    if (!record?.date) { status.missingDate++; return; }
    if (!inWindow(record.date, window)) { status.outsideWindow++; return; }
    dated.push({ ...candidate, kind: 'researcher', date: record.date, doi: record.doi,
      abstract: record.abstract, abstractSource: record.abstractSource, authors: record.authors, groups: [] });
    status.dateVerified++;
  };
  for (const candidate of candidates) {
    const key = normalizeTitle(candidate.title);
    const record = byTitle.get(key)?.filter(r => authorMatches(r, candidate)).sort((a, b) => (b.date?.value ?? '').localeCompare(a.date?.value ?? ''))[0];
    if (record) { save(candidate, record); continue; }
    const cached = cache.get(`author:${key}:${candidate.researcher}`, now);
    if (cached !== undefined) { save(candidate, cached); continue; }
    if (candidate.position < config.limits.authorCandidatesPerPage) pending.push(candidate);
    else status.pending++;
  }
  // Rotate across sources, not eight consecutive papers from the first scholar.
  pending.sort((a, b) => a.position - b.position || a.pageID.localeCompare(b.pageID));
  for (const candidate of pending) {
    const key = normalizeTitle(candidate.title); const cacheKey = `author:${key}:${candidate.researcher}`;
    const cached = cache.get(cacheKey, now);
    if (cached !== undefined) { save(candidate, cached); continue; }
    if (lookups >= config.limits.authorLookups || !client.remaining) { status.pending++; continue; }
    lookups++;
    try {
      const url = new URL('/works', config.crossref);
      url.searchParams.set('query.title', candidate.title);
      url.searchParams.set('query.author', candidate.researcher);
      url.searchParams.set('rows', '3');
      const result = await client.request(url);
      if (!Array.isArray(result.message?.items)) throw new Error('Invalid author metadata results');
      const record = result.message.items.map(w => crossrefRecord(w, 'researcher')).find(r => r &&
        normalizeTitle(r.title) === key && authorMatches(r, candidate)) ?? null;
      cache.set(cacheKey, record, now + DAY); save(candidate, record);
    } catch (error) { status.errors.push(error.message); status.pending++; }
  }
  status.lookups = lookups;
  return { incoming: dated, status };
}
