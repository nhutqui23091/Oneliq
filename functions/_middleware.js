// Page-level access gate.
//
// Locks the (operator) console page so only the operator can view it.
// Credentials come from Cloudflare Pages env vars (Settings → Environment
// variables → Production):
//   POOL_AUTH_USER  — username (anything you want; legacy var name from
//                     when /pool was the gated surface — kept for stability)
//   POOL_AUTH_PASS  — password
//
// If either env var is missing, the gate FAILS CLOSED (503) rather than
// silently exposing the page.
//
// The gated operator console lives at /ops. /dashboard is now the PUBLIC
// user dashboard (portfolio, holdings, history) and passes straight through
// — they're different surfaces.
//
// Note on logout: HTTP Basic Auth has no real logout. Close the browser /
// use an incognito window if you need to clear credentials.

const REALM = 'Oneliq — Private';

function isProtected(pathname) {
  return (
    pathname === '/ops' ||
    pathname === '/ops/' ||
    pathname === '/ops.html' ||
    pathname.startsWith('/ops/')
  );
}

/**
 * Compare two strings without letting the time taken reveal how much of the
 * prefix matched. Over the public internet the signal is buried in jitter, but
 * a password check is the last place to leave one on the floor.
 */
function timingSafeEqual(a, b) {
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Basic Auth has no lockout of its own, so a wrong password can be retried as
 * fast as the network allows. Fixed window per IP, best effort — KV is
 * eventually consistent, and this is a speed bump, not a quota.
 */
async function tooManyAttempts(kv, request) {
  if (!kv) return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `rl:opsauth:${ip}:${Math.floor(Date.now() / 300000)}`;   // 5 min
  try {
    const n = parseInt((await kv.get(key)) || '0', 10) || 0;
    if (n >= 20) return true;
    await kv.put(key, String(n + 1), { expirationTtl: 600 });
  } catch { /* storage trouble must not lock the operator out */ }
  return false;
}

function unauthorized() {
  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);

  // Anything outside the protected path passes straight through.
  if (!isProtected(url.pathname)) {
    return context.next();
  }

  const user = context.env.POOL_AUTH_USER;
  const pass = context.env.POOL_AUTH_PASS;

  if (!user || !pass) {
    return new Response(
      'Dashboard access is not configured. Set POOL_AUTH_USER and POOL_AUTH_PASS in Cloudflare Pages env vars.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }

  if (await tooManyAttempts(context.env.AGENT_KV, context.request)) {
    return new Response('Too many attempts. Try again in a few minutes.', {
      status: 429,
      headers: { 'Retry-After': '300', 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const header = context.request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) {
    return unauthorized();
  }

  let decoded;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return unauthorized();
  }

  // Split on the FIRST colon — passwords may contain colons.
  const idx = decoded.indexOf(':');
  if (idx < 0) return unauthorized();
  const gotUser = decoded.slice(0, idx);
  const gotPass = decoded.slice(idx + 1);

  // Both halves always compared, so a right username and a wrong one cost the
  // same.
  const okUser = timingSafeEqual(gotUser, user);
  const okPass = timingSafeEqual(gotPass, pass);
  if (!okUser || !okPass) {
    return unauthorized();
  }

  return context.next();
}
