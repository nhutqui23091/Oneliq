# Governance & Key Custody — Oneliq

This document defines who controls what, and how changes are made.

**Target**: every privileged key is a multi-sig, so that no single person can move
funds, change contract parameters, or change DNS records.

**Current state**: we are not there. The OneliqRouter admin key is a single EOA.
This document says so plainly, and the gap is listed as an open item below.
An earlier version of this file opened by asserting the target as if it were
already true; it was not, and anyone could have checked `owner()` on chain and
seen that.

---

## Why multi-sig

| Risk | Single-key (EOA) | Multi-sig (Safe) |
|---|---|---|
| Signer loses seed phrase | All control gone | N-1 signers can recover |
| Signer hacked / coerced | Attacker controls everything | Needs M signers compromised |
| Signer leaves / disappears | Project stuck | Other signers continue |
| Insider rug-pull | Possible | Requires conspiracy of M people |
| Hot wallet phishing | One sig = drained | Attacker needs M sigs from M devices |

**Industry standard**: most established DeFi protocols hold privileged keys in a
Safe (formerly Gnosis Safe). Deploying one costs gas and nothing else.

---

## Keys & their current custody

Everything in this table is verifiable. Where it says EOA, call `owner()` on the
contract and then `eth_getCode` on the result - zero code bytes means a single key.

| Key | What it controls | Target | Status today |
|---|---|---|---|
| **OneliqRouter owner** | `setFeeBps` (capped 1.00%), `withdrawFees`, `pause`, `rescue`, `transferOwnership` | Multi-sig (Safe) | **Single EOA** - `0x390732e68560dc567082258f771706c2e3dff7db`, verified on chain |
| **OneliqCheckIn** | nothing - no `owner()`, no admin functions | n/a | Immutable by construction, nothing to custody |
| **Cloudflare account** | `oneliq.xyz` DNS + Pages deployment (the production frontend) | Account 2FA + hardware key | In place |
| **Treasury** | ops budget, any future bounty pool | Multi-sig (Safe) | No Safe address published |
| **Future: Timelock** | delay on router admin calls | 48h delay wrapping the owner Safe | Not deployed |

If a Safe is deployed for any row above, its address gets published here and in
the site footer, so the custody claim stays checkable rather than asserted.

---

## What the EOA can and cannot do

Worth being precise, because "single key" sounds worse than the actual exposure.

A compromise of the router owner key allows: raising the fee up to the immutable
`MAX_FEE_BPS` of 100 bps (1.00%), withdrawing accrued fees, pausing the router,
sweeping stray tokens above the accrued-fee accounting, and nominating a new
owner (two-step - the nominee must call `acceptOwnership`).

It does **not** allow taking user funds. The router pulls only the amount needed
for the swap being signed and holds no user balance at rest.

Full write-up: [`SECURITY_CHECKLIST.md`](../SECURITY_CHECKLIST.md#known-weakness-the-router-admin-key).

---

## Setting up a Safe on Arc Mainnet

### Step 1 — Visit the Safe app

1. Go to https://app.safe.global
2. Connect a hardware wallet (Ledger / Trezor / Frame)
3. Create new Safe
4. Network: **Arc Mainnet** (chainId 5042, RPC `https://rpc.mainnet.arc.io`) - add
   as a custom network if it is not listed

### Step 2 — Configure signers

For the **Router Owner Safe**, a 2 of 3 or 3 of 5 is appropriate at this size:
- Signer 1: Founder A's hardware wallet
- Signer 2: Founder B's hardware wallet
- Signer 3: Cold backup (recovery only, stored offline)

For a **Treasury Safe** (3 of 5):
- Signers 1-2: Founders
- Signer 3: CTO / lead engineer
- Signer 4: Independent advisor
- Signer 5: Cold backup

### Step 3 — Test before handing over power

1. Send a dust amount of USDC from the Safe to a test address
2. Verify each signer can sign in their own wallet
3. Verify execution lands on chain

### Step 4 — Hand over the router

`transferOwnership(safeAddress)` from the current EOA, then `acceptOwnership()`
from the Safe. The two-step pattern means a wrong address does not brick the
contract - the nomination simply never gets accepted.

### Step 5 — Document signer info privately

In an encrypted store, not in this repo:
- Signer name + role
- Hardware wallet model
- Backup recovery method
- Expected response time

---

## Adding a Timelock (later)

A **Timelock** wraps the Safe and forces a delay between proposal and execution.

```
Proposal → Safe (M of N sigs) → Timelock (48h delay) → Router.setFeeBps()
```

Benefits: pending changes are visible in advance, and the blast radius of a
compromised Safe shrinks. Use **OpenZeppelin TimelockController**.

This matters less for our contracts than for upgradeable ones - the router is not
behind a proxy, so there is no upgrade path to delay, only parameter changes.

---

## Signer rotation policy

Once a Safe exists:

- Review signers **every 6 months**
- Remove signers unresponsive for more than 3 months
- Onboard new signers via test transactions before granting power
- Log every change in this file, in a `Signer changes` section

---

## Emergency procedures

### If the router owner EOA is compromised

While the owner is a single key, there is no quorum to fall back on. The response
is:

1. `pause()` the router immediately if the key is still in our control, to stop
   fee accrual into a contract an attacker can sweep
2. Deploy a replacement router and point the frontend at it
3. Communicate per [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md)

This procedure being this thin is the argument for finishing the Safe migration.

### If a Safe signer's key is compromised (once a Safe exists)

1. Remaining signers immediately create a tx removing the compromised signer
2. Sign + execute
3. Add a fresh hardware wallet as replacement
4. Public post-mortem

---

## Public verification

Anyone can check our custody claims without trusting this file:

```bash
# Who owns the router?
curl -s -X POST https://rpc.mainnet.arc.io -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x3635f71daa996e22867647cc58358c5803133a69","data":"0x8da5cb5b"},"latest"]}'

# Is that owner a contract (Safe) or a single key (EOA)? 0x means EOA.
curl -s -X POST https://rpc.mainnet.arc.io -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x390732e68560dc567082258f771706c2e3dff7db","latest"]}'
```

Transparency is the security feature. A documented single key beats an
undocumented one, and both lose to a published Safe.

---

_Last updated: 2026-10-04_
