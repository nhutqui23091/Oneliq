# OneliqRouterV2 — deployment notes

Written after auditing the deployed V1 at
`0xb508F475230E4Ab876258B7DCaFbc182d806e1F7`. V1 is fine for testnet and is
still running; V2 exists so that mainnet does not inherit its sharp edges.

Compile with **solc 0.8.24**, optimizer on, 200 runs. Deployed size 5,677 bytes.

---

## What changed from V1, and why

Each line is a V1 audit finding, not a preference.

| V1 behaviour | Risk | V2 |
|---|---|---|
| `transferOwnership` took effect immediately | one typo permanently locks the fee pot | two-step: nominate, then the new owner accepts |
| Forwarded the pool's *reported* output | if the pool ever overstates it, the difference comes out of accrued fees | measures the balance delta and forwards only that |
| `withdrawFees` swept the whole token balance | any accounting slip reaches funds that are not fees | `accruedFees` ledger; a withdrawal can never exceed it |
| Unlimited approval left standing to the pool | a compromised or upgradeable pool could drain the fee balance at any time | approves exactly this swap, revokes after |
| No deadline | a stuck transaction executes later at a price nobody agreed to | `deadline` parameter |
| Relied on the pool to enforce `minOut` | trusts an external contract for the user's own bound | checks it here, against the measured delta |
| No reentrancy guard | safe only because the token set happened to be hardcoded | explicit guard |
| No pause | a broken pool cannot be cut off without a redeploy | `pause()` / `unpause()` |
| Reverts on ERC-20s that return nothing | would break against a USDT-style token | tolerates both shapes |
| Pool and tokens hardcoded as constants | mainnet needs a source edit, so the audited bytecode is not what ships | immutable constructor arguments |

Deliberately **not** added: a recipient parameter, arbitrary token support, and
any upgrade mechanism. Each widens the attack surface for convenience this
router does not need.

---

## Deploy

```
constructor(
  address pool,            // Curve StableSwap pool
  address token0,          // pool coin index 0  (USDC)
  address token1,          // pool coin index 1  (EURC)
  uint16  initialFeeBps,   // 30 = 0.30%, hard-capped at 100
  address initialOwner     // USE A MULTISIG
)
```

Arc Testnet values, verified on-chain:

```
pool   0x2d84d79c852f6842abe0304b70bbaa1506add457
token0 0x3600000000000000000000000000000000000000   USDC
token1 0x89b50855aa3be2f677cd6303cec089b5f319d72a   EURC
fee    30
```

Confirm before deploying that `token0` really is pool coin index 0. The router
maps `token0 -> 0` and `token1 -> 1`, and Curve gives no way to detect a swap
of the two — trades would price against the wrong leg. Check with
`pool.coins(0)`.

### The owner argument is the whole security model

Every admin function and the entire fee balance sit behind one address. V1's
owner is a plain wallet (`0x738722f2…`, no contract code, verified), so one
compromised key takes everything. **Deploy V2 with a multisig.** If a multisig
is not ready on day one, deploy with a wallet and hand over with
`transferOwnership` + `acceptOwnership` as soon as it is — the two-step flow
exists precisely so that handover cannot be fumbled.

---

## After deploying

1. Point `ARC_ROUTER` in `trade.html` at the new address, and update
   `ONELIQ_CONTRACTS` in `functions/api/metrics/[[path]].js`. Keep V1 in the
   metrics list so historical swaps still attribute.
2. `swap()` now takes five arguments, not four. The extra one is `deadline`.
   Every call site must pass it — `block.timestamp + 1200` is a reasonable
   default. A missed call site fails loudly (wrong selector), not silently.
3. Sweep fees to the treasury on a schedule. Fees sitting in a swap contract
   are exposure for no reason, whatever the code guarantees.
4. Verify the source on the explorer so the deployed bytecode is checkable
   against this file.

---

## Test coverage

99 cases on a real EVM (`@ethereumjs/vm`), all passing against the exact file
in this directory — the suite hashes the source and refuses to report on a
stale copy, which it caught once during development.

Behaviour: happy path, fee ledger arithmetic, allowance revoked after every
swap including when the pool consumes only part of it, deadline boundary at
exactly `block.timestamp`, `minOut`, pause, fee cap, constructor validation,
two-step ownership including a mistyped nomination being cancelled, access
control on all eight admin functions, and fee rounding to zero on dust.

