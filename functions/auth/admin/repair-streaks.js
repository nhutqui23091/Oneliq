/**
 * Cloudflare Pages Function: /auth/admin/repair-streaks
 *
 * One-time (idempotent) restore. The streak used to be tracked with a single
 * step-compare against last_checkin, which (a) couldn't bridge multi-day gaps
 * and (b) could be permanently truncated by one bad write. We've switched to a
 * freeze-budget rule recomputed from the full check-in history (see
 * functions/auth/_streak.js). This pass recomputes streak / freezes_left /
 * longest_streak from each wallet's `history` and writes the corrected values
 * back — every other field (referrals, badges, stars, x_handle, …) is preserved.
 *
 * Auth: X-Debug-Key header must match env.DEBUG_KEY (same gate as the other
 * admin endpoints). GET = dry-run preview (no writes). POST = apply.
 * Idempotent — safe to run more than once.
 *
 * Operator workflow:
 *   1. Cloudflare Pages → Settings → Variables → DEBUG_KEY must be set.
 *   2. curl -H "X-Debug-Key: <value>" https://oneliq.xyz/auth/admin/repair-streaks       (preview)
 *   3. curl -X POST -H "X-Debug-Key: <value>" https://oneliq.xyz/auth/admin/repair-streaks   (apply)
 */

import { computeStreak } from '../_streak.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (request.method !== 'GET' && request.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const provided = request.headers.get('X-Debug-Key') || '';
  if (!env.DEBUG_KEY) return json(503, { error: 'disabled', message: 'Set DEBUG_KEY env var on Cloudflare Pages to enable this endpoint (delete after use).' });
  if (provided !== env.DEBUG_KEY) return json(401, { error: 'unauthorized' });

  const kv = env.PROFILE_KV;
  if (!kv) return json(503, { error: 'KV not configured' });

  const apply = request.method === 'POST';

  // 1. Walk every gm record (skip the gm:daily:* counters).
  const changes = [];
  let scanned = 0, changed = 0;
  let cursor;
  do {
    const list = await kv.list({ prefix: 'gm:', cursor, limit: 1000 });
    for (const k of list.keys) {
      if (k.name.startsWith('gm:daily:')) continue;
      const addr = k.name.slice(3);
      if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
      scanned++;

      let st;
      try { st = JSON.parse(await kv.get(k.name) || '{}'); } catch { continue; }
      const history = Array.isArray(st.history) ? st.history : [];
      if (history.length === 0) continue; // never checked in — nothing to recompute

      const { streak, freezes_left, longest } = computeStreak(history);
      const newLongest = Math.max(st.longest_streak || 0, longest);

      const same = (st.streak || 0) === streak
        && (typeof st.freezes_left === 'number' ? st.freezes_left : 3) === freezes_left
        && (st.longest_streak || 0) === newLongest;
      if (same) continue;

      changed++;
      if (changes.length < 100) {
        changes.push({ addr: addr.slice(0, 10), streak_before: st.streak ?? null, streak_after: streak,
          freezes_before: st.freezes_left ?? null, freezes_after: freezes_left });
      }

      if (apply) {
        // Spread existing state first so nothing else is dropped.
        await kv.put(k.name, JSON.stringify({ ...st, streak, freezes_left, longest_streak: newLongest }));
      }
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);

  // Drop the cached leaderboard so corrected values surface immediately.
  if (apply) { try { await kv.delete('lb:cache:v3'); } catch {} }

  return json(200, {
    applied: apply,
    scanned,
    changed,
    changes,
    note: apply ? 'Applied. Leaderboard cache cleared.' : 'Dry run — re-send as POST to apply.',
  });
}

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Debug-Key',
  };
}

function json(status, data) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}
