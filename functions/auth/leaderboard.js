/**
 * Cloudflare Pages Function: /auth/leaderboard
 * GET -> { invites: [...], stars: [...], updated_at }
 *
 * Two rankings for the Portal leaderboard modal:
 *   invites - top wallets by credited referrals (friends who reached Welcome)
 *   stars   - top wallets by Star Points
 *
 * Built from a single PROFILE_KV scan of `gm:` records, which the gm GET
 * handler denormalises (`stars`, `discord_name`, `x_handle`) onto. The result
 * is cached in KV for 60s so a busy modal doesn't re-scan every open.
 *
 * Display name preference: X handle -> Discord name -> shortened address.
 */

import { computeStars } from './_stars.js';

const CACHE_KEY = 'lb:cache:v2';
const CACHE_TTL = 60;   // seconds
const TOP_N     = 25;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsOk();
  if (request.method !== 'GET') return jsonRes({ error: 'Method not allowed' }, 405);

  const kv = env.PROFILE_KV;
  if (!kv) return jsonRes({ error: 'KV not configured' }, 503);

  // Serve cached board if fresh.
  try {
    const cached = await kv.get(CACHE_KEY);
    if (cached) return jsonRes(JSON.parse(cached));
  } catch {}

  const board = await buildBoard(kv);

  try { await kv.put(CACHE_KEY, JSON.stringify(board), { expirationTtl: CACHE_TTL }); } catch {}
  return jsonRes(board);
}

async function buildBoard(kv) {
  const rows = [];

  // Enumerate gm:${addr} records, skipping the gm:daily:* counters.
  let cursor;
  do {
    const list = await kv.list({ prefix: 'gm:', cursor, limit: 1000 });
    for (const k of list.keys) {
      const name = k.name;
      if (name.startsWith('gm:daily:')) continue;
      const addr = name.slice(3); // strip "gm:"
      if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;

      let st;
      try { st = JSON.parse(await kv.get(name) || '{}'); } catch { continue; }

      // Recompute fresh from the gm record (gm GET denormalises discord_done +
      // said_gm), so referral credits and badges earned since the user's last
      // visit are always reflected — never a stale denormalised total.
      const stars = computeStars(st, { discord_id: st.discord_done, said_gm: st.said_gm });
      const invites = Math.max(0, st.referral_count || 0);
      if (stars <= 0 && invites <= 0) continue;

      rows.push({
        addr,
        name:  displayName(st, addr),
        stars,
        invites,
        verified: !!(st.x_handle), // has a saved X handle
      });
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);

  const invites = rows
    .filter(r => r.invites > 0)
    .sort((a, b) => b.invites - a.invites || b.stars - a.stars)
    .slice(0, TOP_N)
    .map(({ addr, name, invites, stars }) => ({ addr, name, invites, stars }));

  const stars = rows
    .filter(r => r.stars > 0)
    .sort((a, b) => b.stars - a.stars || b.invites - a.invites)
    .slice(0, TOP_N)
    .map(({ addr, name, stars, invites }) => ({ addr, name, stars, invites }));

  return { invites, stars, total: rows.length, updated_at: Date.now() };
}

function displayName(st, addr) {
  if (st.x_handle)      return '@' + st.x_handle;
  if (st.discord_name)  return st.discord_name;
  return addr.slice(0, 6) + '…' + addr.slice(-4);
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
