# Oneliq - Security Posture

A public summary of the security controls that ship with every build of Oneliq,
and the principles we apply across the lifecycle of the project.

For vulnerability reporting, see [`SECURITY.md`](SECURITY.md).
For key custody, see [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md).

---

## Threat model

Oneliq is a **non-custodial** app for stablecoin primitives on **Arc Mainnet**
(chainId 5042). Users always sign their own transactions. We never hold user
funds, and no user asset ever passes through an Oneliq-controlled balance.

We do own two contracts, so unlike a pure frontend we carry contract risk:

| Contract | Address | Admin surface |
|---|---|---|
| OneliqRouter | `0x3635f71daa996e22867647cc58358c5803133a69` | `setFeeBps` (hard-capped at 1.00%), `withdrawFees`, `pause` / `unpause`, `rescue` (stray tokens only), two-step `transferOwnership` |
| OneliqCheckIn | `0x0cccbe2f3acec01d71b38249a1d103117c8473ac` | none - no `owner()`, no admin functions |

Neither contract has been audited by an outside firm.

The threats we design against:

| Threat | Why it matters | Where we defend |
|---|---|---|
| **Frontend supply-chain compromise** | Attacker swaps served JS → injects malicious approve / transfer | Per-response CSP nonce at the edge, SRI on static CDN scripts, host integrity |
| **Inline script injection** | Any injected `<script>` runs with page privileges | CSP allows inline script only by per-response nonce; an injected tag has no nonce and does not execute |
| **DNS / domain hijack** | Attacker points `oneliq.xyz` to a phishing build | Cloudflare account 2FA + hardware key, registrar lock |
| **Reflected / persistent XSS** | Script execution leads to wallet drain | CSP, no `innerHTML` for user input |
| **API key extraction** | Attacker exfiltrates Circle keys from client JS | Server-side proxy via Cloudflare Pages Functions; keys live in Pages secrets |
| **Transaction tampering at sign-time** | UI lies about tx parameters | Show full target + calldata in confirmations; encourage hardware-wallet review |
| **Router admin key compromise** | Fee theft, fee set to a hostile value | Honest status: see below |
| **Vendor contract exploit** | CCTP / Gateway / Uniswap bug surfaces in our UI | Advisory banners; users keep direct on-chain access |

### Known weakness: the router admin key

The OneliqRouter owner is a **single EOA**, not a multi-sig. That is the weakest
link we have, so here is the exact blast radius if that key were compromised.

An attacker holding the key **could**:
- raise the fee, but only up to `MAX_FEE_BPS`, which is a `constant` set to
  **100 bps (1.00%)** and enforced on every `setFeeBps` call. The cap is
  immutable - it cannot be raised by the owner, only respected
- withdraw fees the router has already accrued
- pause the router, denying service until it is unpaused
- sweep tokens sitting in the router *above* the accrued-fee accounting
  (`rescue` reverts if the amount would eat into `accruedFees`)
- nominate a new owner, though `transferOwnership` is two-step and the nominee
  must call `acceptOwnership` for it to take effect

An attacker holding the key **could not** take user funds. The router moves only
the amount pulled for the swap being signed, within that one transaction, and
holds no user balance at rest.

So the realistic worst case is lost fee revenue and a denial of service, not a
drain. Moving the key to a multi-sig is still an open item, tracked in
[`docs/GOVERNANCE.md`](docs/GOVERNANCE.md). We document it rather than claim a
multi-sig we do not have.

Out of scope: chain-level attacks on Arc L1, attacks on third-party contracts
(those have their own disclosure channels - see [`SECURITY.md`](SECURITY.md)).

---

## Controls in every build

Most of these are enforced by [`scripts/preflight-check.sh`](scripts/preflight-check.sh) before a deploy.

