/**
 * Cloudflare Pages Function: /auth/admin/backup
 *
 * Snapshot + restore for all Portal user data in PROFILE_KV.
 *
 *   GET  -> export every durable record (gm:, profile:, refcode:) as one JSON
 *           document. Save it as a file — that file is your backup.
 *   POST -> restore from a previously exported document (sent as the request
 *           body). Dry-run by default; add ?confirm=1 to actually write.
 *
 * What's covered: per-wallet gm state (streak, points/stars inputs, badges,
 * referrals, x_handle, …), Discord profiles, and referral-code lookups.
 * Skipped: gm:daily:* (ephemeral daily counters) and lb:cache:* (derived,
 * regenerates itself) — there's nothing to lose there.
 *
 * Values are stored verbatim (raw strings) so a restore is byte-for-byte.
 *
 * Auth: X-Debug-Key header must match env.DEBUG_KEY (same gate as the other
 * admin endpoints). Delete DEBUG_KEY when you're done.
 *
 * Operator workflow:
 *   Backup : curl -H "X-Debug-Key: <k>" https://oneliq.xyz/auth/admin/backup -o portal-backup.json
 *   Preview: curl -X POST -H "X-Debug-Key: <k>" --data-binary "@portal-backup.json" https://oneliq.xyz/auth/admin/backup
 *   Restore: curl -X POST -H "X-Debug-Key: <k>" --data-binary "@portal-backup.json" "https://oneliq.xyz/auth/admin/backup?confirm=1"
 */

const PREFIXES = ['gm:', 'profile:', 'refcode:'];

function allowedKey(name) {
  if (name.startsWith('gm:daily:')) return false;
  if (name.startsWith('lb:cache')) return false;
  return PREFIXES.some(p => name.startsWith(p));
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (request.method !== 'GET' && request.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const provided = request.headers.get('X-Debug-Key') || '';
  if (!env.DEBUG_KEY) return json(503, { error: 'disabled', message: 'Set DEBUG_KEY env var on Cloudflare Pages to enable this endpoint (delete after use).' });
  if (provided !== env.DEBUG_KEY) return json(401, { error: 'unauthorized' });

  const kv = env.PROFILE_KV;
  if (!kv) return json(503, { error: 'KV not configured' });

  if (request.method === 'GET') return exportAll(kv);
  return restoreAll(kv, request);
}

async function exportAll(kv) {
  const records = {};
  const counts = {};
  let cursor;
  do {
    const list = await kv.list({ cursor, limit: 1000 });
    for (const k of list.keys) {
      if (!allowedKey(k.name)) continue;
      const val = await kv.get(k.name);
      if (val == null) continue;
      records[k.name] = val;
      const pfx = k.name.split(':')[0] + ':';
      counts[pfx] = (counts[pfx] || 0) + 1;
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);

  const body = JSON.stringify({
    backup_version: 1,
    exported_at: new Date().toISOString(),
    namespace: 'PROFILE_KV',
    counts,
    total: Object.keys(records).length,
    records,
  }, null, 2);

  return new Response(body, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="portal-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      ...cors(),
    },
  });
}

async function restoreAll(kv, request) {
  const apply = new URL(request.url).searchParams.get('confirm') === '1';

  let doc;
  try { doc = await request.json(); }
  catch { return json(400, { error: 'Body must be a JSON backup document.' }); }

  const records = doc && doc.records;
  if (!records || typeof records !== 'object') {
    return json(400, { error: 'Missing "records" object — send a document produced by GET.' });
  }

  let written = 0, skipped = 0;
  const rejected = [];
  for (const [key, val] of Object.entries(records)) {
    if (!allowedKey(key) || typeof val !== 'string') { rejected.push(key); skipped++; continue; }
    if (apply) await kv.put(key, val);
    written++;
  }

  // Derived cache will rebuild on next leaderboard read.
  if (apply) { try { await kv.delete('lb:cache:v2'); } catch {} }

  return json(200, {
    applied: apply,
    would_write: written,
    skipped,
    rejected: rejected.slice(0, 20),
    exported_at: doc.exported_at || null,
    note: apply ? 'Restore applied. Leaderboard cache cleared.' : 'Dry run — add ?confirm=1 to write.',
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
