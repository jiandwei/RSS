import sources from '../sources.json';
import { digest, escapeXML, mergeItems, renderOPML, renderRSS, validateSources } from './feed.mjs';
import { fetchPage } from './extract.mjs';

validateSources(sources);
const pages = sources.flatMap(source => source.pages.map(page => ({ source, page })));
const titleOf = env => env.FEED_TITLE || 'Economists — Research Updates';
const boundedInt = (value, fallback, max) => Math.max(1, Math.min(max, Number.parseInt(value, 10) || fallback));
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowed = ['/', '/feed.xml', '/feed.opml', '/sources.json', '/status.json', '/refresh'];
    if (!allowed.includes(url.pathname)) return new Response('Not found', { status: 404 });
    if (url.pathname === '/refresh') {
      if (!env.REFRESH_TOKEN) return new Response('Not found', { status: 404 });
      if (request.method !== 'POST') return new Response('Use POST', { status: 405, headers: { Allow: 'POST' } });
      const supplied = request.headers.get('Authorization') ?? '';
      // Compare fixed-length hashes without early exit; never accept URL tokens.
      const a = await digest(supplied); const b = await digest(`Bearer ${env.REFRESH_TOKEN}`);
      let different = 0;
      for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
      if (different) return new Response('Unauthorized', { status: 401 });
    } else if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Use GET or HEAD', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    if (url.pathname === '/sources.json') {
      const response = json(sources);
      return request.method === 'HEAD' ? new Response(null, response) : response;
    }
    if (url.pathname === '/feed.opml') {
      return new Response(request.method === 'HEAD' ? null : renderOPML(url.origin, titleOf(env)), {
        headers: { 'Content-Type': 'text/x-opml; charset=utf-8', 'Cache-Control': 'public, max-age=3600',
          'Content-Disposition': 'attachment; filename="scholar-rss.opml"' }
      });
    }
    const stub = env.FEED_STORE.get(env.FEED_STORE.idFromName('all-scholars-v1'));
    return stub.fetch(request);
  },
  async scheduled(_controller, env, ctx) {
    const stub = env.FEED_STORE.get(env.FEED_STORE.idFromName('all-scholars-v1'));
    ctx.waitUntil((async () => {
      const response = await stub.fetch('https://feed.internal/refresh', { method: 'POST' });
      if (!response.ok) throw new Error(`Scheduled refresh failed: ${response.status}`);
      const report = await response.json();
      // Log source health, not credentials or downloaded page content.
      console.log(JSON.stringify({ event: 'refresh', items: report.itemCount,
        failedPages: report.pages.filter(page => page.error).map(page => ({ id: page.id, error: page.error })) }));
    })());
  }
};

