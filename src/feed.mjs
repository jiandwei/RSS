import { decodeHTML } from 'entities';
import { inWindow } from './window.mjs';
import { matchResearchTopic, supplyChainAbstract } from './topic.mjs';

export function cleanText(value = '') {
  return decodeHTML(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ').trim();
}

export function escapeXML(value) {
  return cleanText(String(value)).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[c]);
}

export function normalizeTitle(title) {
  return cleanText(title).normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export async function digest(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function safeURL(href, base) {
  if (typeof href !== 'string' || !href.trim()) return null;
  try {
    const url = new URL(href, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return null; }
}

export function isPaperTitle(title) {
  const text = cleanText(title);
  return text.length >= 12 && text.length <= 700 && text.split(/\s+/).length >= 2 &&
    !/^(?:online\s+)?(?:appendix|appendices|slides|data(?:sets)?|replication|code|curriculum vitae|download|updated slides|empirical replication|model replication)(?:\b|$)/i.test(text) &&
    !/^(?:skip to|back to|read more|view all|click here|terms of|privacy policy)/i.test(text);
}

export function validateSources(config) {
  const sources = Array.isArray(config) ? config : config.researchers;
  if (!Array.isArray(sources) || !sources.length) throw new Error('sources.json must be a nonempty array');
  const ids = new Set();
  let pageCount = 0;
  for (const source of sources) {
    if (!/^[a-z0-9-]+$/.test(source.id) || ids.has(source.id)) throw new Error('Invalid/duplicate researcher id');
    ids.add(source.id);
    if (!source.name || !Array.isArray(source.pages) || !source.pages.length) throw new Error('Missing researcher name/pages');
    const pages = new Set();
    for (const page of source.pages) {
      if (!/^[a-z0-9-]+$/.test(page.id) || pages.has(page.id)) throw new Error('Invalid/duplicate page id');
      pages.add(page.id);
      if (!safeURL(page.url) || !page.selector || !['links', 'quoted-paragraphs'].includes(page.mode)) throw new Error(`Invalid page: ${source.id}/${page.id}`);
      if (page.includeUrlPattern) new RegExp(page.includeUrlPattern, 'i');
      if (page.excludeTitlePattern) new RegExp(page.excludeTitlePattern, 'i');
      pageCount++;
    }
  }
  if (pageCount > 20) throw new Error('At most 20 configured pages per refresh');
  if (!Array.isArray(config)) {
    const discovery = config.discovery;
    if (discovery?.months !== 2 || !discovery.timeZone || !Array.isArray(discovery.journals) || !discovery.journals.length) {
      throw new Error('Discovery requires a two-month window and journal whitelist');
    }
    new Intl.DateTimeFormat('en', { timeZone: discovery.timeZone });
    for (const journal of discovery.journals) {
      if (!journal.name || !journal.issns?.length || journal.issns.some(i => !/^\d{4}-\d{3}[\dX]$/.test(i)) ||
          !journal.groups?.length || journal.groups.some(g => !['UTD24', 'FT50'].includes(g))) throw new Error('Invalid journal whitelist');
    }
    for (const url of [discovery.crossref, discovery.openalex, discovery.nber.feedURL, discovery.cepr.feedURL]) {
      if (!safeURL(url)?.startsWith('https://')) throw new Error('Discovery endpoints must use HTTPS');
    }
    for (const [key, max] of Object.entries({ requests: 45, crossrefJournalPages: 8, crossrefNBERPages: 2,
      rows: 1000, openalexBatch: 100, authorLookups: 8, authorCandidatesPerPage: 20 })) {
      if (!Number.isInteger(discovery.limits[key]) || discovery.limits[key] < 1 || discovery.limits[key] > max) throw new Error(`Invalid discovery limit: ${key}`);
    }
    if (!Number.isInteger(discovery.cepr.maxPages) || discovery.cepr.maxPages < 1 || discovery.cepr.maxPages > 12) throw new Error('Invalid CEPR page limit');
  }
}

// Preserve title-based GUIDs from the original feed; DOI also joins alternate title spellings.
export async function mergeItems(previous, incoming, observedAt, maxHistory = 2000) {
  const byID = new Map(previous.map(item => [item.id, structuredClone(item)]));
  const titles = new Map(); const dois = new Map();
  const index = item => {
    titles.set(normalizeTitle(item.title), item.id);
    for (const record of item.records ?? []) {
      titles.set(normalizeTitle(record.title), item.id);
      if (record.doi) dois.set(record.doi, item.id);
    }
  };
  for (const item of byID.values()) index(item);
  let changed = false;
  for (const candidate of incoming) {
    const id = (candidate.doi && dois.get(candidate.doi)) || titles.get(normalizeTitle(candidate.title)) ||
      await digest(normalizeTitle(candidate.title));
    const ref = { pageID: candidate.pageID, researcher: candidate.researcher, pageURL: candidate.pageURL };
    let item = byID.get(id);
    const snapshot = item ? JSON.stringify(item) : null;
    if (!item) {
      item = { id, title: candidate.title, url: candidate.url, firstSeen: observedAt, updatedAt: observedAt,
        position: candidate.position ?? 0, refs: [], urls: [], excerpts: [], records: [] };
      byID.set(id, item);
    }
    const existing = item.refs.findIndex(r => r.pageID === ref.pageID);
    if (existing >= 0) item.refs[existing] = ref; else item.refs.push(ref);
    if (!item.urls.includes(candidate.url)) item.urls.push(candidate.url);
    if (candidate.excerpt && !item.excerpts.includes(candidate.excerpt)) item.excerpts = [...item.excerpts, candidate.excerpt].slice(-4);
    item.position = Math.min(item.position, candidate.position ?? 0);
    item.records ??= [];
    const record = { title: candidate.title, url: candidate.url, pageID: candidate.pageID, pageURL: candidate.pageURL,
      kind: candidate.kind ?? 'researcher', researcher: candidate.researcher ?? null,
      doi: candidate.doi ?? null, date: candidate.date ?? null, abstract: candidate.abstract ?? '',
      abstractSource: candidate.abstractSource ?? null, authors: candidate.authors ?? [],
      groups: candidate.groups ?? [], journal: candidate.journal ?? '' };
    const key = r => `${r.pageID}:${r.doi ?? r.url}`;
    const i = item.records.findIndex(r => key(r) === key(record));
    if (i >= 0) item.records[i] = record; else item.records.push(record);
    if (JSON.stringify(item) !== snapshot) { item.updatedAt = observedAt; changed = true; }
    index(item);
  }
  const items = [...byID.values()].sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) ||
    a.position - b.position || a.title.localeCompare(b.title));
  if (items.length > maxHistory) changed = true;
  return { items: items.slice(0, maxHistory), changed };
}

export function feedItems(items, window) {
  return items.flatMap(item => {
    // Legacy crawl-time-only entries cannot establish publication recency.
    const records = (item.records ?? []).filter(r => inWindow(r.date, window) &&
      (r.kind === 'researcher' || (r.kind === 'literature' && supplyChainAbstract(r.abstract))));
    records.sort((a, b) => b.date.value.localeCompare(a.date.value) || Number(Boolean(b.abstract)) - Number(Boolean(a.abstract)));
    if (!records.length) return [];
    const primary = records[0];
    const databases = [...new Map(records.flatMap(record => matchResearchTopic(record.abstract).databases).map(database => [database.id, database])).values()];
    return [{ ...item, ...primary, records, databases, categories: [...new Set(records.flatMap(r =>
      [...r.groups, ...(r.researcher ? [r.researcher] : [])]))] }];
  }).sort((a, b) => b.date.value.localeCompare(a.date.value) || a.title.localeCompare(b.title));
}

export function renderPaperDetails(item) {
  const esc = escapeXML;
  const link = (href, label) => {
    const url = safeURL(href);
    return url ? `<a href="${esc(url)}" rel="noreferrer noopener" style="color:#356958;text-decoration:underline;text-underline-offset:3px">${esc(label)}</a>` : esc(label);
  };
  const date = item.date.precision === 'month' ? `${item.date.value.slice(0, 7)}（月精度，订阅日期使用当月 1 日）` : item.date.value;
  const metadata = [
    ['作者', item.authors?.length ? esc(item.authors.join(' · ')) : '作者信息暂缺'],
    ['发表日期', esc(date)],
    ...(item.journal ? [['期刊', esc(item.journal)]] : []),
    ...(item.doi ? [['DOI', link(`https://doi.org/${String(item.doi).split('/').map(encodeURIComponent).join('/')}`, item.doi)]] : []),
    ...(item.databases?.length ? [['摘要提及', esc(item.databases.map(database => database.name).join(' · '))]] : [])
  ];
  const sources = new Map();
  for (const record of item.records ?? []) {
    const url = safeURL(record.pageURL);
    if (!url) continue;
    if (!sources.has(url)) sources.set(url, new Set());
    sources.get(url).add(record.researcher || record.groups?.join(' · ') || '文献来源');
  }
  const alternatives = [...new Set((item.records ?? []).map(record => safeURL(record.url)))].filter(url => url && url !== safeURL(item.url));
  const abstract = item.abstract ? String(item.abstract).split(/\r?\n\s*\r?\n/).filter(text => text.trim()).map(text =>
    `<p style="margin:0 0 14px;line-height:1.9;overflow-wrap:anywhere">${esc(text)}</p>`).join('') :
    '<p style="margin:0 0 14px;line-height:1.9;color:#737b77">原始来源暂未提供摘要；可通过论文链接查看原文。</p>';
  return `<div class="paper-details" style="font-size:15px;line-height:1.8;color:#303d36">` +
    `<table class="paper-meta" role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.8"><tbody>` +
    metadata.map(([label, value]) => `<tr><th scope="row" style="width:76px;padding:3px 16px 3px 0;text-align:left;vertical-align:top;font-weight:500;color:#737b77">${label}</th><td style="padding:3px 0;overflow-wrap:anywhere">${value}</td></tr>`).join('') +
    `</tbody></table><h3 style="font-size:15px;font-weight:600;margin:24px 0 10px">摘要</h3>${abstract}` +
    (item.abstractSource ? `<p class="provenance" style="font-size:12px;color:#737b77;margin:8px 0">摘要来源：${esc(item.abstractSource)}</p>` : '') +
    `<p class="provenance" style="font-size:12px;color:#737b77;margin:8px 0">日期依据：${esc(item.date.source)}</p>` +
    (sources.size || alternatives.length ? `<div class="paper-sources" style="border-top:1px solid #e6ebe7;margin-top:20px;padding-top:14px;font-size:13px">` +
      `<strong style="font-weight:500;color:#737b77">发现来源与其他版本</strong><ul style="margin:8px 0 0;padding-left:20px">` +
      [...sources].map(([url, labels]) => `<li>${link(url, [...labels].join(' · '))}</li>`).join('') +
      alternatives.map((url, index) => `<li>${link(url, `其他论文链接 ${index + 1}`)}</li>`).join('') + '</ul></div>' : '') + '</div>';
}

export function renderRSS(items, { title, origin, updatedAt, window, limit = 200 }) {
  const esc = escapeXML;
  const entries = items.slice(0, limit).map(item => {
    const description = renderPaperDetails(item).replaceAll(']]>', ']]]]><![CDATA[>');
    return `<item><title>${esc(item.title)}</title><link>${esc(item.url)}</link>` +
      `<guid isPermaLink="false">urn:scholar-rss:${item.id}</guid>` +
      `<pubDate>${new Date(item.date.value + 'T00:00:00Z').toUTCString()}</pubDate>` +
      `<description><![CDATA[${description}]]></description>` +
      item.authors.map(name => `<dc:creator>${esc(name)}</dc:creator>`).join('') +
      [...new Set([...item.categories, ...(item.databases ?? []).map(database => database.name)])].map(name => `<category>${esc(name)}</category>`).join('') + '</item>';
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>` +
    `<title>${esc(title)}</title><link>${esc(origin)}/</link>` +
    `<description>Six economists and abstract-matched supply-chain papers from UTD24, FT50, NBER and CEPR. Publication window: ${esc(window.from)} through ${esc(window.to)} (${esc(window.timeZone)}). Missing dates excluded.</description>` +
    `<language>en</language><ttl>360</ttl>` +
    `<lastBuildDate>${new Date(updatedAt).toUTCString()}</lastBuildDate>\n${entries}\n</channel></rss>\n`;
}

export function renderOPML(origin, title, accessKey) {
  const feed = new URL('/feed.xml', origin); const home = new URL('/', origin);
  if (accessKey) { feed.searchParams.set('key', accessKey); home.searchParams.set('key', accessKey); }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>${escapeXML(title)}</title></head>` +
    `<body><outline type="rss" text="${escapeXML(title)}" title="${escapeXML(title)}" ` +
    `xmlUrl="${escapeXML(feed.href)}" htmlUrl="${escapeXML(home.href)}"/></body></opml>\n`;
}