| Control | Mechanism |
|---|---|
| **Content Security Policy** | `<meta http-equiv="Content-Security-Policy">` on every HTML file, plus a `Content-Security-Policy` header in [`_headers`](_headers) |
| **Per-response CSP nonce** | [`functions/_middleware.js`](functions/_middleware.js) rewrites each HTML response with a fresh nonce and stamps it on inline scripts. The nonce changes per response, so it cannot be predicted or replayed |
| **Subresource Integrity** | Every static `<script src="https://…">` carries a SHA-384 `integrity=` plus `crossorigin` and `referrerpolicy`. Today that is ethers 6.13.4 on 7 pages; preflight fails the build if a jsdelivr script tag loses its hash |
| **`rel="noopener noreferrer"`** | On every `target="_blank"` link in HTML and dynamic anchors in JS |
| **Strict referrer policy** | `Referrer-Policy: strict-origin-when-cross-origin` |
| **Host security headers** | HSTS (1y, includeSubDomains, preload), X-Frame-Options DENY, X-Content-Type-Options nosniff, COOP/CORP, Permissions-Policy (camera/mic/geolocation off) |
| **No secrets in tracked files** | `.env` is gitignored; preflight greps for common API-key patterns and fails on match |
| **Server-side API key handling** | Circle keys and any other privileged key sit in Cloudflare environment secrets and are injected by Pages Functions proxies; the browser never sees them |
| **Wallet-scoped endpoint auth** | `/api/history` and `/api/recipients` require a bearer token minted by `/api/session` against an EIP-712 signature from the wallet being read. Unauthenticated reads return 401 |
| **Origin allowlist** | Every Pages Function checks the request origin |
| **HTTPS only** | `Strict-Transport-Security` + Always Use HTTPS at the edge; no plaintext fallback |
| **Vulnerability disclosure** | [`SECURITY.md`](SECURITY.md) + [RFC 9116](https://datatracker.ietf.org/doc/html/rfc9116) `.well-known/security.txt` |

### Dependency surface, stated precisely

The app has no build step and four third-party runtime dependencies:

| Dependency | How it loads | Pinning |
|---|---|---|
| ethers 6.13.4 | static `<script>` from cdn.jsdelivr.net | version **and** SHA-384 hash |
| `@circle-fin/app-kit` | dynamic `import()` from esm.sh | version only - an ESM import cannot carry SRI |
| `@circle-fin/adapter-ethers-v6` | dynamic `import()` from esm.sh | version only - same limitation |
| qrcode 1.5.4 | script element injected at runtime from cdn.jsdelivr.net | version only - no `integrity` set |

The two esm.sh imports cannot be hash-pinned by any current browser mechanism.
The qrcode injection could carry an `integrity` property and does not; preflight
does not catch it because it only inspects static script tags. Both are stated
here rather than rounded up to "everything is SRI-pinned".

One more supply-chain note: `assets/appkit.bundle.js` is a **vendored** copy of
Circle's App Kit, served from our own origin rather than a CDN, and it carries a
local patch (registering the Arc chain on connect). Self-hosting means no
third-party origin can swap it under us, but it also means it does not receive
upstream security updates automatically - re-vendoring is a manual step, and
rebuilding it from source drops the patch.

---

## Verifying a build yourself

Anyone can verify these controls on a live deploy:

```bash
# Security headers, including the per-response CSP nonce
curl -sI https://oneliq.xyz | grep -iE 'content-security|strict-transport|x-frame|referrer-policy|permissions-policy'

# The nonce differs on every request
curl -s https://oneliq.xyz | grep -oE 'nonce="[^"]*"' | head -1
curl -s https://oneliq.xyz | grep -oE 'nonce="[^"]*"' | head -1

# SRI on every static CDN script
curl -s https://oneliq.xyz/trade | grep -A2 'cdn.jsdelivr.net' | grep integrity

# Wallet-scoped endpoints reject unauthenticated reads
curl -s "https://oneliq.xyz/api/history/list?address=0x000000000000000000000000000000000000dEaD"
```

For local development, run the preflight script before pushing:

```bash
bash scripts/preflight-check.sh
```

---

## Defense in depth

### Hosting

The only deploy is **Cloudflare Pages** with the orange-cloud proxy enabled -
this gives us the global CDN, DDoS protection, free TLS, and atomic rollback.
All site headers and redirects are owned by [`_headers`](_headers) and [`_redirects`](_redirects)
in the repo, so the deployed configuration is reviewed and committed.

There is **no** IPFS mirror and no ENS-resolved backup frontend today. Earlier
versions of this document described one as available; it was never set up, so
the claim is gone rather than aspirational.

### Containment options

If something goes wrong, these are the levers that actually exist:

- **Configuration-level**: edge headers and redirects revert in seconds without a
  code push.
- **Build-level**: every Pages deploy is atomically rollback-able to any prior
  green build.
- **Contract-level**: OneliqRouter exposes a pause; OneliqCheckIn does not and
  cannot be stopped by us, by design.
- **What we do not have**: a runtime feature-flag manifest. Disabling one product
  surface means a deploy or a redirect, not a config toggle. Earlier versions of
  this document claimed a frontend kill-switch; no such mechanism is in the code.

In every case users keep custody and direct on-chain access, so a frontend that
is paused or withdrawn entirely does not trap anyone's funds.

### Privileged actions

Domain configuration and Pages deployment are held by a Cloudflare account with
2FA and a hardware key. The router admin key is a single EOA - see the known
weakness above and [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md).

---

## Vendor surfaces & their disclosure channels

Oneliq composes third-party contracts. Vulnerabilities in those contracts are
out of scope for us - please report them upstream:

| Surface | Owner | Report to |
|---|---|---|
| USDC, EURC, CCTP, Gateway | Circle | <https://www.circle.com/legal/responsible-disclosure> |
| Uniswap v4 (Universal Router, PoolManager), v3 (SwapRouter02), Permit2 | Uniswap Labs | <security@uniswap.org> |
| Arc L1 chain, public RPC, block explorer | Arc | <security@arc.network> |

For anything in **our** scope (the frontend, the edge backend, our two
contracts), see [`SECURITY.md`](SECURITY.md).

---

## Open items

Oneliq is live on mainnet. These are not done:

- Outside security audit of OneliqRouter and OneliqCheckIn
- Router admin key moved from an EOA to a multi-sig
- Funded bug-bounty program with published scope
- Published PGP key for `security@oneliq.xyz`
- Status page with an on-call rotation
- Incident-response drill log

An earlier version of this file listed these as prerequisites for a mainnet
release. Mainnet shipped first. Listing them honestly as open is the correction.

---

## Open principles

- **Minimum dependency surface** - vanilla HTML + CSS + JS, no build step, four runtime dependencies (table above)
- **No backend that can pause user access** - all balances are on-chain; the edge Functions are proxies and per-wallet stores, and losing them does not block a user from transacting
- **Transparent incidents** - any incident is followed by a public post-mortem within 7 days
- **The repo is the source of truth** - what is committed is what is served, with one deliberate exception: the edge injects a per-response CSP nonce into HTML, so a served page differs from the committed file by that nonce

---

_Last updated: 2026-10-04_
