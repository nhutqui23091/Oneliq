# Oneliq

> **The stablecoin command center on Arc.**
> One USDC. One Balance. Everywhere.

Unified balance across 8 chains · cross-chain settlement in ~30s · bounded autonomous agents you steer in plain English - all native USDC, no wrappers.

🌐 Live at **[oneliq.xyz](https://oneliq.xyz)** · 🐦 [@oneliq_](https://x.com/oneliq_) · 💬 [Discord](https://discord.gg/7XUPdWWrGk)

---

## What is this?

**Oneliq** is a unified stablecoin platform that simplifies how people use USDC across chains. Built on Circle's infrastructure and designed for the [Arc Layer 1](https://arc.network), Oneliq brings trading, cross-chain balance management, automation, and onboarding into one seamless experience. Six surfaces, one balance, zero custody:

Arc is Circle's institutional EVM chain, where USDC is the native gas token - so we treat USDC as **one programmable balance** rather than dozens of siloed per-chain wallets.

### What ships today on Arc Testnet

| Surface | What it does | Powered by |
|---|---|---|
| **Unified Balance** | See USDC across 8 chains as one number. Spend cross-chain with a single EIP-712 signature (**Auto**, **Single**, or **Manual** sourcing), **Batch Pay** many recipients from a saved recipient book or a pasted list, **Distribute** back out to your own wallets, **Consolidate** scattered dust into one chain, and mint gasless on the destination via the Circle forwarder. Transfers still in flight resume after a page reload. | [Circle Gateway](https://www.circle.com/gateway) |
| **Trade** | On-Arc stablecoin swap (USDC ⇄ EURC) routed through Circle App Kit into the Arc Curve StableSwap pool, with `OneliqRouter` (0.3% fee) recording every trade, plus a CCTP V2 bridge merged into one flow. Fast (~20s) or Standard (free) mode, and the output can be parked straight into your Unified Balance without a second trip. | [Circle App Kit](https://developers.circle.com/) + [Circle CCTP V2](https://www.circle.com/cross-chain-transfer-protocol) |
| **Oneliq AI** | Chat that turns plain English into a ready-to-sign action - an automation rule with hard EIP-712 ceilings, or a cross-chain payment with its route and fee shown up front. The model only drafts and prefills; every transaction is signed by your own wallet. | Cloudflare Workers AI + [Circle Programmable Wallets](https://developers.circle.com/w3s/programmable-wallets) |
| **Portal** | Daily on-chain check-in (`OneliqCheckIn`) with Star Points, streaks, badges, referrals, and a live leaderboard - the loyalty layer for everything above. | Arc L1 + on-chain check-in contract |
| **Dashboard** | Your portfolio at a glance: profile, total value, holdings per chain, and recent activity. | Arc RPC + Cloudflare KV |
| **History** | Every Trade, Balance, and Agent action rendered as a receipt, stored per wallet so the log follows you between browsers and devices. | Cloudflare KV |

Network counters (total users, on-chain swap and check-in totals) are recomputed from Arc itself rather than from our own database. The operator console that surfaces them internally is credential-gated and is not part of the public surface.

Both a light and a dark theme ship on every page, and the choice is remembered.

### Coming soon

| When | What |
|---|---|
| **2026 Q4** | **Agent General Availability** - Auto-Replenish Agent goes GA, with mobile-friendly signing and execution notifications. |
| **2027 Q1** | **Multi-Asset Automation** - EURC support, cross-stable automation rules, and the first public Operations Dashboard. |
| **2027 Q2** | **Treasury Operations** - treasury workflows, payroll templates, portfolio analytics, reporting, and CSV export. |
| **2027 Q3** | **Production & Ecosystem** - independent security audit + bug bounty, deeper developer integrations, and early enterprise pilots. |

> See the full roadmap below.

You always retain custody. Oneliq never holds funds, and the agent backend executes only within EIP-712-signed bounds you can revoke at any time.

---

## Circle integration map

Every Circle product we use is integrated **natively** - no third-party bridges, no wrapped derivatives.

| Circle product | Status | Where in code |
|---|---|---|
| **USDC** | Live | Native unit of account across every surface. Per-chain addresses in [`assets/arc-core.js`](assets/arc-core.js). |
| **Circle Gateway** | Live (testnet) | EIP-712 `BurnIntent` / `BurnIntentSet` signing + 8-chain `/v1/balances` aggregation, cross-chain spend, Consolidate, and gasless forwarder mint. See [`assets/arc-gateway.js`](assets/arc-gateway.js) and [`functions/api/gateway-proxy/`](functions/api/gateway-proxy/). |
| **CCTP V2** | Live (testnet) | `TokenMessengerV2.depositForBurn` + `MessageTransmitterV2.receiveMessage`, Fast and Standard modes. See [`assets/arc-core.js`](assets/arc-core.js) and [`trade.html`](trade.html). |
| **App Kit (Stablecoin Kit)** | Live (testnet) | In-Arc USDC/EURC swap routed via [`functions/api/circle-proxy/`](functions/api/circle-proxy/) (so the API key never reaches the browser) into the Arc Curve StableSwap pool, fronted by `OneliqRouter`. |
| **Programmable Wallets** | Live (testnet) | Developer-Controlled Wallets API for the Agent backend - RSA-OAEP `entitySecretCiphertext`, per-chain wallet provisioning, USDC transfers. See [`functions/api/agent/_circle.js`](functions/api/agent/_circle.js). |
| **Nanopayments** | Planned (2027+) | Streaming USDC primitives - Agent SDK foundation. |

Supported chains for Unified Balance and CCTP V2: **Arc, Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, Unichain** (all testnets today).

---

## Tech stack

**Frontend**
- Pure HTML + CSS + vanilla JavaScript - no framework, no build step
- [ethers.js v6](https://docs.ethers.org/v6/) - only external runtime dependency (SRI-pinned CDN)
- EIP-6963 multi-wallet detection (MetaMask, Rabby, Coinbase Wallet, OKX, Brave)
- Light/dark theming shared across every page (`assets/arc-theme.css`, `assets/arc-theme.js`)

**Backend (Cloudflare Pages Functions)**
- `functions/api/gateway-proxy/` - server-side proxy to Circle Gateway REST (`gateway-api-testnet.circle.com`)
- `functions/api/circle-proxy/` - proxies Circle App Kit (`api.circle.com`) so `KIT_KEY` stays out of the browser
- `functions/api/agent/` - Agent CRUD endpoints backed by Cloudflare KV (`AGENT_KV`)
- `functions/api/agent/_circle.js` - Circle Programmable Wallets integration (wallet provisioning, USDC transfers)
- `functions/api/ai/` - Oneliq AI chat, running on the Cloudflare Workers AI binding (no third-party model key)
- `functions/api/history/` - per-wallet, cross-browser Trade/Balance history (`AGENT_KV`)
- `functions/api/recipients/` - per-wallet recipient book for Batch Pay (`AGENT_KV`)
- `functions/api/metrics/` - network counters, reconciled against Arc RPC
- `functions/auth/` - Portal: check-in, Star Points, streaks, badges, referrals, leaderboard (`PROFILE_KV`)
- `functions/_middleware.js` - page-level access gate for the private operator console (fails closed if its credentials are unset)
- `workers/agent-cron/` - scheduled Cloudflare Worker that fires agent rules on cadence
- `workers/kv-backup/` - scheduled Worker that snapshots KV so profiles and history are recoverable

**Infra**
- **Cloudflare Pages** - hosting + CDN + DDoS protection
- **Cloudflare KV** - agent rules, per-wallet history and recipients, Portal profiles
- **Cloudflare Workers AI** - the model behind Oneliq AI, called server-side
- **Status page** - separate Pages project at [status.oneliq.xyz](https://status.oneliq.xyz) so uptime reporting is isolated from the app
- **Optional: IPFS + ENS** - decentralized backup (see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md))

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

Open `http://localhost:8080` in a browser with MetaMask/Rabby installed. Grab testnet USDC from [faucet.circle.com](https://faucet.circle.com).

For full backend behavior (Agent, Gateway proxy, App Kit proxy, Portal, history):

```bash
# Requires Wrangler - Cloudflare's CLI
npm install -g wrangler
wrangler pages dev .
```

Set these env vars in `.dev.vars` for local backend testing (see `.env.example`):

```
CIRCLE_API_KEY=...           # Circle Programmable Wallets bearer token
CIRCLE_ENTITY_SECRET=...     # 64-hex entity secret (raw)
KIT_KEY=...                  # Circle App Kit API key
GATEWAY_KEY=...              # Optional - Gateway bearer if Circle requires it
```

No keys are needed for read-only frontend dev. Oneliq AI runs on the Cloudflare `AI` binding rather than a hosted model API, so there is no model key to configure - `wrangler pages dev` picks it up from the project bindings.

---

## Deployment

**Primary path** - Cloudflare Pages: see [`docs/DEPLOY_CLOUDFLARE.md`](docs/DEPLOY_CLOUDFLARE.md)
**Optional path** - IPFS + ENS (immutable): see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

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
├── trade.html              ← Swap (App Kit → Curve) + CCTP V2 Bridge  [LIVE]
├── agent.html              ← Oneliq AI chat + agent rules (EIP-712)   [LIVE]
├── portal.html             ← Check-in, Star Points, leaderboard       [LIVE]
├── dashboard.html          ← User portfolio (holdings + activity)     [LIVE]
├── history.html            ← Cross-browser Trade/Balance history      [LIVE]
├── ops.html                ← Private operator console (credential-gated)
├── docs.html, blog.html    ← Static docs + blog
├── blog/                   ← One HTML file per post
│
├── assets/
│   ├── arc-core.js         ← Shared on-chain helpers (RPC, ABIs, USDC addresses, EIP-6963)
│   ├── arc-core-v2.js      ← Newer chain helpers (deposit gas overrides, OP-Stack quirks)
│   ├── arc-gateway.js      ← Circle Gateway client (BurnIntent, spend, Consolidate, forwarder)
│   ├── arc-appkit.js       ← Circle App Kit swap client (config is generated at build time)
│   ├── arc-theme.js/.css   ← Light/dark theme switch, shared tokens
│   ├── arc-ui.js, arc-ui.css ← Shared app shell (sidebar nav + UI primitives)
│   └── logos/, badges/, social/ ← Brand marks and share images
│
├── functions/
│   ├── _middleware.js      ← Access gate for the private operator console
│   ├── api/gateway-proxy/  ← Server-side proxy → Circle Gateway REST
│   ├── api/circle-proxy/   ← Server-side proxy → Circle App Kit (KIT_KEY)
│   ├── api/ai/             ← Oneliq AI chat on the Workers AI binding
│   ├── api/agent/          ← Agent CRUD + Programmable Wallets backend
│   │   ├── [[path]].js     ← Routes (create, list, pause, resume, run-now, executions)
│   │   ├── _circle.js      ← Circle Developer-Controlled Wallets API integration
│   │   └── _balance.js     ← USDC balance checks per chain
│   ├── api/history/        ← Per-wallet Trade/Balance history (cross-browser sync)
│   ├── api/recipients/     ← Per-wallet recipient book for Batch Pay
│   ├── api/metrics/        ← Network counters, reconciled against Arc RPC
│   └── auth/               ← Portal: check-in, Star Points, streaks, badges, referrals, leaderboard
│
├── workers/
│   ├── agent-cron/         ← Scheduled execution worker (Cloudflare Cron Trigger)
│   └── kv-backup/          ← Scheduled KV snapshot worker
│
├── status/                ← Status page (deployed as its own Pages project)
├── contracts/             ← OneliqRouter + OneliqCheckIn sources
├── _headers, _redirects   ← Cloudflare Pages security + clean URLs
├── docs/                  ← Deployment + governance + incident-response runbooks
├── scripts/               ← Pre-flight + health-check + IPFS deploy helpers
├── .well-known/security.txt
├── SECURITY.md, SECURITY_CHECKLIST.md
├── SETUP-AGENT.md         ← One-time setup for the Agent backend (KV + Circle keys)
└── .env.example
```

---

## Security

- Content-Security-Policy on every page
- Subresource Integrity on every CDN script
- Strict referrer + permissions policies via `_headers`
- API keys never reach the browser (server-side proxies for App Kit + Programmable Wallets)
- Origin allowlist on every Pages Function
- The operator console and every maintenance endpoint are credential-gated and fail closed when their secrets are unset
- Prompts are sent to a Cloudflare-hosted model over the platform binding; Oneliq AI never sees a private key and can only prefill a form you sign yourself
- Source, config, and deck files are 404'd at the edge as defence in depth (see [`_redirects`](_redirects))
- Multi-sig governance for any privileged action (see [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md))

**Found a vulnerability?** See [`SECURITY.md`](SECURITY.md). Bounties from $100 to $50,000.
Contact: `security@oneliq.xyz` (PGP key in `SECURITY.md`).

---

## Roadmap

| Quarter | Milestone |
|---|---|
| **2026 Q3** _(Now)_ | **Platform Optimization** - continue improving Trade execution and liquidity routing, enhance Unified Balance and cross-chain settlement, strengthen Auto-Replenish Agent reliability, and refine overall platform performance and user experience. |
| **2026 Q4** | **Agent General Availability** - release the Auto-Replenish Agent as General Availability. Introduce mobile-friendly signing, execution notifications, and improved automation reliability. |
| **2027 Q1** | **Multi-Asset Automation** - expand automation beyond USDC with EURC support, introduce cross-stable automation rules, and launch the first public version of the Operations Dashboard. |
| **2027 Q2** | **Treasury Operations** - launch the Operations Dashboard with treasury workflows, payroll templates, portfolio analytics, reporting, and CSV export. |
| **2027 Q3** | **Production & Ecosystem** - strengthen platform security with an independent security audit and bug bounty, expand developer integrations, improve platform reliability, and run early enterprise pilots for stablecoin automation. |

See the live roadmap on the [homepage](https://oneliq.xyz/#roadmap).

---

## Disclaimer

Oneliq is **testnet-only** software. All assets are testnet tokens with no monetary value. Indicative yields and execution timings are not guarantees - actual results depend on Circle infrastructure, network conditions, and on-chain liquidity.

We use third-party smart contracts (Circle Gateway, Circle CCTP, the Curve StableSwap pool deployed on Arc) audited by their respective teams. Oneliq itself does not own or operate any of these contracts.

---

## License

License decision pending. Until then, all rights reserved by the Oneliq team. When we decide (likely **MIT** for the frontend, **Apache-2.0** for backend functions), this section will update.

---

_Built on [Arc](https://arc.network) - the developer platform for onchain finance. Powered by [Circle](https://www.circle.com/) primitives end-to-end._
