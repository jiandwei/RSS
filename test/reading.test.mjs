import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReadingPage } from '../src/reading.mjs';

const options = { title: 'Research & Supply Chains', origin: 'https://rss.example', accessKey: 'test-reader-secret-0123456789abcdef0123456789',
  window: { from: '2026-08-27', to: '2026-10-27', timeZone: 'Asia/Shanghai' }, updatedAt: '2026-10-27T00:00:00Z', health: 'healthy' };
const paper = { title: 'Research on Supply Networks', url: 'https://example.com/paper?a=1&b=2', authors: ['A. Author'], categories: ['FT50'],
  date: { value: '2026-10-01', precision: 'month', source: 'Publisher' }, records: [], abstract: 'Evidence about supply chains.' };

test('reading file escapes untrusted text and refuses unsafe paper URLs', () => {
  const html = renderReadingPage([{ ...paper, title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)',
    categories: ['<script>bad</script>'], authors: ['<img src=y>'], abstract: '<script>bad</script>' }], options);
  assert.doesNotMatch(html, /<script\b|<img\b|href="javascript:/i);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /2026-10（[\s\S]*月精度/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
});

test('reading file uses the RSS limit and distinguishes empty results from source failures', () => {
  const html = renderReadingPage([paper, { ...paper, title: 'Another Research Paper' }], { ...options, limit: 1 });
  assert.equal((html.match(/<article class="paper">/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Another Research Paper/);
  assert.match(html, /共有 2 篇符合条件/);
  assert.match(html, /href="https:\/\/example.com\/paper\?a=1&amp;b=2"/);
  assert.match(renderReadingPage([], options), /暂时没有符合条件的论文/);
  const failed = renderReadingPage([], { ...options, unavailable: true, health: 'degraded' });
  assert.match(failed, /暂未取得可用的论文数据/);
  assert.doesNotMatch(failed, /暂时没有符合条件的论文/);
});
