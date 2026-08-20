/**
 * Cloudflare Pages Function: /auth/discord/start
 *
 * Begins the Discord OAuth flow.
 *
 * This endpoint exists because the old flow put the wallet address straight
 * into the OAuth `state` parameter. `state` comes back from Discord unchanged
 * and unverified, so anyone could run the flow with somebody else's address in
 * it and have the callback write their Discord identity onto that wallet's
 * profile. That is a write to another user's record, and — because the profile
 * menu renders the linked display name — it was also a way to get markup into
 * another user's page.
 *
 * So `state` is now an opaque random value that only this endpoint mints, only
 * after the caller has proved it controls the wallet, and the callback spends
 * it once. Nothing user-supplied crosses Discord and comes back trusted.
 *
 *   POST { address, returnTo }   Authorization: Bearer <session token>
 *     -> { url }                 client navigates there
 *
 * Requires KV bindings: AGENT_KV (session tokens), PROFILE_KV (pending states).
 */

import { authorizedFor, underRateLimit } from '../../_session.js';

const STATE_TTL_S = 10 * 60;   // an unfinished link expires in ten minutes

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age':       '86400',
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const clientId    = env.DISCORD_CLIENT_ID;
  const redirectUri = env.DISCORD_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return json({ error: 'Discord is not configured on this server.' }, 503);
  }
  if (!env.PROFILE_KV) return json({ error: 'KV not configured' }, 503);

  if (!(await underRateLimit(env.AGENT_KV, request, 'dcstart', 10, 60))) {
    return json({ error: 'Too many attempts. Wait a minute and try again.' }, 429);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const addr = String(body.address || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return json({ error: 'Invalid address' }, 400);

  if (!(await authorizedFor(env.AGENT_KV, request, addr))) {
    return json({ error: 'Sign in with this wallet before linking Discord.' }, 401);
  }

  // Only two destinations exist. Anything else falls back rather than being
  // echoed into a redirect.
  const returnTo = body.returnTo === 'portal' ? 'portal' : 'balance';

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let state = '';
  for (const b of bytes) state += b.toString(16).padStart(2, '0');

  await env.PROFILE_KV.put(
    'dcstate:' + state,
    JSON.stringify({ addr, returnTo, createdAt: Date.now() }),
    { expirationTtl: STATE_TTL_S }
  );

  const url = 'https://discord.com/oauth2/authorize'
    + '?client_id='     + encodeURIComponent(clientId)
    + '&redirect_uri='  + encodeURIComponent(redirectUri)
    + '&response_type=code&scope=identify'
    + '&state='         + encodeURIComponent(state);

  return json({ url });
}
