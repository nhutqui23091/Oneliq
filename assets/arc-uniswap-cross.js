/* Oneliq — Uniswap v3 helper for non-Arc chains
 * Quote + execute USDC ↔ USDT ↔ ETH/AVAX/POL swaps on Base / Arbitrum / OP /
 * Polygon / Avalanche / Unichain by hitting each chain's official SwapRouter02
 * and QuoterV2 directly. No OneliqRouter fee wrapper here — the fee model only
 * applies on Arc; on other chains the user pays just the Uniswap pool fee.
 *
 * Requires: arc-core-v2.js (window.ARC) + ethers v6 loaded first.
 */
(function (global) {
  'use strict';
  if (!global.ARC) { console.error('[arc-univ-cross] ARC core not loaded'); return; }
  const ARC = global.ARC;
  const { Contract, getAddress, ZeroAddress } = global.ethers;

  const NATIVE_ADDR = '0x0000000000000000000000000000000000000000';
  // SwapRouter02 sentinel: recipient = 0x0000…0002 tells the router to keep
  // the output in its own balance so the following multicall step (unwrap)
  // can send native ETH to the user.
  const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';

  // Fee tiers to probe, cheapest first. Stable-to-stable pairs (USDC/USDT)
  // almost always live in the 100 (0.01%) tier; ETH/USDC pairs in 500 (0.05%).
  const FEE_TIERS = [100, 500, 3000, 10000];

  const QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  ];
  const ROUTER_ABI = [
    'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
    'function multicall(bytes[] data) payable returns (bytes[] results)',
    'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
    'function refundETH() payable',
  ];
  const ERC20_ABI = [
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ];

  // Resolve the on-chain token address to hit the pool with. Native gas
  // (address 0x0) has no pool of its own — Uniswap wraps it to WETH9 (or the
  // chain's canonical wrapped native, e.g. WMATIC on Polygon, WAVAX on
  // Avalanche). Chain contracts store this at `weth9`.
  function _poolAddr(chainKey, token) {
    if (!token) return null;
    if (token.isGas || token.address === NATIVE_ADDR) {
      const c = ARC.CHAINS[chainKey];
      return c?.contracts?.weth9 || null;
    }
    return token.address;
  }

  // ── Quote ──────────────────────────────────────────────────────────────
  // Cache the winning fee tier per pair for 10 min so subsequent quotes
  // skip the fee-scan and go straight to the known-good tier.
  const CACHE_TTL_MS = 10 * 60 * 1000;
  function _cacheKey(chainKey, a, b) {
    return `arc-uni-cross:fee:${chainKey}:${[a.toLowerCase(), b.toLowerCase()].sort().join('_')}`;
  }
  function _loadFee(chainKey, a, b) {
    try {
      const raw = localStorage.getItem(_cacheKey(chainKey, a, b));
      if (!raw) return null;
      const rec = JSON.parse(raw);
      if (Date.now() - rec.ts > CACHE_TTL_MS) return null;
      return rec.fee;
    } catch { return null; }
  }
  function _saveFee(chainKey, a, b, fee) {
    try { localStorage.setItem(_cacheKey(chainKey, a, b), JSON.stringify({ ts: Date.now(), fee })); } catch {}
  }

  async function quoteCross(chainKey, tokenIn, tokenOut, amountIn) {
    const chain = ARC.CHAINS[chainKey];
    const quoterAddr = chain?.contracts?.uniV3QuoterV2;
    if (!quoterAddr) throw new Error(`Uniswap v3 not configured on ${chainKey}`);
    const inAddr = _poolAddr(chainKey, tokenIn);
    const outAddr = _poolAddr(chainKey, tokenOut);
    if (!inAddr || !outAddr) throw new Error('Missing token address for quote');
    if (inAddr.toLowerCase() === outAddr.toLowerCase()) {
      throw new Error('Same token on both sides');
    }
    const provider = ARC.rpcProvider(chainKey);
    const quoter = new Contract(quoterAddr, QUOTER_ABI, provider);

    // Try the cached fee first, then walk the rest of the tier list.
    const cachedFee = _loadFee(chainKey, inAddr, outAddr);
    const order = cachedFee != null
      ? [cachedFee, ...FEE_TIERS.filter(f => f !== cachedFee)]
      : FEE_TIERS.slice();

    let best = null;
    for (const fee of order) {
      try {
        const params = {
          tokenIn: getAddress(inAddr),
          tokenOut: getAddress(outAddr),
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        };
        const res = await quoter.quoteExactInputSingle.staticCall(params);
        const out = res[0] ?? res.amountOut;
        if (out && out > 0n && (!best || out > best.amountOut)) {
          best = { amountOut: out, fee, feeLabel: `Uniswap v3 · ${fee/10000}% pool` };
        }
      } catch {
        // pool doesn't exist at this fee tier — try the next one
      }
    }
    if (!best) throw new Error(`No Uniswap v3 pool for ${tokenIn.symbol}/${tokenOut.symbol} on ${chainKey}`);
    _saveFee(chainKey, inAddr, outAddr, best.fee);
    return best;
  }

  // ── Execute ────────────────────────────────────────────────────────────
  // Three shapes handled below (fromNative / toNative / erc20-to-erc20).
  // The router's own multicall + unwrapWETH9 combo covers wrapping without
  // a separate WETH.deposit / transfer tx from the user's perspective.
  async function executeCross(signer, chainKey, params, onStep) {
    onStep = onStep || (() => {});
    const chain = ARC.CHAINS[chainKey];
    const routerAddr = chain?.contracts?.uniV3SwapRouter02;
    const wethAddr = chain?.contracts?.weth9;
    if (!routerAddr || !wethAddr) throw new Error(`Uniswap v3 not configured on ${chainKey}`);

    const { tokenIn, tokenOut, amountIn, minOut, fee, recipient } = params;
    if (!fee) throw new Error('Missing pool fee — quote first');
    const userAddr = recipient || await signer.getAddress();

    const isFromNative = !!(tokenIn?.isGas) || tokenIn?.address === NATIVE_ADDR;
    const isToNative   = !!(tokenOut?.isGas) || tokenOut?.address === NATIVE_ADDR;
    const inAddr  = isFromNative ? wethAddr : tokenIn.address;
    const outAddr = isToNative   ? wethAddr : tokenOut.address;

    const router = new Contract(routerAddr, ROUTER_ABI, signer);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

    // Native input never needs an ERC-20 allowance — msg.value carries it.
    if (!isFromNative) {
      onStep('Approve token…');
      const erc = new Contract(tokenIn.address, ERC20_ABI, signer);
      const cur = await erc.allowance(userAddr, routerAddr).catch(() => 0n);
      if (cur < amountIn) {
        // MaxUint256 approval so subsequent swaps skip this step. Users can
        // revoke via a wallet's own allowance manager if they don't want it.
        const tx = await erc.approve(routerAddr, (1n << 256n) - 1n);
        onStep(`Approve tx ${tx.hash.slice(0,10)}… waiting`);
        await tx.wait();
      }
    }

    onStep('Sign swap…');
    let tx;
    if (isToNative) {
      // ERC-20 in → native out: swap into router-held WETH, then unwrap.
      const swapCall = router.interface.encodeFunctionData('exactInputSingle', [{
        tokenIn: getAddress(inAddr),
        tokenOut: getAddress(outAddr),
        fee,
        recipient: ADDRESS_THIS,
        amountIn,
        amountOutMinimum: 0n,  // check enforced by unwrap step below
        sqrtPriceLimitX96: 0n,
      }]);
      const unwrapCall = router.interface.encodeFunctionData('unwrapWETH9', [minOut, userAddr]);
      const value = isFromNative ? amountIn : 0n;
      tx = await router.multicall([swapCall, unwrapCall], { value, gasLimit: undefined });
    } else if (isFromNative) {
      // Native in → ERC-20 out: pass msg.value; router wraps internally.
      // Trailing refundETH sweeps any dust the router didn't spend.
      const swapCall = router.interface.encodeFunctionData('exactInputSingle', [{
        tokenIn: getAddress(inAddr),
        tokenOut: getAddress(outAddr),
        fee,
        recipient: userAddr,
        amountIn,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      }]);
      const refundCall = router.interface.encodeFunctionData('refundETH', []);
      tx = await router.multicall([swapCall, refundCall], { value: amountIn });
    } else {
      // Plain ERC-20 → ERC-20.
      tx = await router.exactInputSingle({
        tokenIn: getAddress(inAddr),
        tokenOut: getAddress(outAddr),
        fee,
        recipient: userAddr,
        amountIn,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      });
    }
    onStep(`Tx ${tx.hash.slice(0,10)}… waiting`);
    const rc = await tx.wait();
    // Suppress unused-var warning without changing behavior; the caller
    // measures amountOut via balance-delta on the token/native side.
    void rc;
    return { hash: tx.hash };
  }

  ARC.uniCross = {
    NATIVE_ADDR,
    FEE_TIERS,
    quoteCross,
    executeCross,
  };
})(window);
