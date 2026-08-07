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

  if (gotUser !== user || gotPass !== pass) {
    return unauthorized();
  }

  return context.next();
}
