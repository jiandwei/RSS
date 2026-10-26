import { digest } from './feed.mjs';

// A missing, weak or example access key must never turn the service public.
export function hasAccessKey(env) {
  return typeof env.ACCESS_KEY === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(env.ACCESS_KEY) &&
    !/^(?:replace|example|changeme)/i.test(env.ACCESS_KEY);
}

export async function matchesSecret(supplied, expected) {
  if (typeof expected !== 'string' || !expected || !supplied || supplied.length > 256) return false;
  const a = await digest(supplied); const b = await digest(expected);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

export async function authorizeRead(request, env) {
  const header = request.headers.get('Authorization');
  // An explicitly supplied bad header must not fall back to another credential.
  if (header !== null) {
    const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(header);
    return !!match && matchesSecret(match[1], env.ACCESS_KEY);
  }
  const values = new URL(request.url).searchParams.getAll('key');
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{32,128}$/.test(values[0])) return false;
  return matchesSecret(values[0], env.ACCESS_KEY);
}

export function privateURL(origin, path, key) {
  const url = new URL(path, origin);
  url.searchParams.set('key', key);
  return url.href;
}

export function privateResponse(response) {
  const headers = new Headers(response.headers);
  // No public cache may serve a previously authorized response to another reader.
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  headers.append('Vary', 'Authorization');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
