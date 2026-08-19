/**
 * Oneliq recipient book — Cloudflare Pages Function.
 *
 * Batch Pay used to mean retyping every address each time, and a browser that
 * had never been used before started from nothing. These endpoints keep a small
 * address book per wallet in KV, the same shape and the same guard rails as
 * /api/history (origin allowlist, address-keyed, capped).
 *
 * Endpoints (all under /api/recipients/*):
 *   POST /save    Upsert one recipient (merge by address+chain).
 *   POST /remove  Drop one recipient by address+chain.
 *   GET  /list?address=0x..   Return that wallet's book, most-recent first.
 *
 * Storage (AGENT_KV):
 *   recipients:<owner-lowercase> → JSON array, newest-first, capped BOOK_MAX
 *                                  row = { addr, chain, label, at }
 *
 * AUTH: every endpoint requires `Authorization: Bearer <token>` from
 * /api/session/verify, belonging to the owner address in question.
 *
 * This one mattered most. The owner address used to be the only credential, so
 * anyone could write into anyone's book — and an attacker who plants
 * { addr: <their own>, label: "Treasury" } is not corrupting data, they are
 * placing a chip in someone's Batch Pay UI and waiting for a mis-click. On
 * mainnet that is a direct path to lost funds. Reads are gated too: a
 * counterparty list with human labels is not something a stranger should be
 * able to pull by knowing a public address.
 */

import { authorizedFor, underRateLimit } from '../../_session.js';

const ALLOWED_ORIGINS = [
  'https://oneliq.xyz',
  'https://www.oneliq.xyz',
  'https://arcswap.pages.dev',
  'https://status.oneliq.xyz',
];

const BOOK_MAX  = 60;   // recipients kept per wallet
const LABEL_MAX = 40;
const CHAIN_MAX = 32;

function isAllowed(origin) {
  return !origin
    || ALLOWED_ORIGINS.includes(origin)
    || origin.endsWith('.arcswap.pages.dev')
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function cors(origin, extra = {}) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function json(body, origin, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

function bad(msg, origin, status = 400) {
  return json({ error: msg }, origin, status);
}

function normAddr(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null;
}

function str(v, max) {
  if (typeof v !== 'string') return '';
  // Labels are rendered as text in the Batch Pay modal; strip the characters
  // that could break out of that context before they ever reach storage.
  const clean = v.replace(/[<>&"'`]/g, '').trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

async function readBook(env, owner) {
  let rows = [];
  try { rows = JSON.parse((await env.AGENT_KV.get(`recipients:${owner}`)) || '[]'); } catch { rows = []; }
  return Array.isArray(rows) ? rows : [];
}

// A recipient is identified by address + destination chain: the same person
// paid on Base and on Arc is two entries, because the chain is part of what
// Batch Pay needs to refill a row.
function sameEntry(a, b) {
  return a && b && a.addr === b.addr && a.chain === b.chain;
}

async function handleSave(request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return bad('invalid JSON', origin); }
  const owner = normAddr(body?.owner);
  const addr  = normAddr(body?.addr);
  if (!owner) return bad('bad owner', origin);
  if (!addr)  return bad('bad recipient address', origin);
  if (!(await authorizedFor(env.AGENT_KV, request, owner)))
    return bad('unauthorized', origin, 401);

  const row = {
    addr,
    chain: str(body.chain, CHAIN_MAX),
    label: str(body.label, LABEL_MAX),
    at: Date.now(),
  };
  if (!row.chain) return bad('chain required', origin);

  let rows = await readBook(env, owner);
  const idx = rows.findIndex(r => sameEntry(r, row));
  if (idx >= 0) {
    // Keep an existing label when the caller did not supply a new one, so an
    // auto-save after a payment never wipes a name the user typed.
    row.label = row.label || rows[idx].label || '';
    rows.splice(idx, 1);
  }
  rows.unshift(row);
  if (rows.length > BOOK_MAX) rows = rows.slice(0, BOOK_MAX);

  await env.AGENT_KV.put(`recipients:${owner}`, JSON.stringify(rows));
  return json({ ok: true, count: rows.length }, origin);
}

async function handleRemove(request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return bad('invalid JSON', origin); }
  const owner = normAddr(body?.owner);
  const addr  = normAddr(body?.addr);
  if (!owner || !addr) return bad('bad address', origin);
  if (!(await authorizedFor(env.AGENT_KV, request, owner)))
    return bad('unauthorized', origin, 401);
  const chain = str(body.chain, CHAIN_MAX);

  const rows = (await readBook(env, owner))
    .filter(r => !sameEntry(r, { addr, chain }));
  await env.AGENT_KV.put(`recipients:${owner}`, JSON.stringify(rows));
  return json({ ok: true, count: rows.length }, origin);
}

async function handleList(request, url, env, origin) {
  const owner = normAddr(url.searchParams.get('address'));
  if (!owner) return bad('bad address', origin);
  if (!(await authorizedFor(env.AGENT_KV, request, owner)))
    return bad('unauthorized', origin, 401);
  return json({ rows: await readBook(env, owner) }, origin);
}

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (!isAllowed(origin)) return bad('forbidden origin', origin, 403);
  if (!env.AGENT_KV) return bad('recipient storage unconfigured', origin, 503);
  if (!(await underRateLimit(env.AGENT_KV, request, 'recipients', 120, 60)))
    return bad('rate limited', origin, 429);

  const sub = url.pathname.replace(/^\/api\/recipients\/?/, '').replace(/\/+$/, '');

  if (request.method === 'POST' && sub === 'save')   return handleSave(request, env, origin);
  if (request.method === 'POST' && sub === 'remove') return handleRemove(request, env, origin);
  if (request.method === 'GET'  && sub === 'list')   return handleList(request, url, env, origin);
  return bad('not found', origin, 404);
}