Adversarial: a pool that reports a huge output but sends one unit, a pool that
calls back into `swap` mid-exchange, a pool that tries to pull more than the
exact allowance and to reach the output-token fee balance, a token that
re-enters from inside `transfer()`, a token that re-enters `rescue()`, tokens
that return nothing, and tokens that take a cut on every transfer.

Invariant: 300 randomised swaps in both directions with the fee changed
mid-run and withdrawals interleaved, asserting after every single one that the
contract's balance is at least what the fee ledger owes — and at the end that
it matches exactly, so nothing leaks in either direction.

One honest note on the `rescue()` reentrancy guard: the attack it defends
against already fails without it, because `onlyOwner` rejects the re-entering
call. That was confirmed by removing the guard and re-running the attack. It is
kept because that argument rests on the owner never being a contract that can
be induced to forward a call, which is a property of how you deploy rather than
of this code.

## What this does not cover

The Curve pool is a third party and is not audited here. V2 reduces what a
misbehaving pool can do — it cannot overstate output, cannot exceed the exact
allowance, cannot reenter, and can be cut off with `pause()` — but it cannot
make a bad pool give good prices. A paid audit before mainnet is still the
right call; this file is the starting point for one, not a substitute.

---

## Deployed (Arc Testnet)

| | |
|---|---|
| **OneliqRouterV2** | `0x607C2a739FCdEd84f0350AC43118d85F4398872b` |
| Creation tx | `0xde0f579b334f76b08c86074e417baf7c1bcb87cd650d67335e146643af723330` |
| Block | 60053709 |
| Deployer / owner | `0x738722f22Ef4fB6ABC3ac69bbc30F77B2B6bC762` (EOA — see below) |
| Compiler | solc 0.8.24, optimizer 200 runs |
| Runtime size | 5,677 bytes |

https://testnet.arcscan.app/address/0x607C2a739FCdEd84f0350AC43118d85F4398872b

Constructor arguments went in as intended — read back from the deployed
contract, not from the deploy form: `POOL` `0x2D84…D457`, `TOKEN0` `0x3600…0000`
(USDC), `TOKEN1` `0x89B5…D72a` (EURC), `feeBps` 30, `MAX_FEE_BPS` 100,
`pendingOwner` zero, `paused` false. `pool.coins(0)` was checked against
`TOKEN0` before deploying, so the index mapping is not reversed.

The deployed runtime code was diffed against the locally compiled artifact —
the one the test suite runs. With the three immutables masked (`POOL` appears 5
times in the runtime code, `TOKEN0` and `TOKEN1` twice each) the executable
bytes are identical; the only remaining difference is the 32-byte IPFS metadata
hash in the CBOR trailer, which encodes the source path rather than behaviour.
Both trailers end `64736f6c6343 000818 0033` — solc 0.8.24 on each side.

### First live swap

1 USDC → EURC, the first real trade through V2 against the actual Curve pool:
`0x9ab8dec8ed0e844ef8321ebb296f72150b1e062fccbb4034060bc384040d1af1`

The token trace is the whole design in four lines: user → router 1 USDC, router
→ pool 0.997, pool → router 0.783879 EURC, router → user 0.783879 EURC. State
afterwards, read on-chain:

| Check | Value | |
|---|---|---|
| `accruedFees[USDC]` | 3000 | exactly 0.30% of 1 USDC |
| `accruedFees[EURC]` | 0 | output leg takes no fee |
| Router USDC balance | 3000 | equals the ledger — nothing leaked |
| Router EURC balance | 0 | the whole output was forwarded |
| `allowance(router → pool)` | 0 (both tokens) | granted per-swap, revoked in the same tx |

That last row is the V1 finding closed on a live pool rather than a mock: V1
left an unlimited approval standing between swaps.

### Still outstanding before mainnet

`owner` is a plain EOA, so one key holds every admin function and the entire fee
balance. Fine for testnet; mainnet wants a multisig, handed over with
`transferOwnership` + `acceptOwnership`. Sweeping fees on a schedule (point 3
above) is not set up yet either.
