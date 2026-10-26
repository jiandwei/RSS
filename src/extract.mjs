import { cleanText, isPaperTitle, safeURL, normalizeTitle } from './feed.mjs';

// HTMLRewriter runs in the Workers runtime. No browser, eval, or HTML DOM needed.
export async function extractPage(html, source, page) {
  const records = [];
  const makeItem = (title, href, excerpt = '') => {
    title = cleanText(title).replace(/^['"“”]+|['"“”]+$/g, '').trim();
    const url = safeURL(href, page.url);
    if (!isPaperTitle(title) || !url) return;
    if (page.excludeTitlePattern && new RegExp(page.excludeTitlePattern, 'i').test(title)) return;
    if (page.includeUrlPattern && !new RegExp(page.includeUrlPattern, 'i').test(url)) return;
    records.push({ title, url, excerpt: cleanText(excerpt).slice(0, 1800),
      pageID: `${source.id}/${page.id}`, pageURL: page.url,
      researcher: source.name, position: records.length });
  };

  let rewriter = new HTMLRewriter();
  if (page.mode === 'links') {
    let anchor = null;
    rewriter = rewriter.on(page.selector, {
      element(el) {
        const record = { title: '', href: el.getAttribute('href') };
        anchor = record;
        el.onEndTag(() => { makeItem(record.title, record.href); anchor = null; });
      },
      text(chunk) { if (anchor) anchor.title += chunk.text; }
    });
  } else if (page.mode === 'quoted-paragraphs') {
    // Wix splits a title and its coauthors/download links across separate <p>s.
    // Group paragraphs starting with opening quotation marks into one paper.
    const paragraphs = [];
    let current = null;
    let link = null;
    rewriter = rewriter.on(page.selector, {
      element(el) {
        const row = { text: '', links: [] };
        paragraphs.push(row); current = row;
        el.onEndTag(() => { current = null; });
      },
      text(chunk) { if (current) current.text += chunk.text; }
    }).on(`${page.selector} a[href]`, {
      element(el) {
        if (!current) return;
        const entry = { href: el.getAttribute('href'), title: '' };
        current.links.push(entry); link = entry;
        el.onEndTag(() => { link = null; });
      },
      text(chunk) { if (link) link.title += chunk.text; }
    });
    await rewriter.transform(new Response(html)).text();
    let group = null;
    const finish = () => {
      if (!group) return;
      const text = cleanText(group.text);
      const quoted = text.match(/^["“]([^"”]+)["”]/);
      const title = quoted?.[1] ?? text.replace(/^["“]/, '').split(/\s*\(with\b/i)[0];
      const validLinks = group.links.filter(l => safeURL(l.href, page.url) &&
        !/^(slides|data|code|appendix|voxeu?|voxdev|ft|centrepoint|centrepiece|freakonomics)$/i.test(cleanText(l.title)));
      const preferred = validLinks.find(l => /ungated|working paper|discussion paper|journal article/i.test(l.title)) ??
        validLinks.find(l => /\.pdf(?:[?#]|$)/i.test(l.href)) ?? validLinks[0];
      makeItem(title, preferred?.href ?? page.url, text);
    };
    for (const row of paragraphs) {
      const text = cleanText(row.text);
      if (/^["“]/.test(text)) { finish(); group = { text, links: [...row.links] }; }
      else if (group) { group.text += ' ' + text; group.links.push(...row.links); }
    }
    finish();
  } else { throw new Error(`Unsupported parser mode: ${page.mode}`); }

  if (page.mode === 'links') await rewriter.transform(new Response(html)).text();
  const seen = new Set();
  return records.filter(item => {
    const key = normalizeTitle(item.title);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 400);
}

export async function fetchPage(source, page, fetcher = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('Source timeout'), 15000);
  try {
    let url = page.url; let response;
    for (let redirects = 0; redirects <= 2; redirects++) {
      response = await fetcher(url, {
      signal: controller.signal, redirect: 'manual',
      headers: { 'User-Agent': 'ScholarRSS/1.0 (public research pages; six-hour refresh)',
        Accept: 'text/html,application/xhtml+xml;q=0.9', 'Accept-Language': 'en' }
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const next = safeURL(response.headers.get('Location'), url);
      await response.body?.cancel();
      if (!next || redirects === 2) throw new Error('Invalid/excessive source redirect');
      url = next;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') ?? '')) throw new Error('Expected HTML response');
    if (Number(response.headers.get('content-length')) > 3_000_000) throw new Error('Source exceeds 3 MB');
    // Bound both decompressed bytes and wall time, including HTML extraction.
    let html = ''; let size = 0;
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 3_000_000) throw new Error('Source exceeds 3 MB');
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    if (/<title[^>]*>\s*Index of\b/i.test(html)) throw new Error('Directory listing is not a research page');
    const items = await extractPage(html, source, page);
    if (!items.length) throw new Error('No papers extracted; check selector or upstream page');
    return items;
  } finally { clearTimeout(timer); }
}
