/**
 * EIP-712 signature verification for the Agent API.
 *
 * Cloudflare Pages Functions run without npm dependencies here (no package.json
 * in the repo root), and Web Crypto exposes neither keccak256 nor secp256k1
 * public-key recovery. So both primitives are implemented below in plain
 * BigInt/Uint8Array code. Everything is constant-shape rather than
 * constant-time; that is acceptable because we only ever handle public data
 * (message hashes and signatures), never a private key.
 *
 * Exports:
 *   keccak256(bytes)                     → Uint8Array(32)
 *   recoverTypedDataAddress(domain, types, primaryType, value, sig) → 0x… | null
 *   canonicalJson(value)                 → deterministic JSON string
 *   AGENT_DOMAIN, AGENT_RULE_TYPE, AGENT_ACTION_TYPE
 */

/* ────────────────────────────────────────────────────────────
   keccak-256  (original Keccak padding, not SHA3)
   ──────────────────────────────────────────────────────────── */

const MASK64 = (1n << 64n) - 1n;

const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rho rotation offsets, flat-indexed as x + 5*y.
const KECCAK_RHO = [
   0,  1, 62, 28, 27,
  36, 44,  6, 55, 20,
   3, 10, 43, 25, 39,
  41, 45, 15, 21,  8,
  18,  2, 61, 56, 14,
];

function rotl64(x, n) {
  const b = BigInt(n);
  if (b === 0n) return x;
  return ((x << b) | (x >> (64n - b))) & MASK64;
}

function keccakF1600(A) {
  const C = new Array(5);
  const D = new Array(5);
  const B = new Array(25);

  for (let round = 0; round < 24; round++) {
    // θ
    for (let x = 0; x < 5; x++) {
      C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1);
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) A[x + 5 * y] ^= D[x];
    }

    // ρ and π
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = x + 5 * y;
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(A[i], KECCAK_RHO[i]);
      }
    }

    // χ
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        A[x + 5 * y] = B[x + 5 * y] ^ ((~B[((x + 1) % 5) + 5 * y] & MASK64) & B[((x + 2) % 5) + 5 * y]);
      }
    }

    // ι
    A[0] ^= KECCAK_RC[round];
  }
  return A;
}

/** keccak256 over a Uint8Array. Rate = 136 bytes, pad byte 0x01. */
export function keccak256(input) {
  const RATE = 136;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  // Pad: 0x01 … 0x80 (last byte of the final block gets the high bit set).
  const padLen = RATE - (bytes.length % RATE);
  const padded = new Uint8Array(bytes.length + padLen);
  padded.set(bytes, 0);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const A = new Array(25).fill(0n);

  for (let off = 0; off < padded.length; off += RATE) {
    // Absorb one block: 17 little-endian 64-bit lanes.
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) {
        lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      }
      A[i] ^= lane;
    }
    keccakF1600(A);
  }

  // Squeeze 32 bytes.
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────
   secp256k1 public-key recovery
   ──────────────────────────────────────────────────────────── */

const P  = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N  = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

function mod(a, m) {
  const r = a % m;
  return r < 0n ? r + m : r;
}

/** Extended Euclid — much cheaper than Fermat's little theorem here. */
function modInv(a, m) {
  let lo = mod(a, m), hi = m;
  let x = 1n, y = 0n;
  while (lo > 0n) {
    const q = hi / lo;
    [lo, hi] = [hi - q * lo, lo];
    [x, y] = [y - q * x, x];
  }
  return mod(y, m);
}

function modPow(base, exp, m) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

/* Jacobian coordinates: affine = (x/z², y/z³). z === 0n is the point at infinity. */
const INFINITY = { x: 0n, y: 0n, z: 0n };

function jacobianDouble(pt) {
  const { x, y, z } = pt;
  if (y === 0n || z === 0n) return INFINITY;
  const ysq = (y * y) % P;
  const S = (4n * x * ysq) % P;
  const M = (3n * x * x) % P;            // a = 0 for secp256k1
  const nx = mod(M * M - 2n * S, P);
  const ny = mod(M * (S - nx) - 8n * ysq * ysq, P);
  const nz = mod(2n * y * z, P);
  return { x: nx, y: ny, z: nz };
}

function jacobianAdd(p1, p2) {
  if (p1.z === 0n) return p2;
  if (p2.z === 0n) return p1;
  const z1sq = (p1.z * p1.z) % P;
  const z2sq = (p2.z * p2.z) % P;
  const U1 = (p1.x * z2sq) % P;
  const U2 = (p2.x * z1sq) % P;
  const S1 = (p1.y * z2sq % P) * p2.z % P;
  const S2 = (p2.y * z1sq % P) * p1.z % P;
  if (U1 === U2) {
    if (S1 !== S2) return INFINITY;      // P + (-P)
    return jacobianDouble(p1);
  }
  const H = mod(U2 - U1, P);
  const R = mod(S2 - S1, P);
  const Hsq = (H * H) % P;
  const Hcu = (Hsq * H) % P;
  const nx = mod(R * R - Hcu - 2n * U1 * Hsq, P);
  const ny = mod(R * (U1 * Hsq % P - nx) - S1 * Hcu, P);
  const nz = mod(H * p1.z % P * p2.z, P);
  return { x: nx, y: ny, z: nz };
}

function jacobianMul(pt, k) {
  let scalar = mod(k, N);
  if (scalar === 0n || pt.z === 0n) return INFINITY;
  let acc = INFINITY;
  let base = pt;
  while (scalar > 0n) {
    if (scalar & 1n) acc = jacobianAdd(acc, base);
    base = jacobianDouble(base);
    scalar >>= 1n;
  }
  return acc;
}

