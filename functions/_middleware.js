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

/* ────────────────────────────────────────────────────────────
   Content Security Policy: inline script by nonce, not by trust

   The policy in _headers used to allow 'unsafe-inline' for scripts, which
   means the browser will run ANY inline script it finds in the page —
   including one an attacker managed to get into the DOM. That single keyword
   is what turns a stray unescaped string into code execution.

   Every page now carries its behaviour in data-* markers instead of on*=
   attributes, so inline handlers are no longer needed at all. What remains is
   the one big <script> block per page, and each of those gets a fresh random
   nonce here on every response. An injected script has no nonce, so it does
   not run — and the nonce cannot be predicted or reused, since it changes per
   request.

   The allowlists themselves still live in _headers. This only rewrites the
   script-src directive, so there is one place to edit when a host changes.
   If anything here throws, the original response goes out untouched: a
   working page under the old policy beats a blank one.
   ──────────────────────────────────────────────────────────── */

function newNonce() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/=+$/, '');
}

function cspWithNonce(csp, nonce) {
  const src = `'nonce-${nonce}'`;
  if (/script-src[^;]*'unsafe-inline'/.test(csp)) {
    return csp.replace(/script-src([^;]*)/, (m, rest) =>
      'script-src' + rest.replace(/'unsafe-inline'/g, src));
  }
  if (/script-src/.test(csp)) {
    return csp.replace(/script-src/, `script-src ${src}`);
  }
  return csp;
}

async function withCsp(context, response) {
  try {
    const type = response.headers.get('Content-Type') || '';
    if (!type.includes('text/html')) return response;

    const csp = response.headers.get('Content-Security-Policy');
    if (!csp) return response;

    const nonce = newNonce();
    const rewritten = new HTMLRewriter()
      .on('script', {
        element(el) {
          // External scripts are already constrained by host; only inline
          // blocks need to prove they were in the page we served.
          if (!el.hasAttribute('src')) el.setAttribute('nonce', nonce);
        },
      })
      .transform(response);

    const out = new Response(rewritten.body, {
      status: rewritten.status,
      statusText: rewritten.statusText,
      headers: new Headers(rewritten.headers),
    });
    out.headers.set('Content-Security-Policy', cspWithNonce(csp, nonce));
    return out;
  } catch (err) {
    console.error('[csp] nonce injection failed:', err && err.message);
    return response;
  }
}

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
    return withCsp(context, await context.next());
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

  return withCsp(context, await context.next());
}
