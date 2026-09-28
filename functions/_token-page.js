// Shared handler for every token-detail route (/coin/<addr>,
// /token/<addr>, /explore/tokens/arc/<addr>).
//
// Why this exists: CF Pages puts a "clean URL" layer in front of anything
// that resolves to a .html file — it 308s `/token.html` to `/token` and
// drops the query string on the way. That layer applies to the ASSETS
// binding too, so a naive `env.ASSETS.fetch('/token.html')` hands back a
// 308 rather than the page bytes. Returning that verbatim is what sent
// users to a bare `/token` with no address.
//
// So: ask ASSETS for the clean path, and if it still answers with a
// redirect, follow it once and serve the final hop. The browser never
// sees a 3xx, stays on the original URL, and token.html's path parser
// reads the address out of location.pathname.
export async function serveTokenPage(context) {
  const req = context.request;
  const origin = new URL(req.url).origin;

  const get = (path) =>
    context.env.ASSETS.fetch(new Request(new URL(path, origin).toString(), req));

  let res = await get('/token');
  // One hop is enough in practice; the loop guard is cheap insurance
  // against a config change turning this into a redirect chain.
  for (let i = 0; i < 3 && res.status >= 300 && res.status < 400; i++) {
    const loc = res.headers.get('Location');
    if (!loc) break;
    res = await get(loc);
  }

  const headers = new Headers(res.headers);
  // Strip any redirect metadata that survived the follow, otherwise the
  // browser would chase it and we'd be back to a bare /token.
  headers.delete('Location');
  headers.set('Cache-Control', 'no-store, must-revalidate');
  headers.set('Content-Type', 'text/html; charset=utf-8');

  return new Response(res.body, { status: 200, headers });
}
