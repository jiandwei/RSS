import { Miniflare } from 'miniflare';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sources from '../sources.json' with { type: 'json' };

// Optional snapshots let the same native Worker parse pages previously fetched
// from a network where academic domains are accessible. Not needed in production.
const args = process.argv.slice(2);
const snapshotsIndex = args.indexOf('--snapshots');
const snapshots = snapshotsIndex >= 0 ? args[snapshotsIndex + 1] : null;
const pageMap = new Map(sources.flatMap(source => source.pages.map(page => [page.url, `${source.id}--${page.id}.html`])));
const mf = new Miniflare({
  modules: true, scriptPath: resolve('dist/index.js'), compatibilityDate: '2026-07-01',
  durableObjects: { FEED_STORE: { className: 'FeedStore', useSQLite: true } },
  bindings: { MAX_FEED_ITEMS: '1000' },
  outboundService: async request => {
    if (!snapshots) return fetch(request.url, { headers: { 'User-Agent': 'ScholarRSS/1.0', Accept: 'text/html' } });
    try {
      const body = await readFile(resolve(snapshots, pageMap.get(request.url)), 'utf8');
      return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    } catch { return new Response('Snapshot unavailable', { status: 503 }); }
  }
});
try {
  const response = await mf.dispatchFetch('https://validation.example/feed.xml');
  const report = await (await mf.dispatchFetch('https://validation.example/status.json')).json();
  await mkdir('.scratch', { recursive: true });
  if (response.ok) await writeFile('.scratch/validated-feed.xml', await response.text());
  await writeFile('.scratch/source-report.json', JSON.stringify(report, null, 2) + '\n');
  for (const page of report.pages) console.log(`${page.researcher} / ${page.id.split('/')[1]}: ${page.error ?? `${page.lastGoodCount} papers`}`);
  console.log(`Merged history: ${report.itemCount} items. Feed HTTP ${response.status}.`);
  if ((!response.ok || report.health !== 'healthy') && !args.includes('--allow-errors')) process.exitCode = 1;
} finally { await mf.dispose(); }
