// /explore/tokens/arc/<address> — Uniswap-style canonical URL.
// Same trick as ../../coin/[address].js: serve token.html via the ASSETS
// binding so the browser stays at /explore/tokens/arc/<addr> and CF's
// .html clean-URL redirect never fires (it would strip the query).
export async function onRequest(context) {
  const req = context.request;
  const url = new URL(req.url);
  const assetUrl = new URL('/token.html', url.origin);
  const res = await context.env.ASSETS.fetch(new Request(assetUrl.toString(), req));
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-store, must-revalidate');
  return new Response(res.body, { status: res.status, headers });
}
