# Auditing OneliqRouter (Arc Mainnet)

Practical guide for auditing the deployed contract yourself and/or getting
a paid review. Free static analysis first, then optionally paid audit.

---

## Tier 0 — free, do first (30 minutes)

### Slither (static analysis)

```bash
# Install once
pip3 install slither-analyzer

# Run against the source
cd contracts
slither src/OneliqRouter.sol \
  --solc-remaps @openzeppelin=lib/openzeppelin-contracts \
  --exclude naming-convention,solc-version,pragma
```

Expected findings on OneliqRouter (all deliberate, not bugs):
- **arbitrary-send-erc20** on `_pull` / `_push` — false positive: recipient
  is always `msg.sender` or an owner-controlled `to`.
- **assembly-usage** — none; contract has no assembly.
- **reentrancy-events** on `swap` — `Swap` event is emitted after all
  external calls, but the `nonReentrant` modifier prevents re-entry.

**Red flags to actually worry about** (should not appear):
- `arbitrary-send-eth` — this contract never handles native ETH.
- `unprotected-upgrade` — there's no upgrade mechanism.
- `tx-origin` — never used.
- `dangerous-strict-equalities` in `swap` — none in production paths.

If Slither surfaces something not in the "expected" list above, dig in
before deploying — those are actionable.

### Mythril (symbolic execution, deeper)

```bash
pip3 install mythril
myth analyze src/OneliqRouter.sol --solv 0.8.24 --execution-timeout 300
```

Runs ~5 minutes. Flags: integer overflow (impossible in 0.8.24 for
non-`unchecked` code), reentrancy (guarded), unprotected functions
(all admin functions have `onlyOwner`).

### Manual invariant checks

Read the contract while asking these questions — write down answers:

1. **Can anyone but `owner` call `withdrawFees` / `pause` / `setFeeBps` /
   `transferOwnership` / `rescue`?** — Only owner (via `onlyOwner` modifier).
2. **Can `rescue` drain accrued fees?** — No: the guard `bal - accrued <
   amount` ensures rescue can only take the excess above accruedFees.
3. **Can a re-entering token break state?** — `nonReentrant` prevents it;
   even if bypassed, the balance-delta pattern would still credit the
   correct amount.
4. **Can `feeBps` be set above 1%?** — No: `require(newBps <= MAX_FEE_BPS)`
   where `MAX_FEE_BPS = 100` and is `constant` (immutable at compile).
5. **Can the router send output to anyone but `msg.sender`?** — No: the
   `_push(tokenOut, msg.sender, amountOut)` line hardcodes the recipient.
6. **What if the Universal Router calldata sends output somewhere else?** —
   Then `balAfter - balBefore == 0` and `minOut` fires. User loses fee
   but not output.
7. **What if Universal Router is compromised?** — Permit2 allowance is
   `uint160(netIn)` scoped to this swap and expires at `deadline`. Even a
   malicious router can only pull `netIn` of `tokenIn` once, not the max.

---

## Tier 1 — a peer review (~$500-2000, ~1 week)

