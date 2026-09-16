# Deploying to Arc Mainnet

Step-by-step for deploying OneliqRouter (Uniswap v4 wrapper) and
OneliqCheckIn to Arc Mainnet (chain id 5042) using Foundry from a new EOA.

> **Ví**: bạn dùng một EOA mới. Không multisig. Đây là setup MVP — sau này
> nên chuyển ownership sang multisig (Safe deploy trên Arc khi có) qua
> `transferOwnership` + `acceptOwnership` (two-step) để một key bị lộ không
> lấy được toàn bộ fee pot.

---

## 0. Prerequisites

| Tool | Version | Install |
|---|---|---|
| Foundry (forge + cast) | latest | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| A funded EOA on Arc Mainnet | — | Bridge USDC via [bridge.usdc.com](https://bridge.usdc.com) (Arc is listed under sources/destinations) |
| Wallet private key (or Ledger, or keystore) | — | Never commit; export as `$DEPLOYER_PK` in a shell you don't share |

**Gas estimate** (Arc uses USDC for gas):
- OneliqRouter deploy: ~2.5M gas → ~$0.01-0.05 USDC
- OneliqCheckIn deploy: ~800k gas → ~$0.005 USDC
- Total: **budget ~$1 USDC** and you're comfortably fine.

---

## 1. Repo setup

From project root:

```bash
cd contracts
forge init --no-commit --no-git --force
```

This creates `foundry.toml`, `lib/`, `src/`, etc. Move the two `.sol` files
into place:

```bash
mkdir -p src
mv OneliqRouter.sol src/OneliqRouter.sol
mv OneliqCheckIn.sol src/OneliqCheckIn.sol
```

Edit `foundry.toml`:

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.24"
optimizer = true
optimizer_runs = 200
evm_version = "cancun"  # Arc runs Osaka; cancun is subset-safe

[rpc_endpoints]
arc_mainnet = "https://rpc.mainnet.arc.io"

[etherscan]
# Arc explorer verification once endpoints are published.
# arc_mainnet = { key = "$ARC_EXPLORER_KEY", url = "https://explorer.arc.io/api" }
```

Compile:

```bash
forge build
```

Expected output: `Compiler run successful!` No warnings on OneliqRouter.

---

## 2. Deploy OneliqRouter

### 2a. Set env vars

```bash
export DEPLOYER_PK=0xYOUR_NEW_EOA_PRIVATE_KEY
export RPC=https://rpc.mainnet.arc.io
export OWNER=0xYOUR_EOA_ADDRESS   # same wallet or a different admin

# Constants from Uniswap v4 + Arc mainnet
export UNIVERSAL_ROUTER=0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1
export PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
export FEE_BPS=30   # 0.30%, hard-capped at 100 (=1%)
```

### 2b. Deploy

```bash
forge create src/OneliqRouter.sol:OneliqRouter \
  --rpc-url $RPC \
  --private-key $DEPLOYER_PK \
  --broadcast \
  --constructor-args $UNIVERSAL_ROUTER $PERMIT2 $FEE_BPS $OWNER
```

Foundry prints:
```
Deployer:  0xYOUR_EOA
Deployed to: 0xROUTER_ADDRESS
Transaction hash: 0xTX_HASH
```

**Save the router address**. You'll need it in step 5.

### 2c. Verify the constructor arguments were what you meant

Foundry doesn't stop you from a typo. Read back:

```bash
cast call 0xROUTER_ADDRESS "UNIVERSAL_ROUTER()(address)" --rpc-url $RPC
cast call 0xROUTER_ADDRESS "PERMIT2()(address)" --rpc-url $RPC
cast call 0xROUTER_ADDRESS "owner()(address)" --rpc-url $RPC
cast call 0xROUTER_ADDRESS "feeBps()(uint16)" --rpc-url $RPC
cast call 0xROUTER_ADDRESS "MAX_FEE_BPS()(uint16)" --rpc-url $RPC
cast call 0xROUTER_ADDRESS "paused()(bool)" --rpc-url $RPC
```

Every value must match what you passed. If any is off — do NOT wire this
address into the frontend. Redeploy with the correct constructor args.

---

## 3. Deploy OneliqCheckIn

```bash
forge create src/OneliqCheckIn.sol:OneliqCheckIn \
  --rpc-url $RPC \
  --private-key $DEPLOYER_PK \
  --broadcast
```

(This contract has no constructor args in the current source; if you added
some, pass them via `--constructor-args`.)

Save the check-in address.

---

## 4. Sanity swap on mainnet (belt-and-braces)

Do a **1 USDC → EURC** test swap through the deployed router BEFORE wiring
it into the frontend. The safest way is a scripted swap that uses the
Uniswap v4 SDK to build the calldata:

```js
// scripts/first-swap.mjs (node ≥ 20)
import { UniversalRouterAbi, ... } from '@uniswap/universal-router-sdk';
// build commands + inputs for USDC → EURC on Arc mainnet
// call OneliqRouter.swap(...)
```

I can generate this script when you're ready — needs the router address,
the USDC/EURC pool key on Arc (pool discovery via the v4 Quoter), and
your `$DEPLOYER_PK`.

If the test swap succeeds:
- `accruedFees[USDC]` on the router = 3000 (0.30% of 1 USDC in 6-dec canonical)
- Router's USDC balance = 3000 (matches ledger)
- Router's EURC balance = 0 (all output forwarded to you)
- Permit2 allowance to Universal Router = 0 (revoked in same tx)

Read these on-chain:
```bash
cast call 0xROUTER_ADDRESS "accruedFees(address)(uint256)" \
  0x3600000000000000000000000000000000000000 --rpc-url $RPC
```

---

## 5. Wire addresses into the frontend

Edit [assets/arc-core-v2.js](../assets/arc-core-v2.js). Find `_MAINNET_CHAINS.arc.contracts` and set:

```js
router:   '0xROUTER_ADDRESS',    // OneliqRouter deployed in step 2
checkIn:  '0xCHECKIN_ADDRESS',   // OneliqCheckIn deployed in step 3
```

Bump the cache-buster (`?v=X.Y.Z` at the top of every HTML file) so
browsers pick up the new JS, then `git commit && git push` — Cloudflare
Pages auto-deploys.

---

## 6. Post-deploy hygiene

1. **Sweep fees on a schedule**: `withdrawFees(token, treasury)` moves the
   accrued balance to a wallet you control. Any USDC/EURC sitting on the
   router is unnecessary exposure.
2. **Monitor `paused` state**: if you ever call `pause()`, front-end swaps
   revert with `IsPaused()`. Communicate to users while paused.
3. **Rotate to multisig when ready**: `transferOwnership(safeAddress)` +
   have the safe call `acceptOwnership()`. Two-step means one typo doesn't
   brick the fee pot.
4. **Verify source on explorer** once Arc publishes verification: makes
   `explorer.arc.io/address/0xROUTER_ADDRESS` show source and read/write
   tabs. Trust anchor for users.
5. **Add router to the Trade tab quote pipeline** (I do this in a follow-up
   frontend commit once addresses are wired).

---

## Troubleshooting

**`InsufficientOutput()`** — the Uniswap calldata's TAKE_ALL amount is
lower than `minOut` you passed. Frontend usually derives minOut from the
Quoter; if you're calling directly, use the Quoter first.

**`TransferFailed()` on pull** — user didn't `approve` the router for
tokenIn. First-time users must approve once (standard ERC-20 flow); the
frontend prompts this automatically.

**`FeeTooHigh()` on setFeeBps** — you tried `> 100` (1%). Cap is
deliberate; the constant `MAX_FEE_BPS` cannot be changed post-deploy.

**Nothing appears on explorer.arc.io** — during private mainnet the
explorer is permissioned. Contract still works via RPC. Use
`cast call` / `cast tx` in the meantime.

---

## What to send me after deploy

Paste these three lines back so I can wire the frontend:

```
ROUTER=0x...
CHECKIN=0x...
DEPLOY_TX=0x...
```
