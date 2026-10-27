import config from '../sources.json';
import { dateWindow } from './window.mjs';
import { collectLiterature, dateResearcherPapers, metadataClient } from './discovery.mjs';
import { digest, escapeXML, mergeItems, feedItems, renderOPML, renderRSS, validateSources } from './feed.mjs';
import { fetchPage } from './extract.mjs';
import { authorizeRead, hasAccessKey, matchesSecret, privateResponse, privateURL } from './auth.mjs';
import { renderReadingPage } from './reading.mjs';

validateSources(config);
const sources = config.researchers;
const discovery = config.discovery;
const currentWindow = () => dateWindow(new Date(), discovery.months, discovery.timeZone);
const pages = sources.flatMap(source => source.pages.map(page => ({ source, page })));
const titleOf = env => env.FEED_TITLE || 'Economists & Supply Chain — Recent Research';
const boundedInt = (value, fallback, max) => Math.max(1, Math.min(max, Number.parseInt(value, 10) || fallback));
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const htmlPage = body => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
  `<title>研究者与供应链 RSS · 抓取状态</title><style>body{font:16px/1.7 system-ui;max-width:850px;margin:48px auto;padding:0 24px;color:#172b4d}code{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}a{color:#165cbe}input,button{font:inherit;padding:8px;max-width:100%;box-sizing:border-box}form{display:flex;flex-wrap:wrap;gap:8px;align-items:center}</style>` + body + '</html>';
const homeResponse = (request, body, status = 200) => new Response(request.method === 'HEAD' ? null : body, {
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" }
});

