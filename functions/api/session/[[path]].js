/**
 * Wallet sign-in — Cloudflare Pages Function.
 *
 *   POST /api/session/verify   { address, nonce, issuedAt, signature }
 *                              → { token, address, expiresAt }
 *   GET  /api/session/me       (Authorization: Bearer <token>)
 *                              → { address, ok: true }
 *
 * The token this mints is what /api/history and /api/recipients accept in
 * place of a per-request signature. See functions/_session.js.
 */

import { mintSession, sessionAddress, underRateLimit, SESSION_STATEMENT } from '../../_session.js';

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
                 'Access-Control-Allow-Headers': 'Content-Type, Authorization' },
    });
  }

  const kv = env.AGENT_KV;
  if (!kv) return json(503, { error: 'session_storage_unconfigured' });

  const sub = url.pathname.replace(/^\/api\/session\/?/, '').replace(/\/+$/, '');

  // The exact string the wallet will be asked to sign, so the client never
  // has to keep its own copy in sync with the server's.
  if (request.method === 'GET' && sub === 'statement') {
    return json(200, { statement: SESSION_STATEMENT });
  }

  if (request.method === 'GET' && sub === 'me') {
    const address = await sessionAddress(kv, request);
    if (!address) return json(401, { error: 'unauthorized' });
    return json(200, { ok: true, address });
  }

  if (request.method === 'POST' && sub === 'verify') {
    // Signature verification is CPU-bound; cap how fast one IP can ask for it.
    if (!(await underRateLimit(kv, request, 'session', 20, 60)))
      return json(429, { error: 'rate_limited' });

    let body;
    try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

    const result = await mintSession(kv, body);
    if (!result.ok) {
      const status = result.error === 'signature_replayed' || result.error === 'signature_expired'
        || result.error === 'signature_invalid' ? 401 : 400;
      return json(status, { error: result.error });
    }
    return json(200, { token: result.token, address: result.address, expiresAt: result.expiresAt });
  }

  return json(404, { error: 'not_found' });
}
