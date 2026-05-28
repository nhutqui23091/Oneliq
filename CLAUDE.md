# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ArcSwap — a DeFi frontend (yield terminal) for stablecoins on **Arc Testnet**
(chainId `5042002`, RPC `https://rpc.testnet.arc.network`). It is a **pure
static site** (vanilla HTML/CSS/JS, no bundler, no framework) deployed via
Cloudflare Pages at https://arcswap.net. It owns no contracts; everything is
either Circle (USDC, EURC, CCTP, Gateway, App Kit) or Hashnote (USYC).

## Deploy (no build step)

- `git push origin main` → Cloudflare Pages picks it up and deploys in ~90s.
- There is no bundler. HTML files are served as-is.
- `scripts/build-config.sh` runs in the Cloudflare build to write
  `assets/arc-appkit-config.js` (which is `.gitignore`d). It only writes a
  PLACEHOLDER `kitKey` — the real `KIT_KEY` lives as an encrypted env var on
  Cloudflare and is injected server-side by the proxy.
- Pre-deploy lint: `bash scripts/preflight-check.sh` (CSP / SRI / no secrets /
  no `target=_blank` without `rel=noopener`). Branch protection on `main`
  expects this check.

## Cache-buster discipline (critical)

Every page loads shared assets via `?v=X.Y.Z` query strings, e.g.
`<script src="/assets/arc-core.js?v=9.4.1">`. **Whenever you change any file
under `assets/`, you must bump the `?v=` on every page that loads it**,
otherwise users keep getting the cached old version. The version inside
`arc-core.js` (`version: '9.4.1'`) should track the cache-buster too.

Convention: minor bumps for behavior changes (`9.3.x → 9.4.0`), patch bumps for
small fixes (`9.4.0 → 9.4.1`).

## Architecture

### Shared module layer (`assets/`)

Three IIFE-wrapped modules attach to `window.ARC` and `window.ArcUI`. Pages
load them via `<script>` tags, then optionally dynamic-import App Kit.

| Module | Role |
|---|---|
| `arc-core.js` | Single source of truth for `CHAINS`, `TOKENS`, `ABIS`. Wallet abstraction (`ARC.wallet` — EIP-6963 discovery, RDNS-based priority, `connect/disconnect/ensureChain`, last-used wallet remembered in `localStorage`). RPC providers, multicall, CCTP IRIS client, formatters, error explainer. |
| `arc-ui.js` | Shared nav, toast, modal, wallet picker (`ArcUI.openModal`, `ArcUI.toast`, `ArcUI.boot`). Used by `trade.html`. Other pages have inline navs and don't load it. |
| `arc-gateway.js` | Circle Gateway client. `readBalances` via REST `/v1/balances`, `deposit/initiateWithdrawal/finalizeWithdrawal` on-chain, `pickSources` greedy multi-chain selector, `multiSpend` (N burn intents → 1 attestation → 1 mint). |
| `arc-appkit.js` | Lazy ESM import of Circle App Kit (`@circle-fin/app-kit@1.4.1` + `adapter-ethers-v6@1.6.5`) from esm.sh. Patches `fetch` to reroute `api.circle.com` calls through `/api/circle-proxy/*`. Used for USDC↔EURC swaps on Arc. |

### Cross-chain pipeline (trade.html)

`trade.html` contains the full smart-routing logic. The flow is **stateful and
pipelined**:

1. `loadAllSources()` — on wallet connect, fetches USDC balance × {wallet,
   gateway} for all 8 supported chains in parallel (1 REST call covers all
   Gateway chains; one RPC per chain for wallet balances).
2. `planRoute()` — given `state.src` (chain + kind: wallet/gateway/unified) and
   `state.dst` + token, returns an ARRAY of step objects:
   - `{type: 'gateway-spend', src, dst}` — single-chain Gateway burn+mint
   - `{type: 'gateway-multi-spend', dst}` — multi-chain Gateway burn+mint
     (Unified mode: `pickSources` chooses chains greedily by largest balance)
   - `{type: 'cctp-bridge', src, dst}` — CCTP V2 burn → IRIS attestation → mint
   - `{type: 'swap', chain:'arc', tIn, tOut}` — App Kit swap on Arc
   - `{type: 'transfer', chain, token}` — same-chain ERC-20 send
3. `quote()` walks the steps to compute `amountOut`, fee labels, total time.
4. `execute()` runs them sequentially with a progress modal, halting on
   failure. Intermediate steps land in user's own wallet; only the FINAL step
   honors the recipient address.

`balance.html` has its own (simpler) Spend modal with the same Unified vs
Single chain toggle.

### Cloudflare Pages Functions (`functions/api/`)

Two same-origin proxies with origin allowlisting (arcswap.net / *.pages.dev /
localhost). Both inject Authorization server-side from env vars so secrets
never reach the browser:

- `circle-proxy/[[path]].js` → `api.circle.com` (uses `env.KIT_KEY`)
- `gateway-proxy/[[path]].js` → `gateway-api-testnet.circle.com`
  (uses `env.GATEWAY_KEY` if set; testnet currently doesn't require auth)

Path allowlist on gateway-proxy: only `v1/balances`, `v1/transfer`, `v1/info`.

### Decimal handling (gotcha)

Arc's USDC is the **native gas token at 18 decimals**, but Circle's protocols
(CCTP, Gateway) use **canonical 6-decimal USDC** at the wire. `arc-core.js`
exposes `toCctpAmount` / `fromCctpAmount` to scale at the boundary. Within
Arc itself, `balanceOf` / `transfer` / `approve` all operate in 18d.
`tokens.arc.USDC.cctpDecimals = 6` is the marker.

The Gateway REST API returns balances as decimal strings (`"10.000000"`), not
integers — `arc-gateway.js`'s `balToCanonical` routes through `ARC.parseAmt`
to handle this (a previous bug had `BigInt("10.000000")` throwing silently).

## When working in this repo

- Read the existing module before editing. Patterns matter: `state` is a
  shared mutable object in each page, route planning is pure, execute is the
  side-effecting layer.
- **Never put `KIT_KEY` or `GATEWAY_KEY` in client-side files.** They go in
  Cloudflare env vars. `assets/arc-appkit-config.js` is `.gitignore`d for this
  reason.
- All HTML pages have an inline `<meta http-equiv="Content-Security-Policy">`
  AND `_headers` mirrors it for defense-in-depth. When adding a new RPC host
  or API origin, update `connect-src` in BOTH places + every HTML page (a
  Python one-liner across the 12 HTML files is the usual pattern — see git
  history for examples like commit `ad255c5`).
- **Vault is currently paused** pending Circle re-enable — `VAULT_PRIVATE_BETA = true`
  in `vault.html`. Don't flip it back without explicit ask.
- Commit messages: imperative present, English, scoped (`feat(trade):`,
  `fix(wallet):`, `chore:`). Recent commits are good examples.

## Existing constraints (from README)

- Don't change network config or contract addresses without explicit ask.
- Don't refactor `assets/`, `functions/`, or `scripts/` casually — these are
  shared across every page.
- Don't touch `.env`.
- Branch protection on `main` requires preflight-check; pushes from Claude
  bypass it (warning shown but commit lands). If hooks fail in normal usage,
  fix the cause rather than skipping.
