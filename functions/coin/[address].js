// /coin/<address> — dynamic token detail route.
//
// Why a Function and not just a _redirects rewrite: CF Pages layers a
// "clean URL" 308 redirect on top of any response served from a .html
// file — even when it was reached via a 200 rewrite. That layer strips
// the query string, so `/coin/0xABC` → rewrite to `/token.html?a=0xABC`
// → 308 to `/token` (no query). The address gets nuked in transit.
//
// Serving through a Function bypasses that redirect entirely: env.ASSETS
// hands us the static token.html bytes and we return them verbatim under
// the original request URL. The client's location.pathname is still
// `/coin/0xABC`, so token.html's path-based address parser reads it.
export async function onRequest(context) {
  const req = context.request;
  const url = new URL(req.url);
  // Fetch the underlying static file. The URL we hand ASSETS is the
  // file path we want; the response we return keeps the request's URL
  // in the browser's address bar, so client-side JS sees /coin/<addr>.
  const assetUrl = new URL('/token.html', url.origin);
  const res = await context.env.ASSETS.fetch(new Request(assetUrl.toString(), req));
  // Rewrap so Cache-Control / CSP headers can be tweaked without mutating
  // ASSETS's cached response (which the platform reuses across invocations).
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-store, must-revalidate');
  return new Response(res.body, { status: res.status, headers });
}
