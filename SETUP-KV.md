# KV Setup

Oneliq's edge backend needs one Cloudflare KV namespace bound to the Pages
project. Without it, per-wallet history, saved recipients, wallet sessions,
Discord/OG verification, and the telemetry rollup all fail closed.

> **The binding is named `AGENT_KV`.** That name is a leftover from the Agent
> feature, which was closed on 2026-10-04. The namespace has nothing to do with
> agents any more - it is the app's general edge store. Renaming the binding
> would mean touching 11 Functions at once, so the name stays and this note
> explains it.

---

## 1. Create the namespace

1. Cloudflare dashboard → **Workers & Pages** → **KV** → **Create a namespace**
2. Name it whatever you like (ours is `arcswap-agents-prod`, also a leftover)
3. Note the namespace ID

## 2. Bind it to the Pages project

1. Cloudflare dashboard → **Workers & Pages** → your Oneliq project →
   **Settings** → **Functions** → **KV namespace bindings** → **Add binding**
2. Variable name: `AGENT_KV` — **must be exactly this**, it is hard-coded in
   every Function listed below
3. Select the namespace from step 1
4. Add the binding for **both** Production and Preview, then redeploy

A Pages project picks up a new binding only on the next deploy, so push an empty
commit or hit **Retry deployment** after adding it.

## 3. Verify

```bash
# Binding present  → 401 unauthorized (the auth gate is doing its job)
# Binding missing  → 503 history storage unconfigured
curl -s "https://oneliq.xyz/api/history/list?address=0x000000000000000000000000000000000000dEaD"
```

---

## What reads this namespace

| Function | What it stores |
|---|---|
| `functions/_middleware.js` | runs on every request |
| `functions/api/session/[[path]].js` | wallet session tokens + nonces |
| `functions/api/history/[[path]].js` | `history:<addr>` - per-wallet trade/balance history |
| `functions/api/recipients/[[path]].js` | saved payout recipients |
| `functions/api/metrics/[[path]].js` | `metric:*` telemetry rollup |
| `functions/api/circle-proxy/[[path]].js` | Circle proxy state |
| `functions/auth/gm.js` | `gm:*` check-in records |
| `functions/auth/gm-message-verify.js` | check-in signature verification |
| `functions/auth/discord/start.js` | Discord OAuth state |
| `functions/auth/og-verify.js` | OG verification |
| `functions/auth/profile/[address].js` | per-wallet profile |

Rate limiting also uses this namespace (`rl:*` keys). That one path deliberately
degrades open: if the binding is missing, `underRateLimit()` returns true rather
than locking everyone out. Auth does **not** degrade open - a missing binding
makes the wallet-scoped endpoints return 503, not 200.

---

## Key prefixes

| Prefix | Owner | Safe to delete |
|---|---|---|
| `history:<addr>` | per-wallet history | no - user data |
| `recip:<addr>` | saved recipients | no - user data |
| `sess:*`, `nonce:*` | wallet sessions | yes - they expire anyway |
| `metric:*` | telemetry counters | no - would reset published numbers |
| `gm:*` | Portal check-ins | no - feeds the on-chain-backed streak history |
| `rl:*` | rate-limit windows | yes - TTL'd |
| `agent:*`, `agent:<id>:executions` | **dead** - the closed Agent API | yes - nothing reads them |

---

_Last updated: 2026-10-04_
