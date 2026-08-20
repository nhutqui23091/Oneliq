/**
 * Cloudflare Pages Function: /auth/profile/:address
 *
 * GET    - whether this wallet has Discord linked. The Discord identity itself
 *          is returned only to the wallet that owns it.
 * DELETE - unlink Discord from this wallet. Requires that wallet's session.
 *
 * Both used to be wide open with `Access-Control-Allow-Origin: *`. That meant
 * any page on the internet could read the wallet -> Discord mapping for any
 * address — and wallet addresses are public, they are printed on our own
 * leaderboard — which turns a pseudonymous address into a named account. The
 * open DELETE was worse: one request wiped anyone's link, and with it their
 * OG badge and Discord points.
 *
 * Requires KV bindings: PROFILE_KV (profiles), AGENT_KV (session tokens).
 */

import { authorizedFor } from '../../_session.js';

export async function onRequest(context) {
  const { request, params, env } = context;
  const addr = params.address?.toLowerCase();

  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control':                'no-store',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (!addr || !/^0x[0-9a-f]{40}$/.test(addr)) {
    return new Response('Missing or invalid address.', { status: 400, headers: cors });
  }

  const kv  = env.PROFILE_KV;
  const key = `profile:${addr}`;
  const mine = await authorizedFor(env.AGENT_KV, request, addr);

  if (request.method === 'GET') {
    const val = kv ? await kv.get(key) : null;
    if (!val) {
      return new Response(null, { status: 404, headers: cors });
    }
    // Signed in as this wallet: the full record, as before.
    if (mine) {
      return new Response(val, {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    // Anyone else — including this wallet before it signs in — learns only
    // that a link exists, which is what the UI needs to tick the task off.
    let parsed = {};
    try { parsed = JSON.parse(val) || {}; } catch {}
    return new Response(JSON.stringify({ linked: !!parsed.discord_id, said_gm: !!parsed.said_gm }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (request.method === 'DELETE') {
    if (!mine) {
      return new Response(
        JSON.stringify({ error: 'Sign in with this wallet to unlink Discord.' }),
        { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }
    if (kv) {
      // Release the reverse index too, or the Discord account stays bound to
      // this wallet and can never be linked anywhere again.
      let prev = {};
      try { prev = JSON.parse((await kv.get(key)) || '{}') || {}; } catch {}
      if (prev.discord_id) {
        try {
          const owner = await kv.get('dcuser:' + prev.discord_id);
          if (owner === addr) await kv.delete('dcuser:' + prev.discord_id);
        } catch { /* best effort */ }
      }
      await kv.delete(key);
    }
    return new Response(null, { status: 204, headers: cors });
  }

  return new Response('Method not allowed.', { status: 405, headers: cors });
}