Post on:
- [Immunefi Marketplace](https://immunefi.com/services/audits/) — matches
  you with vetted freelance reviewers.
- [Code4rena Private Audits](https://code4rena.com/audits) — competitive
  private audit; ~$5-15k for small contracts, ~1 week turnaround.
- [Cantina Reviews](https://cantina.xyz/) — Spearbit's marketplace.

For a ~300-line contract like OneliqRouter, expect 2-3 findings max at
this tier, mostly informational. Focus scope on:
- The Permit2 approval flow (`_ensurePermit2Approval` + per-swap
  `IPermit2.approve` scope).
- The balance-delta measurement (what if `tokenOut` is a fee-on-transfer
  token that takes a cut on the router's outbound `_push`?).
- Owner privilege scope (rescue, pause, feeBps changes mid-flight).

---

## Tier 2 — paid audit (~$15-50k, 2-4 weeks)

Real firms for real capital:
- [OpenZeppelin](https://openzeppelin.com/security-audits/) — ~$25-50k
- [Trail of Bits](https://www.trailofbits.com/) — ~$30-80k
- [Halborn](https://www.halborn.com/) — ~$20-50k
- [Zellic](https://www.zellic.io/) — ~$15-40k
- [Spearbit](https://spearbit.com/) — ~$25-60k

**When to spend this:**
- Router is handling > $100k / week in swap volume, OR
- You're announcing partnerships that require an audit line item, OR
- Fee ledger holds > $10k in accrued balances.

Below those thresholds, Tier 0 + Tier 1 is honest coverage.

### What to send auditors

A single zip with:
1. `contracts/src/OneliqRouter.sol` (this file)
2. `contracts/AUDIT-GUIDE.md` (this file)
3. `contracts/DEPLOY-MAINNET.md` (deployment intent + constructor args)
4. `contracts/test/` — Foundry test suite (see below)
5. Deployment address on Arc mainnet + the constructor tx hash

### Foundry test suite skeleton

Auditors want to see coverage. Minimum tests to write:

```solidity
// test/OneliqRouter.t.sol
contract OneliqRouterTest is Test {
    // Happy path: 1 USDC → EURC swap, verify fee accrual, delta forward
    function test_swap_happyPath() public;
    // Boundary: swap at exactly deadline
    function test_swap_deadlineBoundary() public;
    // Slippage: minOut > actual, reverts
    function test_swap_slippageRevert() public;
    // Fee cap: setFeeBps(101) reverts
    function test_setFeeBps_capEnforced() public;
    // Ownership: transferOwnership then acceptOwnership
    function test_ownership_twoStep() public;
    // Rescue guard: cannot dip into accrued
    function test_rescue_cannotExceedAccrued() public;
    // Reentrancy: mock token that re-calls swap
    function test_swap_reentrancyGuard() public;
    // Non-standard ERC-20: USDT-style silent transfer
    function test_swap_usdtStyleToken() public;
    // Universal Router revert propagates
    function test_swap_uniswapRevertPropagates() public;
    // Pause: swap reverts when paused
    function test_swap_pausedReverts() public;
}
```

Run: `forge test -vv`

---

## Bug bounty (~$1-25k pool, continuous)

Post the deployed address on:
- [Immunefi](https://immunefi.com/explore/) — $1-100k+ pool, biggest crypto bounty platform
- [HackenProof](https://hackenproof.com/programs) — smaller, faster to launch

Recommended structure for a fresh router:
- **Critical** (steals user funds, drains fee pot): $5k-25k
- **High** (griefing that costs users gas or fees): $500-2k
- **Medium** (recoverable bug): $100-500
- **Low / info**: acknowledgement only

Start small ($1k pool) and grow as TVL / volume grows.

---

## Token audit (checking tokens the router will touch)

Even a perfect router can be bricked by a malicious ERC-20. Before adding
a new token to Trade tab, check the token contract on the chain explorer:

1. **Is source verified?** Unverified = red flag. Do not integrate.
2. **Is there a `blacklist(address)` or `pause()` function?** — USDC and
   EURC both have these (Circle's regulatory hooks). Fine, but know it.
3. **Is `transfer` / `transferFrom` overridden?** — Fee-on-transfer or
   rebasing tokens break the balance-delta model. Router will still work
   but users get less than quoted.
4. **Is `owner` a multisig or a fresh EOA?** — Fresh EOA = higher rug risk.
5. **How many holders / age / TVL?** — Cheap dashboard: `dexscreener.com`,
   `defillama.com`, `arkham.com`.

For USDC and EURC on Arc mainnet — Circle-issued, native, safe.

For meme coins (once aka.fun-style launchpads land on Arc) — assume all
of the above red flags are present until proven otherwise. Don't
integrate them into the Trade tab's default token list.

---

## Contact

If Slither / Mythril / a paid audit surfaces a real finding, don't
hot-patch the deployed router. Instead:
1. `pause()` the router immediately.
2. Deploy a fixed version at a new address.
3. Update `_MAINNET_CHAINS.arc.contracts.router` to the new address.
4. `withdrawFees` from the paused old router to the treasury.
5. Explain the incident publicly (transparency > reputation dent).
