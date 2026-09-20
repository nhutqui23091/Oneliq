/* Oneliq — Uniswap v3 helper (Arc Mainnet)
 * Many memes on Arc (TOLLY, MALA, …) live in v3 pools, not v4. This module
 * discovers the pool via DexScreener (which knows every pair address on
 * Arc), quotes it from pool.slot0 + fee, and builds V3_SWAP_EXACT_IN
 * calldata for OneliqRouter → Universal Router. The same OneliqRouter
 * contract that handles v4 also handles v3 — the router just forwards
 * whatever (commands, inputs) tuple we build to Universal Router.execute().
 *
 * Requires: arc-core-v2.js (window.ARC) + ethers v6 loaded first.
 */
(function (global) {
  'use strict';
  if (!global.ARC) { console.error('[arc-univ3] ARC core not loaded'); return; }
  const ARC = global.ARC;
  const { AbiCoder, getAddress, Contract } = global.ethers;
  const abi = AbiCoder.defaultAbiCoder();

  // ── Constants ──────────────────────────────────────────────────────────
  // Verified via bytecode probe (queried TOLLY pool.factory + top pool.swap
  // callers over recent Swap events):
  //   V3_FACTORY   = 0xf0db…3918  — Uniswap v3 Factory on Arc mainnet
  //   SWAP_ROUTER  = 0x53bf…6f77  — SwapRouter02 (has exactInputSingle,
  //                                exactInput, factory, WETH9, multicall).
  //
  // We call SwapRouter02 directly instead of Universal Router because
  // Arc's Universal Router (0x4fcA…9Fb1) rejects V3 command inputs with
  // SliceOutOfBounds() — its v3 handler appears to be either miscompiled
  // or intentionally disabled by the Circle build. Verified: V4_SWAP and
  // SWEEP dispatch fine, V3_SWAP_EXACT_IN reverts on every input shape
  // we tried, including the exact abi-encoded shape the Uniswap SDK emits.
  // SwapRouter02 is the standard alternative and its dispatch works.
  const V3_FACTORY = '0xf0db7b58379503491d857db50ac9ece64c653918';
  const SWAP_ROUTER = '0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77';

  // Uniswap v3 pool minimum ABI — only the fields we read to quote.
  const V3_POOL_ABI = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
    'function fee() view returns (uint24)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function factory() view returns (address)',
    'function liquidity() view returns (uint128)',
  ];

  const ERC20_MIN_ABI = [
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
  ];

  const SWAP_ROUTER_ABI = [
    'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  ];

  const ONELIQ_ROUTER_V2_ABI = [
    'function swapV3(address tokenIn, uint256 amountIn, address tokenOut, uint256 minOut, uint256 deadline, uint24 poolFee, uint160 sqrtPriceLimitX96) returns (uint256 amountOut)',
  ];

  // ── Pool discovery via DexScreener ─────────────────────────────────────
  // DexScreener knows every Uniswap v3 pool on Arc and returns its
  // pairAddress + labels. We pick the pair with the highest USD liquidity.
  // Cached in localStorage for 10 min so repeated quotes are instant.
  const DXS_TTL_MS = 10 * 60 * 1000;
  function _lsKey(a, b) { return `arc-univ3:pool:${[a.toLowerCase(), b.toLowerCase()].sort().join('_')}`; }
  function _loadLs(a, b) {
    try {
      const raw = localStorage.getItem(_lsKey(a, b));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj.ts !== 'number' || Date.now() - obj.ts > DXS_TTL_MS) return null;
      return obj.pool;
    } catch { return null; }
  }
  function _saveLs(a, b, pool) {
    try { localStorage.setItem(_lsKey(a, b), JSON.stringify({ ts: Date.now(), pool })); }
    catch {}
  }

  async function discoverV3Pool(tokenA, tokenB) {
    const cached = _loadLs(tokenA, tokenB);
    if (cached) return cached;
    let dxJson;
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenA},${tokenB}`);
      if (!r.ok) return null;
      dxJson = await r.json();
    } catch { return null; }
    const A = tokenA.toLowerCase(), B = tokenB.toLowerCase();
    const pairs = (dxJson?.pairs || []).filter(p =>
      p.chainId === 'arc'
      && (p.labels || []).includes('v3')
      && ((p.baseToken?.address?.toLowerCase() === A && p.quoteToken?.address?.toLowerCase() === B)
       || (p.baseToken?.address?.toLowerCase() === B && p.quoteToken?.address?.toLowerCase() === A)));
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const top = pairs[0];
    // Verify + enrich on-chain: DexScreener metadata is trusted for
    // discovery but we still read fee + token0 + token1 direct from the
    // pool contract before quoting (the pool may return either token as
    // token0 depending on address ordering).
    const provider = ARC.rpcProvider('arc');
    const pool = new Contract(top.pairAddress, V3_POOL_ABI, provider);
    let fee, token0, token1, factory;
    try {
      [fee, token0, token1, factory] = await Promise.all([
        pool.fee(), pool.token0(), pool.token1(), pool.factory(),
      ]);
    } catch (e) {
      console.warn('[arc-univ3] pool metadata read failed:', e?.message);
      return null;
    }
    if (getAddress(factory).toLowerCase() !== V3_FACTORY.toLowerCase()) {
      console.warn('[arc-univ3] discovered pool has unexpected factory:', factory);
      return null;
    }
    const info = {
      pool: getAddress(top.pairAddress),
      fee: Number(fee),
      token0: getAddress(token0),
      token1: getAddress(token1),
      liquidityUsd: top.liquidity?.usd || 0,
      priceUsd: top.priceUsd ? Number(top.priceUsd) : null,
      dxsUrl: top.url,
    };
    _saveLs(tokenA, tokenB, info);
    return info;
  }

  // ── Quote (spot-price approximation) ───────────────────────────────────
  // Uniswap v3 uses concentrated liquidity — a proper Quoter would walk
  // the tick bitmap to account for price impact across a large swap. That
  // needs a live QuoterV2 deployment, which we don't have confirmed on
  // Arc. Instead we compute the ideal spot price from slot0 and apply the
  // pool fee. For small trades this is very accurate; for very large
  // trades the shown rate can be optimistic and user's slippage kicks in
  // at execution.
  async function quoteV3(poolInfo, amountIn, tokenIn) {
    if (!poolInfo || !amountIn) return null;
    const provider = ARC.rpcProvider('arc');
    const pool = new Contract(poolInfo.pool, V3_POOL_ABI, provider);
    let slot0;
    try { slot0 = await pool.slot0(); }
    catch (e) { console.warn('[arc-univ3] slot0 read failed:', e?.message); return null; }
    const sqrt = BigInt(slot0[0]);
    if (sqrt === 0n) return null; // pool never initialized
    const tokenIsToken0 = getAddress(tokenIn).toLowerCase() === poolInfo.token0.toLowerCase();
    // price = (sqrt / 2^96)^2 = token1_per_token0 (raw units, no decimal adj).
    // amountOut_raw = amountIn_raw × price if selling token0 (zeroForOne),
    //               = amountIn_raw / price if selling token1.
    // Then apply fee (LP takes fee off input): effective_in = in × (1 - fee/1e6).
    const Q192 = 1n << 192n;
    const feeBps = BigInt(poolInfo.fee); // in 1/1_000_000
    const amtAfterFee = (BigInt(amountIn) * (1_000_000n - feeBps)) / 1_000_000n;
    let amountOut;
    if (tokenIsToken0) {
      // out (token1) = in × sqrt^2 / 2^192
      amountOut = (amtAfterFee * sqrt * sqrt) / Q192;
    } else {
      // out (token0) = in × 2^192 / sqrt^2
      amountOut = (amtAfterFee * Q192) / (sqrt * sqrt);
    }
    return {
      amountOut,
      zeroForOne: tokenIsToken0,
      poolInfo,
      spot_sqrt: sqrt.toString(),
    };
  }

  // ── End-to-end swap through OneliqRouter.swapV3 ────────────────────────
  // OneliqRouter (mainnet address in ARC.CHAINS.arc.contracts.router) has
  // a swapV3 method that wraps SwapRouter02 internally and takes the 0.30%
  // Oneliq fee. If the router in the config is the OLD v4-only deployment
  // (no swapV3 method), we fall back to calling SwapRouter02 directly —
  // safe for the transition window while users pick up the new bundle.
  async function executeV3Swap(signer, opts, onStep) {
    const { tokenIn, tokenOut, amountIn, slippageBps = 50 } = opts;
    if (!signer) throw new Error('No signer connected');

    onStep?.('Finding v3 pool...');
    const poolInfo = await discoverV3Pool(tokenIn, tokenOut);
    if (!poolInfo) throw new Error(`No Uniswap v3 pool for this pair on Arc`);

    onStep?.('Quoting…');
    const q = await quoteV3(poolInfo, amountIn, tokenIn);
    if (!q || q.amountOut === 0n) throw new Error(`Pool has no depth for that amount`);
    const minOut = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    const owner = await signer.getAddress();
    const routerAddr = ARC.CHAINS.arc?.contracts?.router;
    if (!routerAddr) throw new Error('OneliqRouter not deployed on this network');

    // Approval target = OneliqRouter (not SwapRouter02) — router pulls
    // tokenIn via ERC-20 transferFrom, takes the fee, then internally
    // approves SwapRouter02 for the net amount.
    onStep?.('Checking allowance...');
    const erc20 = new Contract(tokenIn, ERC20_MIN_ABI, signer);
    const cur = await erc20.allowance(owner, routerAddr);
    if (cur < BigInt(amountIn)) {
      onStep?.('Approving OneliqRouter...');
      const atx = await erc20.approve(routerAddr, (1n << 256n) - 1n);
      await atx.wait();
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    console.groupCollapsed('[arc-univ3] swap params');
    console.log('OneliqRouter:', routerAddr);
    console.log('pool:',     poolInfo.pool, 'fee:', poolInfo.fee);
    console.log('tokenIn:',  tokenIn, ' tokenOut:', tokenOut);
    console.log('amountIn:', amountIn.toString(), ' minOut:', minOut.toString(), ' quotedOut:', q.amountOut.toString());
    console.groupEnd();

    // Simulate through OneliqRouter first; on failure, fall back to
    // SwapRouter02 direct (handles the case where the config still points
    // at the old v4-only OneliqRouter without swapV3).
    onStep?.('Simulating…');
    const arcProvider = ARC.rpcProvider('arc');
    const routerRead = new Contract(routerAddr, ONELIQ_ROUTER_V2_ABI, arcProvider);
    let useLegacyDirect = false;
    try {
      await routerRead.swapV3.staticCall(
        tokenIn, BigInt(amountIn), tokenOut, minOut, deadline, poolInfo.fee, 0n,
        { from: owner },
      );
    } catch (e) {
      // OneliqRouter v1 lacks swapV3 → will revert with no data. Fall back
      // to direct SwapRouter02 so v3 swaps still work while the bundle
      // rolls out to every user.
      const noSwapV3 = /function selector was not recognized|missing revert data|no matching function|not a function/i
        .test(e?.shortMessage || e?.message || '');
      if (noSwapV3) {
        console.warn('[arc-univ3] router lacks swapV3, falling back to SwapRouter02 direct');
        useLegacyDirect = true;
      } else {
        console.error('[arc-univ3] simulation reverted', e);
        const rawMsg = e?.reason || e?.shortMessage || e?.message || '';
        let short = rawMsg;
        if (/STF/.test(rawMsg)) short = 'Token transfer failed (allowance/balance?)';
        else if (/Too little received|InsufficientOutput/.test(rawMsg)) short = 'Price moved beyond max slippage';
        throw new Error(`v3 swap simulation failed — ${short}`);
      }
    }

    onStep?.('Submitting swap...');
    if (useLegacyDirect) {
      // Direct SwapRouter02 fallback (old v4-only router path).
      // Need SwapRouter02 approval instead of OneliqRouter approval.
      const cur2 = await erc20.allowance(owner, SWAP_ROUTER);
      if (cur2 < BigInt(amountIn)) {
        onStep?.('Approving SwapRouter02 (fallback)…');
        const atx = await erc20.approve(SWAP_ROUTER, (1n << 256n) - 1n);
        await atx.wait();
      }
      const sr = new Contract(SWAP_ROUTER, SWAP_ROUTER_ABI, signer);
      const params = {
        tokenIn: getAddress(tokenIn), tokenOut: getAddress(tokenOut),
        fee: poolInfo.fee, recipient: owner,
        amountIn: BigInt(amountIn), amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      };
      const tx = await sr.exactInputSingle(params);
      onStep?.(`Confirming ${tx.hash.slice(0, 12)}…`);
      const receipt = await tx.wait();
      return { hash: tx.hash, receipt, quotedOut: q.amountOut, minOut, poolInfo };
    }
    const router = new Contract(routerAddr, ONELIQ_ROUTER_V2_ABI, signer);
    const tx = await router.swapV3(
      tokenIn, BigInt(amountIn), tokenOut, minOut, deadline, poolInfo.fee, 0n,
    );
    onStep?.(`Confirming ${tx.hash.slice(0, 12)}…`);
    const receipt = await tx.wait();
    return {
      hash: tx.hash,
      receipt,
      quotedOut: q.amountOut,
      minOut,
      poolInfo,
    };
  }

  // ── Exports ────────────────────────────────────────────────────────────
  ARC.uniV3 = {
    V3_FACTORY,
    SWAP_ROUTER,
    discoverV3Pool,
    quoteV3,
    executeV3Swap,
  };
})(window);