export class FeedStore {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql; this.refreshPromise = null;
    this.sql.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, first_seen TEXT NOT NULL, data TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS page_status (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  getMeta(key) { return this.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value ?? null; }
  setMeta(key, value) { this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, value); }
  getItems() {
    return this.sql.exec('SELECT data FROM items').toArray().map(row => JSON.parse(row.data))
      .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.position - b.position || a.title.localeCompare(b.title));
  }
  report() {
    const known = new Map(this.sql.exec('SELECT id, data FROM page_status').toArray().map(row => [row.id, JSON.parse(row.data)]));
    const status = pages.map(({ source, page }) => ({ id: `${source.id}/${page.id}`, researcher: source.name,
      url: page.url, ...known.get(`${source.id}/${page.id}`) }));
    return {
      feed: '/feed.xml', researcherCount: sources.length, pageCount: pages.length,
      itemCount: this.sql.exec('SELECT COUNT(*) AS n FROM items').toArray()[0].n,
      lastAttempt: this.getMeta('lastAttempt'), lastSuccess: this.getMeta('lastSuccess'),
      contentUpdatedAt: this.getMeta('contentUpdatedAt'),
      health: !status.some(page => page.checkedAt) ? 'not-initialized' : status.some(page => page.error) ? 'degraded' : 'healthy',
      pages: status
    };
  }
  refresh() {
    if (!this.refreshPromise) this.refreshPromise = this.performRefresh().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }
  async performRefresh() {
    const observedAt = new Date().toISOString();
    this.setMeta('lastAttempt', observedAt);
    const results = new Array(pages.length); let next = 0;
    // Limit concurrent origin connections. One broken page does not reject others.
    await Promise.all(Array.from({ length: Math.min(3, pages.length) }, async () => {
      for (;;) {
        const index = next++; if (index >= pages.length) break;
        const { source, page } = pages[index];
        try { results[index] = { items: await fetchPage(source, page), error: null }; }
        catch (error) { results[index] = { items: [], error: String(error.message ?? error).slice(0, 300) }; }
      }
    }));
    const previous = this.getItems();
    const merged = await mergeItems(previous, results.flatMap(result => result.items), observedAt,
      boundedInt(this.env.MAX_HISTORY_ITEMS, 2000, 5000));
    this.ctx.storage.transactionSync(() => {
      // All changes become visible together, including the source status report.
      const keep = new Set(merged.items.map(item => item.id));
      for (const old of previous) if (!keep.has(old.id)) this.sql.exec('DELETE FROM items WHERE id = ?', old.id);
      for (const item of merged.items) this.sql.exec('INSERT OR REPLACE INTO items (id, first_seen, data) VALUES (?, ?, ?)',
        item.id, item.firstSeen, JSON.stringify(item));
      for (let index = 0; index < pages.length; index++) {
        const { source, page } = pages[index]; const id = `${source.id}/${page.id}`;
        const prior = this.sql.exec('SELECT data FROM page_status WHERE id = ?', id).toArray()[0];
        const old = prior ? JSON.parse(prior.data) : {};
        const result = results[index];
        this.sql.exec('INSERT OR REPLACE INTO page_status (id, data) VALUES (?, ?)', id, JSON.stringify({
          checkedAt: observedAt, lastSuccess: result.error ? (old.lastSuccess ?? null) : observedAt,
          lastGoodCount: result.error ? (old.lastGoodCount ?? 0) : result.items.length,
          error: result.error
        }));
      }
      if (results.some(result => !result.error)) this.setMeta('lastSuccess', observedAt);
      if (merged.changed || !this.getMeta('contentUpdatedAt')) this.setMeta('contentUpdatedAt', observedAt);
    });
    return this.report();
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/refresh' && request.method === 'POST') return json(await this.refresh());
    if (url.pathname === '/status.json') return json(this.report());
    if (url.pathname === '/') return new Response(request.method === 'HEAD' ? null : this.home(url.origin), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" }
    });
    if (url.pathname !== '/feed.xml') return new Response('Not found', { status: 404 });
    // A first subscription bootstraps the store, with retry backoff if every source fails.
    let items = this.getItems();
    const last = this.getMeta('lastAttempt');
    if (!items.length) {
      if (this.refreshPromise) await this.refreshPromise;
      else if (!last || Date.now() - Date.parse(last) >= 15 * 60 * 1000) await this.refresh();
      items = this.getItems();
    }
    if (!items.length) return new Response('No research items available yet. Check /status.json and retry later.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '900', 'Cache-Control': 'no-store' }
    });
    const body = renderRSS(items, { origin: url.origin, title: titleOf(this.env),
      updatedAt: this.getMeta('contentUpdatedAt'), limit: boundedInt(this.env.MAX_FEED_ITEMS, 200, 1000) });
    const etag = `"${await digest(body)}"`;
    const headers = { 'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300', ETag: etag,
      'Last-Modified': new Date(this.getMeta('contentUpdatedAt')).toUTCString(),
      'X-Feed-Health': this.report().health, 'X-Content-Type-Options': 'nosniff' };
    const validators = request.headers.get('If-None-Match')?.split(',').map(value => value.trim().replace(/^W\//, '')) ?? [];
    if (validators.includes(etag) || validators.includes('*')) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : body, { headers });
  }
  home(origin) {
    const report = this.report(); const esc = escapeXML;
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
      `<title>研究者 RSS</title><style>body{font:16px/1.7 system-ui;max-width:850px;margin:48px auto;padding:0 24px;color:#172b4d}code{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}a{color:#165cbe}</style>` +
      `<h1>六位学者，一个 RSS</h1><p>在 Zotero 的“新建订阅源 → 从 URL”中添加：</p>` +
      `<p><a href="/feed.xml"><code>${esc(origin)}/feed.xml</code></a></p>` +
      `<p><a href="/feed.opml">下载 OPML（只包含上述一个订阅源）</a> · <a href="/status.json">抓取状态</a> · <a href="/sources.json">链接配置</a></p>` +
      `<p>每 6 小时抓取。首次打开 RSS 时初始化；首次订阅会包含已有论文。RSS 日期表示首次发现时间。</p>` +
      `<p>已保存 ${report.itemCount} 条；状态：${esc(report.health)}；最近尝试：${esc(report.lastAttempt ?? '尚未初始化')}。</p>` +
      `<table><tr><th>研究者</th><th>页面状态</th></tr>` + sources.map(source => {
        const relevant = report.pages.filter(page => page.id.startsWith(`${source.id}/`));
        return `<tr><td><a href="${esc(source.homepage)}">${esc(source.name)}</a></td><td>` +
          relevant.map(page => `${esc(page.id.split('/')[1])}: ${esc(page.error ?? (page.checkedAt ? `${page.lastGoodCount} 条` : '未检查'))}`).join('<br>') + '</td></tr>';
      }).join('') + `</table><p>这里只聚合公开研究链接，不替代完整书目信息。网页不可用或解析失败时保留已保存条目，不将错误消息混入 RSS。</p></html>`;
  }
}

