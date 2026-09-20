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
  // Universal Router V3_SWAP_EXACT_IN command byte.
  const CMD_V3_SWAP_EXACT_IN = 0x00;

  // Universal Router special constant addresses (see UniversalRouter.sol):
  //   MSG_SENDER   — funds/output go to the caller of execute() (= OneliqRouter)
  //   ADDRESS_THIS — funds/output go to the Universal Router itself
  const MSG_SENDER = '0x0000000000000000000000000000000000000001';

  // Verified via bytecode probe: 0xf0db…3918 is the Uniswap v3 Factory on
  // Arc mainnet (queried TOLLY pool.factory()). We don't call it directly
  // — we rely on DexScreener for pool addresses — but keep it here for
  // sanity-checking that a discovered pool really is a Uniswap v3 pool.
  const V3_FACTORY = '0xf0db7b58379503491d857db50ac9ece64c653918';
  const UNIVERSAL_ROUTER = '0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1';

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

  const ONELIQ_ROUTER_ABI = [
    'function swap(address tokenIn, uint256 amountIn, address tokenOut, uint256 minOut, uint256 deadline, bytes uniCommands, bytes[] uniInputs) returns (uint256 amountOut)',
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

  // ── Calldata builder ───────────────────────────────────────────────────
  /**
   * Build a Universal Router V3_SWAP_EXACT_IN command that ends with the
   * output landing on OneliqRouter (which then forwards to user with its
   * own minOut check).
   *
   * Path encoding is packed:
   *   tokenIn (20 bytes) + fee (uint24 = 3 bytes) + tokenOut (20 bytes)
   *
   * payerIsUser = true → callback pulls tokens from Universal Router's
   * msg.sender (= OneliqRouter) via Permit2. OneliqRouter has already
   * granted Permit2 → Universal Router allowance in its swap() flow, so
   * this works identically to the v4 path.
   */
  function buildV3SwapCalldata(tokenIn, tokenOut, fee, amountIn, amountOutMinimum) {
    const tokIn  = getAddress(tokenIn).slice(2).toLowerCase();
    const tokOut = getAddress(tokenOut).slice(2).toLowerCase();
    const feeHex = fee.toString(16).padStart(6, '0'); // uint24 → 3 bytes
    const path = '0x' + tokIn + feeHex + tokOut;

    const v3Input = abi.encode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool'],
      [MSG_SENDER, BigInt(amountIn), BigInt(amountOutMinimum), path, true],
    );

    const commands = '0x' + CMD_V3_SWAP_EXACT_IN.toString(16).padStart(2, '0');
    return { commands, inputs: [v3Input] };
  }

  // ── End-to-end swap through OneliqRouter ───────────────────────────────
  async function executeV3Swap(signer, opts, onStep) {
    const { tokenIn, tokenOut, amountIn, slippageBps = 50 } = opts;
    if (!signer) throw new Error('No signer connected');

    const routerAddr = ARC.CHAINS.arc?.contracts?.router;
    if (!routerAddr) throw new Error('OneliqRouter not deployed on this network');

    onStep?.('Finding v3 pool...');
    const poolInfo = await discoverV3Pool(tokenIn, tokenOut);
    if (!poolInfo) throw new Error(`No Uniswap v3 pool for this pair on Arc`);

    onStep?.('Quoting…');
    const q = await quoteV3(poolInfo, amountIn, tokenIn);
    if (!q || q.amountOut === 0n) throw new Error(`Pool has no depth for that amount`);
    const minOut = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;

    onStep?.('Checking allowance...');
    const erc20 = new Contract(tokenIn, ERC20_MIN_ABI, signer);
    const owner = await signer.getAddress();
    const cur = await erc20.allowance(owner, routerAddr);
    if (cur < BigInt(amountIn)) {
      onStep?.('Approving OneliqRouter...');
      const atx = await erc20.approve(routerAddr, (1n << 256n) - 1n);
      await atx.wait();
    }

    onStep?.('Building v3 calldata...');
    const { commands, inputs } = buildV3SwapCalldata(tokenIn, tokenOut, poolInfo.fee, amountIn, minOut);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    console.groupCollapsed('[arc-univ3] swap calldata');
    console.log('router:',   routerAddr);
    console.log('pool:',     poolInfo.pool, 'fee:', poolInfo.fee);
    console.log('tokenIn:',  tokenIn, ' tokenOut:', tokenOut);
    console.log('amountIn:', amountIn.toString(), ' minOut:', minOut.toString(), ' quotedOut:', q.amountOut.toString());
    console.log('commands:', commands);
    console.log('inputs[0]:', inputs[0]);
    console.groupEnd();

    // Simulate before touching the wallet.
    onStep?.('Simulating…');
    const arcProvider = ARC.rpcProvider('arc');
    const routerRead = new Contract(routerAddr, ONELIQ_ROUTER_ABI, arcProvider);
    try {
      await routerRead.swap.staticCall(
        tokenIn, BigInt(amountIn), tokenOut, minOut, deadline, commands, inputs,
        { from: owner },
      );
    } catch (e) {
      console.error('[arc-univ3] simulation reverted', e);
      const short = e?.shortMessage || e?.reason || e?.message || 'unknown';
      throw new Error(`v3 swap simulation failed — ${short}. Try a larger slippage or smaller size.`);
    }

    onStep?.('Submitting swap...');
    const router = new Contract(routerAddr, ONELIQ_ROUTER_ABI, signer);
    const tx = await router.swap(tokenIn, BigInt(amountIn), tokenOut, minOut, deadline, commands, inputs);
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
    UNIVERSAL_ROUTER,
    CMD_V3_SWAP_EXACT_IN,
    discoverV3Pool,
    quoteV3,
    buildV3SwapCalldata,
    executeV3Swap,
  };
})(window);
