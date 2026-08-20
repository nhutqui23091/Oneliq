/**
 * Cloudflare Pages Function: /auth/discord/callback
 *
 * Receives the Discord OAuth2 authorization code, exchanges it for an access
 * token, fetches the Discord user, stores the mapping in KV, then redirects
 * back to /balance?discord_linked=1.
 *
 * Required environment variables (Cloudflare Pages > Settings > Env vars):
 *   DISCORD_CLIENT_ID      - from discord.com/developers/applications
 *   DISCORD_CLIENT_SECRET  - same source
 *   DISCORD_REDIRECT_URI   - must match exactly: https://oneliq.xyz/auth/discord/callback
 *
 * Required KV binding (Pages > Settings > Functions > KV namespace bindings):
 *   Variable name: PROFILE_KV
 *   KV namespace:  your PROFILE_KV namespace
 */
export async function onRequestGet(context) {
  const { request, env } = context;

  // Parse query params from the Discord redirect
  let code, state;
  try {
    const url = new URL(request.url);
    code  = url.searchParams.get('code');
    state = url.searchParams.get('state');
  } catch (e) {
    return errPage('Invalid request URL.', 400);
  }

  if (!code)  return errPage('Missing OAuth code from Discord. Please try connecting again.', 400);
  if (!state) return errPage('Missing state parameter. Please try connecting again.', 400);

  // `state` used to BE the wallet address. It comes back from Discord exactly
  // as it was sent, with nothing vouching for it, so anyone could run this flow
  // carrying someone else's address and have us write their Discord identity
  // onto that wallet. It is now an opaque handle minted by /auth/discord/start
  // only after the caller proved control of the wallet — the address is read
  // from our own storage, never from the query string.
  if (!env.PROFILE_KV) return errPage('Profile storage is not configured on this server.', 503);

  const stateKey = 'dcstate:' + String(state);
  let pending = null;
  try { pending = JSON.parse((await env.PROFILE_KV.get(stateKey)) || 'null'); } catch {}
  if (!pending || !/^0x[0-9a-f]{40}$/.test(pending.addr || '')) {
    return errPage(
      'This Discord link request has expired or was not started from Oneliq. ' +
      'Open the Profile menu and press Connect Discord again.',
      400
    );
  }
  // Spend it — one code, one link.
  try { await env.PROFILE_KV.delete(stateKey); } catch {}

  const walletAddr = pending.addr;
  const destPath = pending.returnTo === 'portal' ? '/portal' : '/balance';

  const clientId     = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  const redirectUri  = env.DISCORD_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.error('[discord-cb] env vars missing - clientId:', !!clientId,
      'clientSecret:', !!clientSecret, 'redirectUri:', redirectUri || '(unset)');
    return errPage(
      'Discord OAuth is not fully configured on this server. ' +
      'Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DISCORD_REDIRECT_URI in Cloudflare Pages environment variables.',
      503
    );
  }

  try {
    // Build form body with explicit .append() calls (most portable)
    const form = new URLSearchParams();
    form.append('client_id',     clientId);
    form.append('client_secret', clientSecret);
    form.append('grant_type',    'authorization_code');
    form.append('code',          code);
    form.append('redirect_uri',  redirectUri);

    // Exchange authorization code for access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    form.toString(),
    });

    // Read body once as text, then parse (avoids double-read errors)
    const tokenText = await tokenRes.text();

    if (!tokenRes.ok) {
      console.error('[discord-cb] token exchange failed:', tokenRes.status, tokenText);
      // 400 from Discord usually means expired code or redirect_uri mismatch
      return errPage(
        'Discord rejected the token exchange (HTTP ' + tokenRes.status + '). ' +
        'The authorization code may have expired (they last only 60 s), or ' +
        'DISCORD_REDIRECT_URI does not match the redirect URI registered in your Discord app. ' +
        'Please try connecting Discord again.',
        400
      );
    }

    let tokenData;
    try {
      tokenData = JSON.parse(tokenText);
    } catch (parseErr) {
      console.error('[discord-cb] could not parse token JSON:', tokenText);
      return errPage('Unexpected response format from Discord. Please try again.', 502);
    }

    const accessToken = tokenData.access_token;
    if (!accessToken) {
      console.error('[discord-cb] access_token missing in response:', tokenText);
      return errPage('Discord did not return an access token. Please try again.', 502);
    }

    // Fetch Discord user identity
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + accessToken },
    });

    if (!userRes.ok) {
      const userText = await userRes.text();
      console.error('[discord-cb] user fetch failed:', userRes.status, userText);
      return errPage('Failed to fetch your Discord user info (HTTP ' + userRes.status + '). Please try again.', 502);
    }

    const user = await userRes.json();

    if (!user || !user.id) {
      console.error('[discord-cb] Discord user has no id:', JSON.stringify(user));
      return errPage('Discord returned unexpected user data. Please try again.', 502);
    }

    console.log('[discord-cb] linked Discord account to wallet', walletAddr.slice(0, 10) + '...');

    // One Discord account, one wallet. Without this, a single account could be
    // linked to any number of wallets and collect the Discord star bonus and
    // the OG badge on all of them.
    const ownerKey = 'dcuser:' + user.id;
    let boundTo = null;
    try { boundTo = await env.PROFILE_KV.get(ownerKey); } catch {}
    if (boundTo && boundTo !== walletAddr) {
      return errPage(
        'This Discord account is already linked to a different wallet. ' +
        'Unlink it there first, then try again.',
        409
      );
    }

    // Store wallet <-> Discord mapping in KV. Preserve any existing profile
    // fields (e.g. said_gm) by merging rather than overwriting.
    let prev = {};
    try { const r = await env.PROFILE_KV.get('profile:' + walletAddr); if (r) prev = JSON.parse(r); } catch {}
    await env.PROFILE_KV.put(
      'profile:' + walletAddr,
      JSON.stringify({
        ...prev,
        discord_id:          user.id,
        discord_username:    user.username,
        discord_global_name: user.global_name || user.username,
        linked_at:           new Date().toISOString(),
      })
    );
    await env.PROFILE_KV.put(ownerKey, walletAddr);

    // Redirect back to the page the user started from, with a success flag.
    const origin = new URL(request.url).origin;
    return Response.redirect(origin + destPath + '?discord_linked=1', 302);

  } catch (err) {
    console.error('[discord-cb] unexpected error:', err && err.message, err && err.stack);
    // The detail goes to the server log, not to the page — an error string can
    // carry values we never meant to show a visitor.
    return errPage('An unexpected error occurred. Please try connecting Discord again.', 500);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Returns a simple HTML error page with a "Return to Balance" link.
 * Uses a styled dark-theme page matching the Oneliq design system.
 */
function errPage(message, status) {
  const html =
    '<!DOCTYPE html><html lang="en"><head>' +
    '<meta charset="UTF-8"/>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
    '<title>Discord Connection Error</title>' +
    '<style>' +
    'body{margin:0;padding:0;background:#0A1628;color:#F5F7FB;font-family:system-ui,-apple-system,sans-serif;' +
      'display:flex;align-items:center;justify-content:center;min-height:100vh}' +
    '.box{max-width:480px;width:calc(100% - 40px);padding:32px;border:1px solid rgba(255,255,255,.10);' +
      'border-radius:16px;background:rgba(255,255,255,.03)}' +
    'h1{font-size:18px;font-weight:700;color:#FF7A7A;margin:0 0 14px}' +
    'p{font-size:14px;color:#A4B8D0;line-height:1.65;margin:0 0 20px}' +
    '.status{font-family:monospace;font-size:11px;color:#7E92AE;margin-bottom:16px}' +
    'a{display:inline-block;padding:10px 20px;border-radius:10px;background:rgba(77,214,219,.12);' +
      'border:1px solid rgba(77,214,219,.35);color:#4DD6DB;text-decoration:none;font-size:13px;font-weight:600}' +
    '</style></head><body>' +
    '<div class="box">' +
    '<div class="status">HTTP ' + Number(status) + ' - Discord OAuth Callback</div>' +
    '<h1>Discord connection failed</h1>' +
    '<p>' + escapeHtml(message) + '</p>' +
    '<a href="/balance">Return to Balance</a>' +
    '</div></body></html>';
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html;charset=utf-8' },
  });
}