export default {
  async fetch(request, env) {
    return privateResponse(await handleRequest(request, env));
  },
  async scheduled(_controller, env, ctx) {
    // An unconfigured deployment must not spend money crawling or accessing storage.
    if (!hasAccessKey(env)) return;
    const stub = env.FEED_STORE.get(env.FEED_STORE.idFromName('all-scholars-v1'));
    ctx.waitUntil((async () => {
      const response = await stub.fetch('https://feed.internal/refresh', { method: 'POST' });
      if (!response.ok) throw new Error(`Scheduled refresh failed: ${response.status}`);
      const report = await response.json();
      console.log(JSON.stringify({ event: 'refresh', items: report.itemCount,
        failedPages: report.pages.filter(page => page.error).map(page => ({ id: page.id, error: page.error })) }));
    })());
  }
};

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const allowed = ['/', '/feed.xml', '/papers.html', '/feed.opml', '/sources.json', '/status.json', '/refresh'];
    if (!allowed.includes(url.pathname)) return new Response('Not found', { status: 404 });
    // Cloudflare's Visit button opens a read-only overview without credentials.
    // Explicitly supplied credentials still go through normal authentication.
    if (url.pathname === '/' && !url.searchParams.has('key') && !request.headers.has('Authorization')) {
      if (!['GET', 'HEAD'].includes(request.method)) {
        return new Response('Use GET or HEAD', { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
      if (!hasAccessKey(env)) {
        const configured = env.ACCESS_KEY !== undefined && env.ACCESS_KEY !== null && env.ACCESS_KEY !== '';
        return homeResponse(request, htmlPage(`<h1>研究者与供应链 · 抓取状态</h1>` +
          `<p role="status">抓取已暂停：ACCESS_KEY ${configured ? '格式不合规' : '尚未配置'}。</p>` +
          `<p>在此 Worker 的设置 → 变量和密钥中，${configured ? '编辑' : '添加'}名为 <code>ACCESS_KEY</code> 的密钥，并点击“部署”。</p>` +
          `<p>使用随机的 32–128 位英文字母、数字、短横线或下划线，不带空格、引号或换行，也不要使用示例值。本地运行 <code>openssl rand -hex 32</code> 可生成密钥。</p>` +
          `<p>配置生效后，直接打开此首页即可查看抓取概况；RSS 订阅和详细状态需要访问密钥。</p>`));
      }
      const stub = env.FEED_STORE.get(env.FEED_STORE.idFromName('all-scholars-v1'));
      // This internal route renders only status summaries and never crawls.
      return stub.fetch('https://feed.internal/overview', { method: request.method });
    }
    // Private routes authenticate before any storage access or crawling.
    if (!hasAccessKey(env)) {
      const configured = env.ACCESS_KEY !== undefined && env.ACCESS_KEY !== null && env.ACCESS_KEY !== '';
      const message = configured
        ? 'Service unavailable: ACCESS_KEY is set but invalid. Use a random 32-128 character key containing only A-Z, a-z, 0-9, - or _. Remove spaces, quotes and newlines; do not use a replace/example/changeme placeholder. Update the Worker Secret and deploy.'
        : 'Service unavailable: configure ACCESS_KEY as a Worker Secret in the environment serving this URL, then deploy the changes.';
      return new Response(message, { status: 503 });
    }
    if (url.pathname === '/refresh') {
      if (!env.REFRESH_TOKEN || env.REFRESH_TOKEN === env.ACCESS_KEY) return new Response('Not found', { status: 404 });
      if (request.method !== 'POST') return new Response('Use POST', { status: 405, headers: { Allow: 'POST' } });
      if (!await matchesSecret(request.headers.get('Authorization'), `Bearer ${env.REFRESH_TOKEN}`)) {
        return new Response('Unauthorized', { status: 401 });
      }
    } else {
      if (!await authorizeRead(request, env)) return new Response('Unauthorized', { status: 401 });
      if (!['GET', 'HEAD'].includes(request.method)) {
        return new Response('Use GET or HEAD', { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
    }
    if (url.pathname === '/sources.json') {
      const response = json(config);
      return request.method === 'HEAD' ? new Response(null, response) : response;
    }
    if (url.pathname === '/feed.opml') {
      return new Response(request.method === 'HEAD' ? null : renderOPML(url.origin, titleOf(env), env.ACCESS_KEY), {
        headers: { 'Content-Type': 'text/x-opml; charset=utf-8', 'Cache-Control': 'public, max-age=3600',
          'Content-Disposition': 'attachment; filename="scholar-rss.opml"' }
      });
    }
    const stub = env.FEED_STORE.get(env.FEED_STORE.idFromName('all-scholars-v1'));
    // Never forward reader credentials into internal URLs, storage or source fetches.
    url.search = '';
    const forwarded = new Request(url, request);
    forwarded.headers.delete('Authorization');
    return stub.fetch(forwarded);
}

export class FeedStore {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql; this.refreshPromise = null;
    this.sql.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, first_seen TEXT NOT NULL, data TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS page_status (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS metadata_cache (key TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)');
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
    const providers = JSON.parse(this.getMeta('providers') ?? '[]');
    const researchers = JSON.parse(this.getMeta('researcherDates') ?? '{}');
    const metadataErrors = JSON.parse(this.getMeta('metadataErrors') ?? '[]');
    const all = this.getItems();
    const window = currentWindow(); const count = feedItems(all, window).length;
    const limit = boundedInt(this.env.MAX_FEED_ITEMS, 1000, 1000);
    return {
      feed: '/feed.xml', window, researcherCount: sources.length, pageCount: pages.length,
      journalCount: discovery.journals.length,
      itemCount: Math.min(count, limit), eligibleItemCount: count, feedTruncated: count > limit,
      storedItemCount: all.length, maxRequestsPerRefresh: discovery.limits.requests,
      lastRequestCount: Number(this.getMeta('requestCount') ?? 0),
      lastAttempt: this.getMeta('lastAttempt'), lastSuccess: this.getMeta('lastSuccess'),
      contentUpdatedAt: this.getMeta('contentUpdatedAt'),
      health: this.getMeta('schema') !== '2' ? 'not-initialized' :
        status.some(p => p.error) || providers.some(p => p.error || p.abstractFeedError || !p.complete || p.missingAbstract || p.missingDate) ||
        metadataErrors.length || researchers.errors?.length || researchers.pending || researchers.missingDate ? 'degraded' : 'healthy',
      pages: status, providers, researcherDates: researchers, metadataErrors,
      coverageNote: 'Public metadata only; missing abstracts/dates and indexing delays can omit papers. Zero journal metadata is not proof of no new papers.'
    };
  }
  metadataCache() {
    return {
      get: (key, now) => {
        const row = this.sql.exec('SELECT data FROM metadata_cache WHERE key = ? AND expires_at > ?', key, now).toArray()[0];
        return row ? JSON.parse(row.data) : undefined;
      },
      set: (key, value, expiresAt) => this.sql.exec('INSERT OR REPLACE INTO metadata_cache (key, data, expires_at) VALUES (?, ?, ?)',
        key, JSON.stringify(value), expiresAt)
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
    let pageRequests = 0;
    const fetchSource = (url, init) => {
      if (pageRequests >= discovery.limits.requests) throw new Error('Refresh request budget exhausted');
      pageRequests++; return fetch(url, init);
    };
    // Limit concurrent origin connections. One broken page does not reject others.
    await Promise.all(Array.from({ length: Math.min(3, pages.length) }, async () => {
      for (;;) {
        const index = next++; if (index >= pages.length) break;
        const { source, page } = pages[index];
        try { results[index] = { items: await fetchPage(source, page, fetchSource), error: null }; }
        catch (error) { results[index] = { items: [], error: String(error.message ?? error).slice(0, 300) }; }
      }
    }));
    const cache = this.metadataCache(); const now = Date.parse(observedAt); const window = currentWindow();
    this.sql.exec('DELETE FROM metadata_cache WHERE expires_at <= ?', now);
    const client = metadataClient(discovery, this.env, cache, now, fetch, pageRequests);
    const literature = await collectLiterature(discovery, client, window);
    const researchers = await dateResearcherPapers(results.flatMap(result => result.items), literature.corpus,
      discovery, client, cache, now, window);
    const previous = this.getItems();
    const merged = await mergeItems(previous, [...literature.incoming, ...researchers.incoming], observedAt,
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
      this.setMeta('providers', JSON.stringify(literature.statuses));
      this.setMeta('schema', '2');
      this.setMeta('researcherDates', JSON.stringify(researchers.status));
      this.setMeta('metadataErrors', JSON.stringify(client.errors));
      this.setMeta('requestCount', String(client.requests));
      if (results.some(result => !result.error) || literature.statuses.some(provider => provider.complete)) {
        this.setMeta('lastSuccess', observedAt); this.setMeta('scanSucceeded', '1');
      }
      if (merged.changed || !this.getMeta('contentUpdatedAt')) this.setMeta('contentUpdatedAt', observedAt);
    });
    return this.report();
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/refresh' && request.method === 'POST') return json(await this.refresh());
    if (url.pathname === '/status.json') return json(this.report());
    if (url.pathname === '/' || url.pathname === '/overview') {
      return homeResponse(request, this.home(url.origin, url.pathname === '/overview'));
    }
    if (!['/feed.xml', '/papers.html'].includes(url.pathname)) return new Response('Not found', { status: 404 });
    // A first subscription bootstraps the store, with retry backoff if every source fails.
    let items = this.getItems();
    const last = this.getMeta('lastAttempt');
    if (this.getMeta('schema') !== '2' || !this.getMeta('lastAttempt')) {
      if (this.refreshPromise) await this.refreshPromise;
      else await this.refresh();
      items = this.getItems();
    }
    if (!items.length && this.getMeta('scanSucceeded') !== '1' && last && Date.now() - Date.parse(last) >= 15 * 60 * 1000) {
      await this.refresh(); items = this.getItems();
    }
    const visible = feedItems(items, currentWindow());
    const unavailable = !visible.length && this.getMeta('scanSucceeded') !== '1';
    if (url.pathname === '/papers.html') {
      const response = homeResponse(request, renderReadingPage(visible, {
        window: currentWindow(), origin: url.origin, title: titleOf(this.env), accessKey: this.env.ACCESS_KEY,
        updatedAt: this.getMeta('contentUpdatedAt'), health: this.report().health, unavailable,
        limit: boundedInt(this.env.MAX_FEED_ITEMS, 1000, 1000)
      }), unavailable ? 503 : 200);
      response.headers.set('Content-Disposition', 'inline; filename="scholar-papers.html"');
      if (unavailable) response.headers.set('Retry-After', '900');
      return response;
    }
    if (unavailable) return new Response('No research metadata available yet. Check /status.json and retry later.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '900', 'Cache-Control': 'no-store' }
    });
    const body = renderRSS(visible, { window: currentWindow(), origin: url.origin, title: titleOf(this.env),
      updatedAt: this.getMeta('contentUpdatedAt'), limit: boundedInt(this.env.MAX_FEED_ITEMS, 1000, 1000) });
    const etag = `"${await digest(body)}"`;
    const headers = { 'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300', ETag: etag,
      'Last-Modified': new Date(this.getMeta('contentUpdatedAt')).toUTCString(),
      'X-Feed-Health': this.report().health, 'X-Content-Type-Options': 'nosniff' };
    const validators = request.headers.get('If-None-Match')?.split(',').map(value => value.trim().replace(/^W\//, '')) ?? [];
    if (validators.includes(etag) || validators.includes('*')) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : body, { headers });
  }
  home(origin, publicView = false) {
    const report = this.report(); const esc = escapeXML;
    const link = path => esc(privateURL(origin, path, this.env.ACCESS_KEY));
    const time = value => value ? esc(new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })) : '尚无记录';
    const health = { 'not-initialized': '尚未初始化', degraded: '部分来源失败或元数据不完整', healthy: '正常' }[report.health];
    const subscription = publicView ?
      `<h2>私有订阅</h2><form method="get" action="/"><label for="key">访问密钥</label><input id="key" name="key" type="password" required minlength="32" maxlength="128" pattern="[A-Za-z0-9_\\-]{32,128}" autocomplete="off"><button type="submit">查看论文与私有订阅</button></form>` :
      `<h2>私有订阅</h2><p>在 Zotero 的“新建订阅源 → 从 URL”中添加：</p>` +
      `<p><a href="${link('/feed.xml')}"><code>${link('/feed.xml')}</code></a></p>` +
      `<p><a href="${link('/papers.html')}">阅读论文结果</a> · <a href="${link('/feed.opml')}">下载私有 OPML（包含访问密钥）</a> · <a href="${link('/status.json')}">详细抓取状态</a> · <a href="${link('/sources.json')}">链接配置</a></p>` +
      `<p>完整订阅地址和 OPML 相当于访问凭证，请勿分享。</p>`;
    return htmlPage(`<h1>研究者与供应链 · 抓取状态</h1>` +
      `<p role="status">状态：${esc(health)}；窗口内 ${report.itemCount} 条，已保存 ${report.storedItemCount} 条。</p>` +
      `<p>最近尝试：${time(report.lastAttempt)}；最近成功：${time(report.lastSuccess)}（北京时间）。</p>` +
      `<p>每天北京时间 02:00、08:00、14:00、20:00 自动更新。本页仅查看已保存的抓取结果。</p>` +
      (report.health === 'not-initialized' ? `<p>尚未开始抓取。等待下一次自动更新，或使用访问密钥打开私有 RSS，启动首次抓取。</p>` : '') +
      `<p>只显示 ${esc(report.window.from)} 至 ${esc(report.window.to)}（北京时间，滚动两个月）有可核验发表日期的论文。</p><p>六位学者的论文继续追踪；UTD24、FT50、NBER、CEPR 新增论文必须在摘要中出现 supply chain、supply-chain 或供应链。缺少摘要或日期的新增论文不会推送。</p>` +
      `<h2>学者主页</h2><table><tr><th>研究者</th><th>页面状态</th></tr>` + sources.map(source => {
        const relevant = report.pages.filter(page => page.id.startsWith(`${source.id}/`));
        return `<tr><td><a href="${esc(source.homepage)}">${esc(source.name)}</a></td><td>` +
          relevant.map(page => `${esc(page.id.split('/')[1])}: ${esc(page.error ? (publicView ? '抓取失败' : page.error) : (page.checkedAt ? `成功，${page.lastGoodCount} 条` : '未检查'))}`).join('<br>') + '</td></tr>';
      }).join('') + `</table><h2>新增文献来源</h2>` +
      (report.providers.length ? `<ul>${report.providers.map(provider => `<li>${esc(provider.id)}：摘要命中 ${provider.matched}，缺摘要 ${provider.missingAbstract}，${esc(provider.error || provider.abstractFeedError ? (publicView ? '部分抓取失败' : (provider.error || provider.abstractFeedError)) : (provider.complete ? '扫描完成' : '扫描未完成'))}</li>`).join('')}</ul>` : '<p>尚未检查。</p>') +
      `<p>公开索引可能延迟或缺少摘要，不能保证穷尽；旧条目超过窗口会自动退出订阅。详细错误与覆盖缺口可在私有状态中查看。</p>` + subscription);
  }
}


