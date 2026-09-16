/* Oneliq — Uniswap v4 helper (Arc Mainnet)
 * Discovers pools, fetches quotes, builds Universal Router V4_SWAP calldata
 * so the frontend can push swaps through OneliqRouter → Universal Router →
 * PoolManager and take the 30-bps fee at source.
 *
 * Requires: arc-core-v2.js (window.ARC) + ethers v6 loaded first.
 */
(function (global) {
  'use strict';
  if (!global.ARC) { console.error('[arc-univ4] ARC core not loaded'); return; }
  const ARC = global.ARC;
  const { AbiCoder, keccak256, getAddress, Contract, ZeroAddress } = global.ethers;

  // ── Constants ──────────────────────────────────────────────────────────
  const V4 = {
    // Arc Mainnet (chain 5042) — verified live on-chain 2026-09-16
    poolManager:     '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    quoter:          '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
    universalRouter: '0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1',
    stateView:       '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
    permit2:         '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  };

  // Uniswap Universal Router command indices (from CommandsUtil):
  //   0x10 = V4_SWAP  — the only command we use.
  const CMD_V4_SWAP = 0x10;

  // Uniswap v4 Router Actions (from IV4Router / Actions.sol):
  const ACT = {
    SWAP_EXACT_IN_SINGLE: 0x06,
    SETTLE_ALL:           0x0c,
    TAKE_ALL:             0x0f,
  };

  // Initialize event signature: Initialize(bytes32 id, address currency0,
  // address currency1, uint24 fee, int24 tickSpacing, address hooks,
  // uint160 sqrtPriceX96, int24 tick).
  const INIT_EVENT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';

  const abi = AbiCoder.defaultAbiCoder();

  // ── ABIs ───────────────────────────────────────────────────────────────
  const QUOTER_ABI = [
    // struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    // struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }
    'function quoteExactInputSingle((tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
  ];

  const ERC20_MIN_ABI = [
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
  ];

  const ONELIQ_ROUTER_ABI = [
    'function swap(address tokenIn, uint256 amountIn, address tokenOut, uint256 minOut, uint256 deadline, bytes uniCommands, bytes[] uniInputs) returns (uint256 amountOut)',
    'function feeBps() view returns (uint16)',
    'function paused() view returns (bool)',
  ];

  // ── Utilities ──────────────────────────────────────────────────────────
  function sortTokens(a, b) {
    const A = getAddress(a).toLowerCase();
    const B = getAddress(b).toLowerCase();
    return A < B ? [getAddress(a), getAddress(b)] : [getAddress(b), getAddress(a)];
  }

  function zeroForOne(tokenIn, currency0) {
    return getAddress(tokenIn).toLowerCase() === getAddress(currency0).toLowerCase();
  }

  function padAddress(a) {
    return '0x' + '0'.repeat(24) + getAddress(a).slice(2).toLowerCase();
  }

  // ── Pool discovery ─────────────────────────────────────────────────────
  // Scans PoolManager Initialize events for (tokenA, tokenB) pairs. Returns
  // an array of pool keys ordered by liquidity heuristic (currently just
  // insertion order). Caches by (a, b) so a repeat lookup is instant.
  const _poolCache = new Map(); // key: `${a.toLowerCase()}_${b.toLowerCase()}` → array<poolKey>

  async function discoverPools(tokenA, tokenB, opts = {}) {
    const [currency0, currency1] = sortTokens(tokenA, tokenB);
    const cacheKey = `${currency0.toLowerCase()}_${currency1.toLowerCase()}`;
    if (!opts.force && _poolCache.has(cacheKey)) return _poolCache.get(cacheKey);

    const provider = ARC.rpcProvider('arc');
    const latest = Number(await provider.getBlockNumber());
    // Scan last N blocks; Arc mainnet has ~200k blocks/day so 1M blocks = ~5 days.
    // eth_getLogs is capped at 10k blocks/call on the primary Circle RPC, so
    // fan out across chunks.
    const spanBlocks = opts.spanBlocks || 200_000;
    const chunkSize  = 10_000;
    const startBlock = Math.max(0, latest - spanBlocks);

    const c0Padded = padAddress(currency0);
    const c1Padded = padAddress(currency1);

    const pools = [];
    for (let from = latest; from > startBlock; from -= chunkSize) {
      const to = from;
      const fr = Math.max(startBlock, from - chunkSize + 1);
      const filter = {
        address: V4.poolManager,
        topics: [INIT_EVENT_TOPIC, null, c0Padded, c1Padded],
        fromBlock: '0x' + fr.toString(16),
        toBlock:   '0x' + to.toString(16),
      };
      let logs;
      try { logs = await provider.getLogs(filter); }
      catch (e) { console.warn('[arc-univ4] getLogs chunk failed:', e?.message); continue; }
      for (const log of logs) {
        try {
          const decoded = decodeInitLog(log);
          if (decoded) pools.push(decoded);
        } catch (e) {
          console.warn('[arc-univ4] decode init log failed:', e?.message);
        }
      }
      // Enough data — most pools are recent. Stop early if we found some.
      if (pools.length >= 5) break;
    }

    _poolCache.set(cacheKey, pools);
    return pools;
  }

  function decodeInitLog(log) {
    // topics[0] = event sig
    // topics[1] = poolId (bytes32)
    // topics[2] = currency0 (address padded)
    // topics[3] = currency1 (address padded)
    // data = abi.encode(fee, tickSpacing, hooks, sqrtPriceX96, tick)
    if (!log.topics || log.topics.length < 4) return null;
    const poolId = log.topics[1];
    const currency0 = getAddress('0x' + log.topics[2].slice(-40));
    const currency1 = getAddress('0x' + log.topics[3].slice(-40));
    // Decode data (5 words = 5 * 32 bytes = 320 chars after 0x)
    const [fee, tickSpacing, hooks, sqrtPriceX96, tick] = abi.decode(
      ['uint24', 'int24', 'address', 'uint160', 'int24'],
      log.data
    );
    return {
      poolId,
      poolKey: {
        currency0,
        currency1,
        fee: Number(fee),
        tickSpacing: Number(tickSpacing),
        hooks: getAddress(hooks),
      },
      sqrtPriceX96: sqrtPriceX96.toString(),
      tick: Number(tick),
      blockNumber: parseInt(log.blockNumber, 16),
      txHash: log.transactionHash,
    };
  }

  // ── Quote ──────────────────────────────────────────────────────────────
  // Call the v4 Quoter via eth_call (simulation) — safe, no gas, works with
  // hook-controlled dynamic-fee pools. Returns { amountOut, gasEstimate }.
  async function quoteExactInputSingle(poolKey, amountIn, zeroForOne, hookData = '0x') {
    const provider = ARC.rpcProvider('arc');
    const quoter = new Contract(V4.quoter, QUOTER_ABI, provider);
    const params = {
      poolKey: {
        currency0:   poolKey.currency0,
        currency1:   poolKey.currency1,
        fee:         poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks:       poolKey.hooks,
      },
      zeroForOne,
      exactAmount: amountIn,
      hookData,
    };
    // Quoter methods are "state-modifying" (non-view) but designed to be
    // called with eth_call so they revert-and-return the quote.
    const [amountOut, gasEstimate] = await quoter.quoteExactInputSingle.staticCall(params);
    return { amountOut: BigInt(amountOut), gasEstimate: BigInt(gasEstimate) };
  }

  // Uniswap v4 LPFeeLibrary constants
  const MAX_LP_FEE     = 1_000_000; // 100.0000%
  const DYNAMIC_FEE    = 0x800000;  // = 8388608, hook-controlled
  // Safe static-fee tiers we trust for direct trading: <=3% (30000).
  // Anything higher on a stable pair is almost certainly a scam or
  // misconfigured pool. Dynamic-fee (hook) pools are OK — the hook
  // sets the effective fee at swap time.
  function isTrustedFee(fee) {
    return fee === 0 || fee === DYNAMIC_FEE || fee <= 30000;
  }

  // Convenience: given tokenIn/tokenOut, find the best pool and quote.
  // Filters out pools with untrusted fees (see isTrustedFee) so wildly
  // wrong quotes from custom-fee pools never surface to the UI.
  async function bestQuote(tokenIn, tokenOut, amountIn) {
    const pools = await discoverPools(tokenIn, tokenOut);
    if (!pools.length) return null;
    const [currency0] = sortTokens(tokenIn, tokenOut);
    const zfo = zeroForOne(tokenIn, currency0);
    let best = null;
    for (const p of pools) {
      if (!isTrustedFee(p.poolKey.fee)) continue;
      try {
        const { amountOut, gasEstimate } = await quoteExactInputSingle(p.poolKey, amountIn, zfo);
        if (amountOut === 0n) continue;
        if (!best || amountOut > best.amountOut) {
          best = { ...p, amountOut, gasEstimate, zeroForOne: zfo };
        }
      } catch (e) {
        // Some pools revert (0 liquidity, hooks reject, etc.) — skip.
        continue;
      }
    }
    return best;
  }

  // ── Swap calldata builder ──────────────────────────────────────────────
  /**
   * Build the (commands, inputs) tuple to pass to OneliqRouter.swap(), which
   * forwards to Universal Router.execute(commands, inputs, deadline).
   *
   * Command layout: single V4_SWAP.
   * Actions layout inside the V4_SWAP payload:
   *   [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]
   *   params[0] = ExactInputSingleParams(poolKey, zeroForOne, amountIn, amountOutMin=0, hookData=0x)
   *              — amountOutMin set to 0 here; OneliqRouter enforces minOut
   *                via balance delta after the swap.
   *   params[1] = (tokenIn, amountIn)         // SETTLE_ALL — pay poolManager
   *   params[2] = (tokenOut, 0)               // TAKE_ALL — take everything out
   */
  function buildSwapCalldata(poolKey, tokenIn, tokenOut, amountIn, zeroForOne) {
    // Actions bytes: 3 uint8s packed
    const actions = '0x' + [ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE_ALL]
      .map(a => a.toString(16).padStart(2, '0')).join('');

    // params[0] — ExactInputSingleParams
    const p0 = abi.encode(
      ['tuple(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)'],
      [{
        poolKey: {
          currency0:   poolKey.currency0,
          currency1:   poolKey.currency1,
          fee:         poolKey.fee,
          tickSpacing: poolKey.tickSpacing,
          hooks:       poolKey.hooks,
        },
        zeroForOne,
        amountIn:       BigInt(amountIn),
        amountOutMinimum: 0n, // OneliqRouter checks delta itself
        hookData:      '0x',
      }]
    );

    // params[1] — SETTLE_ALL(currency, maxAmount)
    const p1 = abi.encode(['address', 'uint256'], [tokenIn, BigInt(amountIn)]);

    // params[2] — TAKE_ALL(currency, minAmount) → recipient defaults to msg.sender
    // of the outer execute() call, which is OneliqRouter (correct — router
    // then forwards to user with its own minOut check).
    const p2 = abi.encode(['address', 'uint256'], [tokenOut, 0n]);

    // V4_SWAP input = abi.encode(actions_bytes, params_bytes[])
    const v4SwapInput = abi.encode(['bytes', 'bytes[]'], [actions, [p0, p1, p2]]);

    // Universal Router expects `commands` as bytes and `inputs` as bytes[].
    const commands = '0x' + CMD_V4_SWAP.toString(16).padStart(2, '0');
    const inputs = [v4SwapInput];
    return { commands, inputs };
  }

  // ── Whole-flow orchestration ───────────────────────────────────────────
  /**
   * End-to-end swap through OneliqRouter on Arc Mainnet.
   *   1. Ensure user ERC-20 allowance to OneliqRouter for `amountIn`
   *   2. Build calldata + minOut from quote (with slippage)
   *   3. Call OneliqRouter.swap()
   * @param signer   ethers.Signer (from ARC.wallet.signer)
   * @param opts     { tokenIn, tokenOut, amountIn, slippageBps=50 }
   * @param onStep   optional (msg) => void progress callback
   * @returns tx receipt + amountOut
   */
  async function executeSwap(signer, opts, onStep) {
    const { tokenIn, tokenOut, amountIn, slippageBps = 50 } = opts;
    if (!signer) throw new Error('No signer connected');

    const routerAddr = ARC.CHAINS.arc?.contracts?.router;
    if (!routerAddr) throw new Error('OneliqRouter not deployed on this network');

    onStep?.('Discovering pool...');
    const best = await bestQuote(tokenIn, tokenOut, amountIn);
    if (!best) throw new Error(`No liquid Uniswap v4 pool for ${tokenIn} / ${tokenOut}`);
    const { amountOut: quotedOut, poolKey, zeroForOne: zfo } = best;

    const minOut = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;

    onStep?.('Checking allowance...');
    const erc20 = new Contract(tokenIn, ERC20_MIN_ABI, signer);
    const owner = await signer.getAddress();
    const cur = await erc20.allowance(owner, routerAddr);
    if (cur < BigInt(amountIn)) {
      onStep?.('Approving OneliqRouter...');
      const atx = await erc20.approve(routerAddr, (1n << 256n) - 1n);
      await atx.wait();
    }

    onStep?.('Building v4 calldata...');
    const { commands, inputs } = buildSwapCalldata(poolKey, tokenIn, tokenOut, amountIn, zfo);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600); // 10 min

    onStep?.('Submitting swap...');
    const router = new Contract(routerAddr, ONELIQ_ROUTER_ABI, signer);
    const tx = await router.swap(
      tokenIn,
      BigInt(amountIn),
      tokenOut,
      minOut,
      deadline,
      commands,
      inputs
    );
    onStep?.(`Confirming ${tx.hash.slice(0, 12)}…`);
    const receipt = await tx.wait();
    return {
      hash: tx.hash,
      receipt,
      quotedOut,
      minOut,
      poolKey,
    };
  }

  // ── Exports ────────────────────────────────────────────────────────────
  ARC.uniV4 = {
    V4,
    CMD_V4_SWAP,
    ACT,
    discoverPools,
    quoteExactInputSingle,
    bestQuote,
    buildSwapCalldata,
    executeSwap,
    sortTokens,
    zeroForOne,
  };
})(window);
