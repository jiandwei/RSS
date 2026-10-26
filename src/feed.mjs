import { decodeHTML } from 'entities';

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

export function validateSources(sources) {
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
}

// Identify by normalized title, not PDF URL: coauthors often host different copies.
// These are monitored researchers, not an assertion about the complete author list.
export async function mergeItems(previous, incoming, observedAt, maxHistory = 2000) {
  const byID = new Map(previous.map(item => [item.id, structuredClone(item)]));
  let changed = false;
  for (const candidate of incoming) {
    const id = await digest(normalizeTitle(candidate.title));
    const ref = { pageID: candidate.pageID, researcher: candidate.researcher, pageURL: candidate.pageURL };
    const old = byID.get(id);
    if (!old) {
      byID.set(id, {
        id, title: candidate.title, url: candidate.url,
        firstSeen: observedAt, updatedAt: observedAt, position: candidate.position,
        refs: [ref], urls: [candidate.url], excerpts: candidate.excerpt ? [candidate.excerpt] : []
      });
      changed = true;
      continue;
    }
    const snapshot = JSON.stringify(old);
    // Preserve a stable primary URL and pubDate. Revisit known pages to retain
    // updated PDF addresses and researchers without creating duplicate entries.
    const existing = old.refs.findIndex(r => r.pageID === ref.pageID);
    if (existing >= 0) old.refs[existing] = ref;
    else old.refs.push(ref);
    if (!old.urls.includes(candidate.url)) old.urls.push(candidate.url);
    if (candidate.excerpt && !old.excerpts.includes(candidate.excerpt)) old.excerpts = [...old.excerpts, candidate.excerpt].slice(-4);
    old.position = Math.min(old.position, candidate.position);
    if (JSON.stringify(old) !== snapshot) { old.updatedAt = observedAt; changed = true; }
  }
  const items = [...byID.values()].sort((a, b) =>
    b.firstSeen.localeCompare(a.firstSeen) || a.position - b.position || a.title.localeCompare(b.title));
  if (items.length > maxHistory) changed = true;
  return { items: items.slice(0, maxHistory), changed };
}

export function renderRSS(items, { title, origin, updatedAt, limit = 200 }) {
  const esc = escapeXML;
  const entries = items.slice(0, limit).map(item => {
    const researchers = [...new Set(item.refs.map(r => r.researcher))];
    const description = [
      `Monitored researchers: ${researchers.join(', ')}. This is not the complete author list.`,
      `First detected: ${item.firstSeen}. The RSS pubDate is detection time, not the paper's publication date.`,
      ...item.excerpts,
      ...item.refs.map(ref => `Source (${ref.researcher}): ${ref.pageURL}`),
      ...item.urls.slice(1).map(url => `Other paper link: ${url}`)
    ].join('\n\n');
    return `<item><title>${esc(item.title)}</title><link>${esc(item.url)}</link>` +
      `<guid isPermaLink="false">urn:scholar-rss:${item.id}</guid>` +
      `<pubDate>${new Date(item.firstSeen).toUTCString()}</pubDate>` +
      `<description>${esc(description)}</description>` +
      researchers.map(name => `<category>${esc(name)}</category>`).join('') + '</item>';
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0"><channel>` +
    `<title>${esc(title)}</title><link>${esc(origin)}/</link>` +
    `<description>One combined feed of research links from six economists. Dates indicate first detection.</description>` +
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

