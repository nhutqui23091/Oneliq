# OneliqRouterV2 deploy — Arc Mainnet

Same drill as OneliqRouter (v1) but the constructor takes one extra argument
(SwapRouter02) and the contract picks up a new `swapV3()` method so V3 memes
route through Oneliq too. Fee stays at 0.30%.

## 1. Compile

Already covered by the existing `foundry.toml` (`via_ir = true`).

```bash
cd /c/arc-swap-v9/contracts
forge build --contracts src/OneliqRouterV2.sol
```

Expect: `OneliqRouterV2.sol:OneliqRouterV2` compiled without errors.

## 2. Deploy

Reuse the same `.env` from OneliqRouter v1 (DEPLOYER_PK + RPC). No new
secrets. Constructor args:

| Arg | Value |
|---|---|
| `universalRouter` | `0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1` |
| `permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| `swapRouter02` | `0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77` (Arc's Uniswap v3 SwapRouter02) |
| `initialFeeBps` | `30` (0.30%) |
| `initialOwner` | `0x390732e68560dc567082258f771706c2e3dff7db` (your EOA) |

```bash
forge create src/OneliqRouterV2.sol:OneliqRouterV2 \
  --rpc-url arc_mainnet \
  --private-key $DEPLOYER_PK \
  --broadcast \
  --constructor-args \
    0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1 \
    0x000000000022D473030F116dDEE9F6B43aC78BA3 \
    0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77 \
    30 \
    0x390732e68560dc567082258f771706c2e3dff7db
```

Copy the `Deployed to:` address. Paste it back in chat so I can wire the
frontend to it.

## 3. Slither audit (optional, same as v1)

```bash
slither src/OneliqRouterV2.sol --solc-remaps '@openzeppelin/=lib/openzeppelin-contracts/' --exclude-informational
```

Findings should be the same tier as v1: no medium/high, only informational
notes (uint128 castable, low-level calls — both deliberate).

## 4. What happens next

Once you give me the new address, I:
- Set `_MAINNET_CHAINS.arc.contracts.router` in `arc-core-v2.js` to the
  V2 address. (Frontend polymorphically calls `swap()` for V4 and
  `swapV3(...)` for V3 — same interface as before, minus the direct
  SwapRouter02 detour we did as a stop-gap.)
- Bump cache-busters, commit, push.
- Your existing v1 router at `0xB1Ed79ee288C4631176440b7f4e624C6B4f078F0`
  stays functional for anyone with a cached page, but new sessions land
  on V2 and every fee (v3 or v4) accrues there.

Fees already accrued on v1 stay withdrawable from v1 — you don't lose them.
