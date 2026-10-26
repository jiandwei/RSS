// Calendar dates, not 60 * 24 hours. Month-end subtraction clamps (Oct 31 -> Aug 31).
export function dateWindow(now = new Date(), months = 2, timeZone = 'Asia/Shanghai') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const to = `${parts.year}-${parts.month}-${parts.day}`;
  const target = new Date(Date.UTC(+parts.year, +parts.month - 1 - months, 1));
  const day = Math.min(+parts.day, new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate());
  const from = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { from, to, months, timeZone };
}

export function publicationDate(parts, source) {
  if (!Array.isArray(parts) || parts.length < 2) return null; // Year-only is too imprecise.
  const [y, m, d = 1] = parts;
  if (!Number.isInteger(y) || y < 1900 || y > 2200 || !Number.isInteger(m) || m < 1 || m > 12 ||
      !Number.isInteger(d) || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return { value: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    precision: parts.length >= 3 ? 'day' : 'month', source };
}

export function crossrefDate(work) {
  // Earliest publication of this DOI. A recent print issue must not resurface an old online article.
  const explicit = ['published-online', 'published-print'].map(key =>
    publicationDate(work[key]?.['date-parts']?.[0], `Crossref ${key}`)).filter(Boolean);
  const dates = explicit.length ? explicit : ['published', 'issued'].map(key =>
    publicationDate(work[key]?.['date-parts']?.[0], `Crossref ${key}`)).filter(Boolean);
  const first = dates.sort((a, b) => a.value.localeCompare(b.value) || a.precision.localeCompare(b.precision))[0] ?? null;
  const keys = explicit.length ? ['published-online', 'published-print'] : ['published', 'issued'];
  // A year-only earlier publication cannot be repaired with a more recent print/issued date.
  if (first && keys.some(key => {
    const parts = work[key]?.['date-parts']?.[0];
    return parts?.length === 1 && Number.isInteger(parts[0]) && parts[0] <= Number(first.value.slice(0, 4));
  })) return null;
  return first;
}

export function rssDate(value) {
  if (typeof value !== 'string') return null;
  // Preserve the publisher's calendar date rather than shifting midnight across UTC boundaries.
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
  if (iso) return publicationDate(iso.slice(1).map(Number), 'Publisher RSS pubDate');
  const rfc = value.match(/(?:^|,\s*)(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s/);
  if (!rfc) return null;
  const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(rfc[2].toLowerCase()) + 1;
  return publicationDate([+rfc[3], month, +rfc[1]], 'Publisher RSS pubDate');
}

export function inWindow(date, window) {
  return Boolean(date && ['day', 'month'].includes(date.precision) &&
    date.value >= window.from && date.value <= window.to);
}
