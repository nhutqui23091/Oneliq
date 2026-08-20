/**
 * Wallet session tokens — shared by the per-wallet data endpoints.
 *
 * /api/history and /api/recipients are keyed by wallet address, and until now
 * that address was the only thing a caller had to supply. Anyone could write
 * receipts into someone else's feed, wipe it by pushing past the row cap, or
 * plant a labelled entry ("Treasury") in someone's Batch Pay address book and
 * wait for them to pick it. An origin allowlist does not help: it constrains
 * other people's browsers, never curl.
 *
 * So writes now carry proof that the caller controls the address. Asking the
 * wallet to sign every receipt would be intolerable, so the user signs once
 * and gets a bearer token that stands in for the signature for a day.
 *
 *   POST /api/session/verify   { address, nonce, issuedAt, signature }
 *                              → { token, address, expiresAt }
 *   subsequent calls           Authorization: Bearer <token>
 *
 * The signed message is EIP-712 under its own domain, so a signature collected
 * here cannot be replayed against the agent API (or vice versa), and a wallet
 * shows the user a readable statement rather than an opaque hash.
 */

import { recoverTypedDataAddress } from './api/agent/_verify.js';

export const SESSION_DOMAIN = {
  name: 'Oneliq',
  version: '1',
  chainId: 5042002,          // Arc Testnet — namespace only, not a chain commitment
};

export const SESSION_TYPE = [
  { name: 'address',   type: 'address' },
  { name: 'statement', type: 'string'  },
  { name: 'nonce',     type: 'string'  },
  { name: 'issuedAt',  type: 'uint256' },
];

// Shown to the user in the wallet prompt. Part of the signed struct, so it
// cannot be swapped out for something more alarming after the fact.
export const SESSION_STATEMENT =
  'Sign in to Oneliq. This proves you control this wallet so your history and ' +
  'saved recipients stay yours. It costs no gas and moves no funds.';

const SESSION_TTL_S = 24 * 60 * 60;   // a token is good for a day
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const NONCE_TTL_S = 900;

function isAddr(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
}

function isNonce(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{32}$/.test(v);
}

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/**
 * Verify a session signature and mint a bearer token.
 * Returns { ok: true, token, address, expiresAt } or { ok: false, error }.
 */
export async function mintSession(kv, body) {
  const { address, nonce, issuedAt, signature } = body || {};
  if (!isAddr(address)) return { ok: false, error: 'bad_address' };
  if (!isNonce(nonce))  return { ok: false, error: 'bad_nonce' };

  const ts = Number(issuedAt);
  if (!Number.isFinite(ts)) return { ok: false, error: 'bad_issuedAt' };
  if (Math.abs(Date.now() - ts) > SIGNATURE_MAX_AGE_MS)
    return { ok: false, error: 'signature_expired' };

  const recovered = recoverTypedDataAddress(SESSION_DOMAIN, SESSION_TYPE, 'Session', {
    address,
    statement: SESSION_STATEMENT,
    nonce,
    issuedAt: ts,
  }, signature);

  if (recovered === null || recovered !== address.toLowerCase())
    return { ok: false, error: 'signature_invalid' };

  const nonceKey = `sessnonce:${nonce}`;
  if (await kv.get(nonceKey)) return { ok: false, error: 'signature_replayed' };
  await kv.put(nonceKey, '1', { expirationTtl: NONCE_TTL_S });

  const token = randomToken();
  const expiresAt = Date.now() + SESSION_TTL_S * 1000;
  await kv.put(`sess:${token}`, JSON.stringify({ address: address.toLowerCase(), expiresAt }),
               { expirationTtl: SESSION_TTL_S });

  return { ok: true, token, address: address.toLowerCase(), expiresAt };
}

/**
 * The address a request's bearer token authorizes, or null.
 * Never throws — callers treat null as "not authorized".
 */
export async function sessionAddress(kv, request) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  let rec;
  try { rec = JSON.parse((await kv.get(`sess:${token}`)) || 'null'); } catch { return null; }
  if (!rec || !isAddr(rec.address)) return null;
  if (rec.expiresAt && Date.now() > rec.expiresAt) return null;
  return rec.address.toLowerCase();
}

/**
 * True when the request is authorized to act as `address`.
 * KV TTL handles expiry, so an old token simply stops resolving.
 */
export async function authorizedFor(kv, request, address) {
  if (!isAddr(address)) return false;
  const caller = await sessionAddress(kv, request);
  return caller !== null && caller === address.toLowerCase();
}

/**
 * Compare two secrets without the time taken revealing how far the match got.
 * Used for the admin key checks, where `!==` would stop at the first wrong
 * character.
 */
export function timingSafeEqual(a, b) {
  const x = String(a == null ? '' : a), y = String(b == null ? '' : b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/* ────────────────────────────────────────────────────────────
   Rate limiting
   ──────────────────────────────────────────────────────────── */

/**
 * Fixed-window per-IP counter. Backed by KV, so it is approximate under
 * concurrency — it exists to stop an open endpoint being pointed at a
 * generator, not to enforce an exact quota.
 *
 * Returns true when the caller is within budget.
 */
export async function underRateLimit(kv, request, bucket, limit, windowS = 60) {
  if (!kv) return true;                     // storage unconfigured — do not hard-fail the app
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const window = Math.floor(Date.now() / (windowS * 1000));
  const key = `rl:${bucket}:${ip}:${window}`;
  let n = 0;
  try { n = parseInt((await kv.get(key)) || '0', 10) || 0; } catch { return true; }
  if (n >= limit) return false;
  try { await kv.put(key, String(n + 1), { expirationTtl: windowS + 60 }); } catch { /* best effort */ }
  return true;
}