function toAffine(pt) {
  if (pt.z === 0n) return null;
  const zInv = modInv(pt.z, P);
  const zInv2 = (zInv * zInv) % P;
  return {
    x: (pt.x * zInv2) % P,
    y: (pt.y * zInv2 % P) * zInv % P,
  };
}

function bigIntTo32(v) {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function bytesToBigInt(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

export function bytesToHex(bytes) {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex) {
  const clean = String(hex || '').replace(/^0x/i, '');
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Recover the signing address from a 32-byte digest and a 65-byte signature.
 * Returns a lowercase 0x address, or null if the signature is malformed or
 * does not correspond to a point on the curve.
 */
export function recoverAddress(digest, sigHex) {
  const sig = hexToBytes(sigHex);
  if (!sig || sig.length !== 65) return null;

  const r = bytesToBigInt(sig.subarray(0, 32));
  const s = bytesToBigInt(sig.subarray(32, 64));
  let v = sig[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  if (r <= 0n || r >= N || s <= 0n || s >= N) return null;

  // Reject the malleable upper half so a signature has exactly one encoding.
  if (s > N / 2n) return null;

  // Decompress R from its x-coordinate.
  const ySq = mod(modPow(r, 3n, P) + 7n, P);
  let y = modPow(ySq, (P + 1n) / 4n, P);
  if ((y * y) % P !== ySq) return null;          // r is not a valid x on the curve
  if ((y & 1n) !== BigInt(v)) y = P - y;

  const R = { x: r, y, z: 1n };
  const G = { x: Gx, y: Gy, z: 1n };
  const z = bytesToBigInt(digest) % N;

  // Q = r⁻¹ · (s·R − z·G)
  const sR = jacobianMul(R, s);
  const zG = jacobianMul(G, z);
  const negZG = zG.z === 0n ? INFINITY : { x: zG.x, y: mod(-zG.y, P), z: zG.z };
  const Q = jacobianMul(jacobianAdd(sR, negZG), modInv(r, N));

  const aff = toAffine(Q);
  if (!aff) return null;

  const pub = new Uint8Array(64);
  pub.set(bigIntTo32(aff.x), 0);
  pub.set(bigIntTo32(aff.y), 32);
  const hash = keccak256(pub);
  return bytesToHex(hash.subarray(12));
}

/* ────────────────────────────────────────────────────────────
   EIP-712 encoding
   ──────────────────────────────────────────────────────────── */

const utf8 = new TextEncoder();

function concatBytes(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function encodeField(type, value) {
  if (type === 'string') return keccak256(utf8.encode(String(value ?? '')));
  if (type === 'address') {
    const b = hexToBytes(value);
    if (!b || b.length !== 20) throw new Error('bad address');
    const out = new Uint8Array(32);
    out.set(b, 12);
    return out;
  }
  if (/^uint\d*$/.test(type)) return bigIntTo32(BigInt(value));
  if (type === 'bytes32') {
    const b = hexToBytes(value);
    if (!b || b.length !== 32) throw new Error('bad bytes32');
    return b;
  }
  throw new Error(`unsupported EIP-712 field type: ${type}`);
}

/** "AgentRule(address owner,string mode,…)" for a single, non-nested struct. */
function typeString(primaryType, fields) {
  return `${primaryType}(${fields.map(f => `${f.type} ${f.name}`).join(',')})`;
}

export function hashStruct(primaryType, fields, value) {
  const chunks = [keccak256(utf8.encode(typeString(primaryType, fields)))];
  for (const f of fields) chunks.push(encodeField(f.type, value[f.name]));
  return keccak256(concatBytes(chunks));
}

/** Domain separator for a { name, version, chainId } domain (no verifyingContract). */
function domainSeparator(domain) {
  return hashStruct('EIP712Domain', [
    { name: 'name',    type: 'string'  },
    { name: 'version', type: 'string'  },
    { name: 'chainId', type: 'uint256' },
  ], domain);
}

/**
 * Recover the address that produced an EIP-712 signature.
 * Returns a lowercase 0x address, or null.
 */
export function recoverTypedDataAddress(domain, fields, primaryType, value, sigHex) {
  let digest;
  try {
    digest = keccak256(concatBytes([
      new Uint8Array([0x19, 0x01]),
      domainSeparator(domain),
      hashStruct(primaryType, fields, value),
    ]));
  } catch {
    return null;   // malformed field (bad address, non-numeric uint, …)
  }
  return recoverAddress(digest, sigHex);
}

/* ────────────────────────────────────────────────────────────
   Agent-specific schema (must stay byte-identical to agent.html)
   ──────────────────────────────────────────────────────────── */

export const AGENT_DOMAIN = {
  name: 'Oneliq Agent',
  version: '1',
  chainId: 5042002,          // Arc Testnet — namespace only, not a chain commitment
};

export const AGENT_RULE_TYPE = [
  { name: 'owner',        type: 'address' },
  { name: 'mode',         type: 'string'  },
  { name: 'sources',      type: 'string'  }, // comma-joined chain keys
  { name: 'targets',      type: 'string'  }, // comma-joined recipient addresses
  { name: 'targetChains', type: 'string'  }, // comma-joined, parallel to targets
  { name: 'params',       type: 'string'  }, // canonicalJson of the rule params
  { name: 'nonce',        type: 'string'  },
  { name: 'expiresAt',    type: 'uint256' },
];

export const AGENT_ACTION_TYPE = [
  { name: 'owner',    type: 'address' },
  { name: 'agentId',  type: 'string'  },
  { name: 'action',   type: 'string'  },
  { name: 'nonce',    type: 'string'  },
  { name: 'issuedAt', type: 'uint256' },
];

/**
 * Deterministic JSON: object keys sorted, arrays left in order. Both the
 * browser and this Function stringify the rule params through this so the
 * signed bytes cannot drift with property insertion order.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
