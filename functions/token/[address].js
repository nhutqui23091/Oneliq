// /token/<address> — legacy alias, serves the same token detail page.
// See ../coin/[address].js for the full rationale (CF's .html clean-URL
// redirect strips queries from _redirects targets, so we serve via
// Function to bypass it).
export async function onRequest(context) {
  const req = context.request;
  const url = new URL(req.url);
  const assetUrl = new URL('/token.html', url.origin);
  const res = await context.env.ASSETS.fetch(new Request(assetUrl.toString(), req));
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-store, must-revalidate');
  return new Response(res.body, { status: res.status, headers });
}
