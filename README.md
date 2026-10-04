# Oneliq

> **The stablecoin command center on Arc.**
> One USDC. One Balance. Everywhere.

Unified balance across 8 chains · cross-chain settlement in ~30s · on-Arc stablecoin swaps - all native USDC, no wrappers.

🌐 Live at **[oneliq.xyz](https://oneliq.xyz)** · 🐦 [@oneliq_](https://x.com/oneliq_) · 💬 [Discord](https://discord.gg/7XUPdWWrGk)

---

## What is this?

**Oneliq** is a unified stablecoin platform that simplifies how people use USDC across chains. Built on Circle's infrastructure and designed for the [Arc Layer 1](https://arc.network), Oneliq brings trading, cross-chain balance management, token discovery, and onboarding into one seamless experience. One balance, zero custody:

Arc is Circle's institutional EVM chain, where USDC is the native gas token - so we treat USDC as **one programmable balance** rather than dozens of siloed per-chain wallets.

### What ships today on Arc Mainnet (chainId 5042)

| Surface | What it does | Powered by |
|---|---|---|
| **Unified Balance** | See USDC across 8 chains as one number. Spend cross-chain with a single EIP-712 signature (**Auto**, **Single**, or **Manual** sourcing), **Batch Pay** many recipients from a saved recipient book or a pasted list, **Consolidate** scattered dust into one chain, and mint gasless on the destination via the Circle forwarder. Transfers still in flight resume after a page reload. | [Circle Gateway](https://www.circle.com/gateway) |
| **Trade** | On-Arc stablecoin swap (USDC ⇄ EURC) routed through `OneliqRouter` (0.3% fee) into Uniswap v4 via the Universal Router, or v3 via SwapRouter02, plus a CCTP V2 bridge merged into one flow. Fast (~20s) or Standard (free) mode, and the output can be parked straight into your Unified Balance without a second trip. Non-Arc swaps go direct to SwapRouter02 with no Oneliq fee. | `OneliqRouter` + [Uniswap](https://docs.uniswap.org/) + [Circle CCTP V2](https://www.circle.com/cross-chain-transfer-protocol) |
| **Explore** | Discover every token trading on Arc - price, 24h change, volume, liquidity and FDV, with a per-token page and chart. Pool data comes from GeckoTerminal and DexScreener; TVL is read on-chain. | Arc RPC + public DEX indexers |
| **Dashboard** | Your portfolio at a glance: profile, total value, holdings per chain, and recent activity. | Arc RPC + Cloudflare KV |
| **History** | Every Trade and Balance action rendered as a receipt, stored per wallet so the log follows you between browsers and devices. | Cloudflare KV |

Network counters (total users, on-chain swap and check-in totals) are recomputed from Arc itself rather than from our own database. The operator console that surfaces them internally is credential-gated and is not part of the public surface.

Both a light and a dark theme ship on every page, and the choice is remembered.

### Coming soon

| When | What |
|---|---|
| **2027 Q1** | **Operations Dashboard** - first public release (Beta) of the shared view over balances, settlement, and activity across every chain. |
| **2027 Q2** | **Treasury Operations** - treasury workflows, payroll templates, portfolio analytics, reporting, and CSV export. |
| **2027 Q3** | **Production & Ecosystem** - independent security audit + bug bounty, deeper developer integrations, and early enterprise pilots. |

> See the full roadmap below.

You always retain custody. Oneliq never holds funds - every transaction is signed
by your own wallet, and no user asset passes through an Oneliq-controlled balance.

> **Closed on 2026-10-04**: Oneliq AI, the Agent automation API, and the Portal
> (check-in / Star Points / leaderboard). Their pages and backends were removed,
> not just hidden. `OneliqCheckIn` stays on chain and immutable, so historical
> check-ins remain verifiable.

---

## Circle integration map

Every Circle product we use is integrated **natively** - no third-party bridges, no wrapped derivatives.

| Circle product | Status | Where in code |
|---|---|---|
| **USDC** | Live | Native unit of account across every surface. Per-chain addresses in [`assets/arc-core-v2.js`](assets/arc-core-v2.js). |
| **Circle Gateway** | Live (mainnet) | EIP-712 `BurnIntent` / `BurnIntentSet` signing + 8-chain `/v1/balances` aggregation, cross-chain spend, Consolidate, and gasless forwarder mint. See [`assets/arc-gateway.js`](assets/arc-gateway.js) and [`functions/api/gateway-proxy/`](functions/api/gateway-proxy/). |
| **CCTP V2** | Live (mainnet) | `TokenMessengerV2.depositForBurn` + `MessageTransmitterV2.receiveMessage`, Fast and Standard modes. Arc is CCTP domain 26. See [`assets/arc-core-v2.js`](assets/arc-core-v2.js) and [`trade.html`](trade.html). |
| **App Kit (Stablecoin Kit)** | Live (mainnet) | Swap quoting (`GET /quote`) and the `swap()` / `bridge()` calls, proxied via [`functions/api/circle-proxy/`](functions/api/circle-proxy/) so `KIT_KEY` never reaches the browser. Loaded from a self-hosted bundle, see [`assets/arc-appkit.js`](assets/arc-appkit.js). |
| **Nanopayments** | Planned (2027+) | Streaming USDC primitives. |

Supported chains for Unified Balance and CCTP V2: **Arc, Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, Unichain** - all mainnet.

---

## Tech stack

**Frontend**
- Pure HTML + CSS + vanilla JavaScript - no framework, no build step
- [ethers.js v6](https://docs.ethers.org/v6/) - SRI-pinned from CDN; three other runtime deps are version-pinned only ([details](SECURITY_CHECKLIST.md#dependency-surface-stated-precisely))
- EIP-6963 multi-wallet detection (MetaMask, Rabby, Coinbase Wallet, OKX, Brave)
- Light/dark theming shared across every page (`assets/arc-theme.css`, `assets/arc-theme.js`)

**Backend (Cloudflare Pages Functions)**
- `functions/api/gateway-proxy/` - server-side proxy to Circle Gateway REST (`gateway-api.circle.com`)
- `functions/api/circle-proxy/` - proxies Circle App Kit (`api.circle.com`) so `KIT_KEY` stays out of the browser
- `functions/api/session/` - mints bearer tokens from an EIP-712 wallet signature (`AGENT_KV`)
- `functions/api/history/` - per-wallet, cross-browser Trade/Balance history (`AGENT_KV`)
- `functions/api/recipients/` - per-wallet recipient book for Batch Pay (`AGENT_KV`)
- `functions/api/metrics/` - network counters, reconciled against Arc RPC
- `functions/auth/` - wallet profile, Discord and OG verification, and the historical check-in records (`AGENT_KV`, plus `PROFILE_KV` if bound)
- `functions/_eip712.js`, `functions/_session.js` - hand-rolled keccak256 + secp256k1 recovery and the session gate (no npm deps at the edge)
- `functions/_middleware.js` - per-response CSP nonce injection, plus the access gate for the private operator console (fails closed if its credentials are unset)
- `workers/kv-backup/` - scheduled Worker that snapshots KV so profiles and history are recoverable

The KV binding is named `AGENT_KV` for historical reasons - see [`SETUP-KV.md`](SETUP-KV.md).

**Infra**
- **Cloudflare Pages** - hosting + CDN + DDoS protection
- **Cloudflare KV** - wallet sessions, per-wallet history and recipients, telemetry counters, profiles
- **Status page** - separate Pages project at [status.oneliq.xyz](https://status.oneliq.xyz) so uptime reporting is isolated from the app

First paint < 1s on 4G. No `node_modules` in production.

---

## Local development

```bash
# Clone
git clone https://github.com/nhutqui23091/oneliq.git
cd oneliq

# Serve locally - any static server works
python3 -m http.server 8080            # Python
npx serve .                            # Node
php -S localhost:8080                  # PHP
```

Open `http://localhost:8080` in a browser with MetaMask/Rabby installed. Arc Mainnet
uses USDC as its native gas token, so you need real USDC on Arc to transact - there
is no faucet. See the [docs](https://oneliq.xyz/docs#get-usdc) for how to get it.

For full backend behavior (Gateway proxy, App Kit proxy, sessions, history):

```bash
# Requires Wrangler - Cloudflare's CLI
npm install -g wrangler
wrangler pages dev .
```

Set these env vars in `.dev.vars` for local backend testing (see `.env.example`):

```
KIT_KEY=...                  # Circle App Kit API key
GATEWAY_KEY=...              # Optional - Gateway bearer if Circle requires it
```

No keys are needed for read-only frontend dev. The `CIRCLE_API_KEY` and
`CIRCLE_ENTITY_SECRET` that earlier versions listed here belonged to the Agent's
Programmable Wallets backend; that feature is closed and the secrets were revoked.

---

## Deployment

Cloudflare Pages is the only deploy path: see [`docs/DEPLOY_CLOUDFLARE.md`](docs/DEPLOY_CLOUDFLARE.md).

An IPFS + ENS mirror was documented for a long time but never set up, so the
runbook and its helper script were removed rather than left looking available.

Before any deploy, run the pre-flight check:

```bash
bash scripts/preflight-check.sh
```

Verifies CSP, SRI, secrets hygiene, redirects, and host headers.

---

## Project structure

```
oneliq/
├── index.html              ← Homepage
├── balance.html            ← Unified Balance (Circle Gateway)         [LIVE]
├── trade.html              ← Swap (OneliqRouter → Uniswap) + CCTP V2  [LIVE]
├── explore.html            ← Token discovery on Arc                   [LIVE]
├── token.html              ← Per-token page + chart                   [LIVE]
├── dashboard.html          ← User portfolio (holdings + activity)     [LIVE]
├── history.html            ← Cross-browser Trade/Balance history      [LIVE]
├── ops.html                ← Private operator console (credential-gated)
├── docs.html, blog.html    ← Static docs + blog
├── blog/                   ← One HTML file per post
│
├── assets/
│   ├── arc-core-v2.js      ← Chain + token registries, RPC, ABIs, EIP-6963, gas overrides
│   ├── arc-gateway.js      ← Circle Gateway client (BurnIntent, spend, Consolidate, forwarder)
│   ├── arc-appkit.js       ← Circle App Kit swap client (config is generated at build time)
│   ├── arc-theme.js/.css   ← Light/dark theme switch, shared tokens
│   ├── arc-ui.js, arc-ui.css ← Shared app shell (sidebar nav + UI primitives)
│   └── logos/, badges/, social/ ← Brand marks and share images
│
├── functions/
│   ├── _middleware.js      ← CSP nonce injection + operator-console access gate
│   ├── _eip712.js          ← keccak256 + secp256k1 recovery (no npm deps)
│   ├── _session.js         ← Wallet session gate + rate limiting
│   ├── _rpc.js             ← Per-chain RPC endpoint lookup
│   ├── api/gateway-proxy/  ← Server-side proxy → Circle Gateway REST
│   ├── api/circle-proxy/   ← Server-side proxy → Circle App Kit (KIT_KEY)
│   ├── api/session/        ← Bearer tokens from an EIP-712 wallet signature
│   ├── api/history/        ← Per-wallet Trade/Balance history (cross-browser sync)
│   ├── api/recipients/     ← Per-wallet recipient book for Batch Pay
│   ├── api/metrics/        ← Network counters, reconciled against Arc RPC
│   └── auth/               ← Wallet profile, Discord + OG verification, check-in records
│
├── workers/
│   └── kv-backup/          ← Scheduled KV snapshot worker
│
├── status/                ← Status page (deployed as its own Pages project)
├── contracts/             ← OneliqRouter + OneliqCheckIn sources
├── _headers, _redirects   ← Cloudflare Pages security + clean URLs
├── docs/                  ← Deployment + governance + incident-response runbooks
├── scripts/               ← Pre-flight + health-check helpers
├── .well-known/security.txt
├── SECURITY.md, SECURITY_CHECKLIST.md
├── SETUP-KV.md            ← One-time setup for the KV binding the edge backend needs
└── .env.example
```

---

## Security

- Content-Security-Policy on every page, plus a per-response nonce injected at the edge so an injected inline script cannot run
- Subresource Integrity on every static CDN script tag; the two esm.sh ESM imports and the runtime-injected qrcode script are version-pinned only (see [`SECURITY_CHECKLIST.md`](SECURITY_CHECKLIST.md#dependency-surface-stated-precisely))
- Strict referrer + permissions policies via `_headers`
- API keys never reach the browser (server-side proxies for App Kit + Circle Gateway)
- Origin allowlist on every Pages Function
- Wallet-scoped endpoints (`/api/history`, `/api/recipients`) require a bearer token minted from an EIP-712 signature; unauthenticated reads return 401
- The operator console and every maintenance endpoint are credential-gated and fail closed when their secrets are unset
- Our two contracts are unaudited, and the router admin key is a single EOA with a bounded blast radius - stated in full in [`SECURITY_CHECKLIST.md`](SECURITY_CHECKLIST.md#known-weakness-the-router-admin-key) and [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md)

**Found a vulnerability?** See [`SECURITY.md`](SECURITY.md). There is no funded
bounty program today, so no reward tiers are published; valid reports get a fix,
credit, and a discretionary thank-you.
Contact: `security@oneliq.xyz` (no PGP key published - assume plaintext).

---

## Roadmap

| Quarter | Milestone |
|---|---|
| **2026 Q3** _(Now)_ | **Platform Optimization** - continue improving Trade execution and liquidity routing, enhance Unified Balance and cross-chain settlement, and refine overall platform performance and user experience. |
| **2027 Q1** | **Operations Dashboard** - launch the first public version (Beta) of the Operations Dashboard: balances, settlement, and activity across every chain in one view. |
| **2027 Q2** | **Treasury Operations** - take the Operations Dashboard to GA with treasury workflows, payroll templates, portfolio analytics, reporting, and CSV export. |
| **2027 Q3** | **Production & Ecosystem** - strengthen platform security with an independent security audit and bug bounty, expand developer integrations, improve platform reliability, and run early enterprise pilots for stablecoin automation. |

See the live roadmap on the [homepage](https://oneliq.xyz/#roadmap).

---

## Disclaimer

Oneliq runs on **Arc Mainnet**. Assets are real USDC and EURC with real monetary
value, and transactions are irreversible. Earlier versions of this README called
Oneliq testnet-only software whose assets had no monetary value; that stopped
being true at the mainnet cutover and the disclaimer is corrected here.

Execution timings and quoted outputs are estimates, not guarantees - actual
results depend on Circle infrastructure, network conditions, and on-chain
liquidity.

We compose third-party contracts audited by their respective teams (Circle
Gateway, Circle CCTP V2, Uniswap v4 / v3 / Permit2 on Arc). We do not own or
operate those.

We **do** own and operate two contracts: `OneliqRouter` and `OneliqCheckIn`.
Neither has been audited by an outside firm, and the router's admin key is a
single EOA. What that key can and cannot do is written out in
[`SECURITY_CHECKLIST.md`](SECURITY_CHECKLIST.md#known-weakness-the-router-admin-key).

---

## License

License decision pending. Until then, all rights reserved by the Oneliq team. When we decide (likely **MIT** for the frontend, **Apache-2.0** for backend functions), this section will update.

---

_Built on [Arc](https://arc.network) - the developer platform for onchain finance. Powered by [Circle](https://www.circle.com/) primitives end-to-end._
