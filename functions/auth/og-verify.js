/**
 * Cloudflare Pages Function: /auth/og-verify
 * POST { address } -> verify Discord OG role via bot token, award og badge
 *
 * Required env vars (Cloudflare Pages > Settings > Environment variables):
 *   ONELIQ_GUILD_ID      - Discord server (guild) ID
 *   ONELIQ_OG_ROLE_ID    - Role ID for OG in that server
 *   DISCORD_BOT_TOKEN    - Bot token with Guild Members Intent
 *
 * Required KV binding: PROFILE_KV
 * User must have Discord linked (profile:${address} must contain discord_id).
 */

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsOk();
  if (request.method !== 'POST') return jsonRes({ error: 'Method not allowed' }, 405);

  const kv = env.PROFILE_KV;
  if (!kv) return jsonRes({ error: 'KV not configured' }, 503);

  let body;
  try { body = await request.json(); }
  catch { return jsonRes({ error: 'Invalid JSON body' }, 400); }

  const addr = (body.address || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return jsonRes({ error: 'Invalid address' }, 400);
  }

  // Graceful degrade if env vars not configured yet
  const guildId  = env.ONELIQ_GUILD_ID;
  const ogRoleId = env.ONELIQ_OG_ROLE_ID;
  const botToken = env.DISCORD_BOT_TOKEN;

  if (!guildId || !ogRoleId || !botToken) {
    return jsonRes({
      error: 'OG verification not configured. Set ONELIQ_GUILD_ID, ONELIQ_OG_ROLE_ID, and DISCORD_BOT_TOKEN in Cloudflare Pages env vars.',
    }, 503);
  }

  // Read Discord ID from profile KV
  const profileRaw = await kv.get('profile:' + addr);
  if (!profileRaw) {
    return jsonRes({ error: 'Discord not linked. Link Discord in Profile first.' }, 400);
  }

  let profile;
  try { profile = JSON.parse(profileRaw); }
  catch { return jsonRes({ error: 'Invalid profile data.' }, 500); }

  const discordId = profile.discord_id;
  if (!discordId) {
    return jsonRes({ error: 'Discord ID not found. Re-link Discord in Profile.' }, 400);
  }

  // Fetch guild member via bot token
  let member;
  try {
    const res = await fetch(
      'https://discord.com/api/guilds/' + guildId + '/members/' + discordId,
      { headers: { Authorization: 'Bot ' + botToken } }
    );

    if (res.status === 404) {
      return jsonRes({ awarded: false, message: 'You are not a member of the Oneliq Discord server.' });
    }
    if (res.status === 403) {
      console.error('[og-verify] Bot lacks permission to read guild members.');
      return jsonRes({ error: 'Bot missing permission. Ensure bot has Guild Members Intent and is in the server.' }, 502);
    }
    if (!res.ok) {
      const t = await res.text();
      console.error('[og-verify] Discord API error:', res.status, t);
      return jsonRes({ error: 'Discord API error (' + res.status + ').' }, 502);
    }

    member = await res.json();
  } catch(e) {
    console.error('[og-verify] fetch failed:', e?.message);
    return jsonRes({ error: 'Failed to reach Discord API: ' + (e?.message || String(e)) }, 502);
  }

  const hasOgRole = Array.isArray(member.roles) && member.roles.includes(ogRoleId);
  if (!hasOgRole) {
    return jsonRes({ awarded: false, message: 'OG role not found in your Discord roles.' });
  }

  // Award og badge to GM state
  const gmRaw = await kv.get('gm:' + addr);
  let gmState = {};
  try { if (gmRaw) gmState = JSON.parse(gmRaw); } catch {}

  const badges = [...(gmState.badges || [])];
  if (!badges.includes('og')) badges.push('og');

  await kv.put('gm:' + addr, JSON.stringify({ ...gmState, badges }));

  return jsonRes({ awarded: true, badges });
}

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function corsOk() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
