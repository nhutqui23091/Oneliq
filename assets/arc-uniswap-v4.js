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
    'function transfer(address,uint256) returns (bool)',
    'function transferFrom(address,address,uint256) returns (bool)',
  ];

  // Uniswap v4 StateView — read pool liquidity to filter out empty pools
  // before we try to swap through them.
  const STATE_VIEW_ABI = [
    'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
    'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
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
  // Two-pronged discovery so we're not at the mercy of log scans:
  //   (a) fastProbeNoHookPools — deterministic. Compute poolId for every
  //       common (fee, tickSpacing) combo with hooks = 0x0, then ask
  //       StateView.getSlot0(poolId). Live pools have sqrtPriceX96 > 0.
  //       This is O(1) in chain age and misses ONLY hook pools.
  //   (b) scanInitLogs — best-effort log scan for hook pools (with retry).
  //       Runs alongside (a); if the RPC rate-limits or the pool is older
  //       than the window, (a) still returns the standard-tier pools.
  //
  // Meme tokens on Arc frequently ship no-hook pools at 1-10% fees, so (a)
  // alone catches almost everything. (b) is only necessary for hook-mediated
  // pools like dynamic-fee launch pads.
  const _poolCache = new Map(); // key: `${a.toLowerCase()}_${b.toLowerCase()}` → array<poolKey>

  // Curated probe combos. Circle's Arc mainnet RPC caps at roughly 20
  // requests/window per session — a naive 10×9 (fee × tickSpacing) grid
  // gets 70/90 rate-limited AND misses the very pool we're looking for.
  // Instead: standard Uniswap v4 tiers + the meme-friendly tiers we've
  // actually seen on Arc. All 15 fit in one JSON-RPC batch.
  const PROBE_COMBOS = [
    // Standard tiers
    [   100,   1],
    [   500,  10],
    [  3000,  60],
    [ 10000, 200],
    // Meme / high-fee tiers (observed on Arc)
    [ 25000, 200],
    [ 25000, 500],
    [ 50000, 100],
    [ 50000, 500],
    [100000, 200],
    [100000, 500],
    [100000,1000],
    // Extra safety net
    [  3000, 200],
    [ 10000, 100],
    [ 10000, 500],
    [ 20000, 200],
  ];

  function computePoolId(currency0, currency1, fee, tickSpacing, hooks) {
    return keccak256(abi.encode(
      ['tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'],
      [{ currency0, currency1, fee, tickSpacing, hooks }],
    ));
  }

  // JSON-RPC batch helper. Sends all requests in one HTTP call, then retries
  // any rate-limited items (up to 2 more rounds with backoff). Falls back to
  // sequential fetches if the RPC rejects batches.
  const _getSlot0Selector = '0xc815641c'; // keccak256("getSlot0(bytes32)")[:4]
  async function _batchGetSlot0(rpcUrl, poolIds) {
    const body = poolIds.map((pid, i) => ({
      jsonrpc: '2.0', id: i, method: 'eth_call',
      params: [{ to: V4.stateView, data: _getSlot0Selector + pid.slice(2) }, 'latest'],
    }));
    const out = new Array(poolIds.length).fill(null);
    async function fire(items) {
      const r = await fetch(rpcUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(items),
      });
      if (!r.ok) throw new Error('rpc HTTP ' + r.status);
      const j = await r.json();
      return Array.isArray(j) ? j : [j];
    }
    let pending = body;
    for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
      let resps;
      try { resps = await fire(pending); }
      catch (e) { console.warn('[arc-univ4] batch failed:', e?.message); break; }
      const retry = [];
      for (const resp of resps) {
        const idx = resp.id;
        if (resp.error) {
          // Rate-limit → retry; other errors → give up on this slot
          if (/rate|limit|-32005|429/i.test(String(resp.error.message || resp.error.code || ''))) {
            retry.push(body[idx]);
          }
        } else if (resp.result && resp.result !== '0x') {
          // sqrtPriceX96 is the first word (32 bytes)
          const sqrt = BigInt('0x' + resp.result.slice(2, 66));
          out[idx] = sqrt > 0n ? sqrt : 0n;
        } else {
          out[idx] = 0n;
        }
      }
      if (!retry.length) break;
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      pending = retry;
    }
    return out;
  }

  async function fastProbeNoHookPools(currency0, currency1) {
    // Try to resolve the RPC URL for a raw fetch. Fall back to ethers if
    // we can't (some providers don't expose the URL cleanly).
    const provider = ARC.rpcProvider('arc');
    let rpcUrl = null;
    try {
      rpcUrl = (provider._getConnection && provider._getConnection().url)
            || provider?.connection?.url
            || ARC.CHAINS?.arc?.rpc
            || null;
    } catch { /* ignore */ }

    const hooks = ZeroAddress;
    const poolIds = PROBE_COMBOS.map(([fee, ts]) => computePoolId(currency0, currency1, fee, ts, hooks));

    let sqrtValues;
    if (rpcUrl) {
      sqrtValues = await _batchGetSlot0(rpcUrl, poolIds).catch(() => null);
    }
    // Fallback: sequential ethers calls with small concurrency (rare path).
    if (!sqrtValues) {
      const stateView = new Contract(V4.stateView, STATE_VIEW_ABI, provider);
      sqrtValues = new Array(poolIds.length).fill(0n);
      const CONC = 4;
      for (let i = 0; i < poolIds.length; i += CONC) {
        const batch = poolIds.slice(i, i + CONC);
        const rs = await Promise.allSettled(batch.map(pid => stateView.getSlot0(pid)));
        for (let j = 0; j < rs.length; j++) {
          if (rs[j].status === 'fulfilled') {
            const [sqrt] = rs[j].value;
            sqrtValues[i + j] = BigInt(sqrt);
          }
        }
      }
    }

    const found = [];
    for (let i = 0; i < PROBE_COMBOS.length; i++) {
      const [fee, ts] = PROBE_COMBOS[i];
      if (sqrtValues[i] && sqrtValues[i] > 0n) {
        found.push({
          poolId: poolIds[i],
          poolKey: {
            currency0, currency1,
            fee, tickSpacing: ts,
            hooks: getAddress(hooks),
          },
          sqrtPriceX96: sqrtValues[i].toString(),
          tick: null,
          blockNumber: null,
          txHash: null,
          _source: 'fastProbe',
        });
      }
    }
    return found;
  }

  async function _getLogsWithRetry(provider, filter, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try { return await provider.getLogs(filter); }
      catch (e) {
        lastErr = e;
        const msg = String(e?.message || '');
        // Only retry rate-limit / transient errors — not "range too large".
        if (!/rate|limit|429|timeout|network/i.test(msg)) throw e;
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
      }
    }
    throw lastErr;
  }

  async function scanInitLogs(currency0, currency1, opts) {
    const provider = ARC.rpcProvider('arc');
    const latest = Number(await provider.getBlockNumber());
    const spanBlocks = opts.spanBlocks || 500_000;
    const chunkSize  = 9_500; // stay just under the 10k cap on Arc RPC
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
      try { logs = await _getLogsWithRetry(provider, filter); }
      catch (e) { console.warn('[arc-univ4] getLogs chunk failed:', e?.message); continue; }
      for (const log of logs) {
        try {
          const decoded = decodeInitLog(log);
          if (decoded) { decoded._source = 'logScan'; pools.push(decoded); }
        } catch (e) {
          console.warn('[arc-univ4] decode init log failed:', e?.message);
        }
      }
    }
    return pools;
  }

  async function discoverPools(tokenA, tokenB, opts = {}) {
    const [currency0, currency1] = sortTokens(tokenA, tokenB);
    const cacheKey = `${currency0.toLowerCase()}_${currency1.toLowerCase()}`;
    if (!opts.force && _poolCache.has(cacheKey)) return _poolCache.get(cacheKey);

    // Fast probe first — ~90 parallel getSlot0 calls, returns in <1s. Covers
    // every no-hook pool at standard tiers.
    const fastOut = await fastProbeNoHookPools(currency0, currency1).catch(e => {
      console.warn('[arc-univ4] fast probe failed:', e?.message); return [];
    });
    // If fast probe found any pool, return immediately and enrich the cache
    // asynchronously with log-scan (for hook pools). The user's quote gets
    // to render in <1s instead of waiting the extra 5-10s for log scan.
    if (fastOut.length > 0) {
      _poolCache.set(cacheKey, fastOut);
      // Fire-and-forget log scan to augment cache for a possible second call.
      scanInitLogs(currency0, currency1, opts).then(logOut => {
        const byId = new Map();
        for (const p of [...fastOut, ...logOut]) {
          if (!byId.has(p.poolId)) byId.set(p.poolId, p);
        }
        _poolCache.set(cacheKey, [...byId.values()]);
      }).catch(() => { /* silent; fast-probe pools already served */ });
      return fastOut;
    }
    // No standard-tier no-hook pool — token likely uses a hook (bonding
    // curve, dynamic-fee launch pad, etc.). Wait for the log scan.
    const logOut = await scanInitLogs(currency0, currency1, opts).catch(e => {
      console.warn('[arc-univ4] log scan failed:', e?.message); return [];
    });
    _poolCache.set(cacheKey, logOut);
    return logOut;
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
  // Fee cap. Meme pools on Arc often use 1-10% (e.g. AKARII/USDC = fee 100000
  // = 10%), so a 3% cap silently drops them. Cap at 10% — anything higher on
  // a real trading pair is either misconfigured or a rug trap. Dynamic-fee
  // (hook) pools are OK — the hook sets the effective fee at swap time.
  function isTrustedFee(fee) {
    return fee === 0 || fee === DYNAMIC_FEE || fee <= 100000;
  }

  // Convenience: given tokenIn/tokenOut, find the best pool and quote.
  // Filters out pools with untrusted fees AND pools with zero on-chain
  // liquidity (initialized but no LPs). Also returns the full ranked
  // list of viable candidates so a caller can fall back to the next
  // pool if the top one reverts in real execution.
  async function bestQuote(tokenIn, tokenOut, amountIn) {
    const pools = await discoverPools(tokenIn, tokenOut);
    if (!pools.length) return null;
    const [currency0] = sortTokens(tokenIn, tokenOut);
    const zfo = zeroForOne(tokenIn, currency0);
    const provider = ARC.rpcProvider('arc');
    const stateView = new Contract(V4.stateView, STATE_VIEW_ABI, provider);

    const ZERO_HOOKS_LC = '0x0000000000000000000000000000000000000000';
    // Quote every trusted-fee pool in parallel. Sequential was adding
    // ~200ms per candidate — for 3 pools that's 600ms of pure round-trip.
    const trusted = pools.filter(p => isTrustedFee(p.poolKey.fee));
    const settled = await Promise.allSettled(trusted.map(async p => {
      let liquidity = 0n;
      let liquidityKnown = false;
      if (p.poolKey.hooks.toLowerCase() === ZERO_HOOKS_LC) {
        try {
          liquidity = BigInt(await stateView.getLiquidity(p.poolId));
          liquidityKnown = true;
        } catch { /* StateView doesn't know it; fall through to Quoter */ }
      }
      const { amountOut, gasEstimate } = await quoteExactInputSingle(p.poolKey, amountIn, zfo);
      if (amountOut === 0n) return null;
      return { ...p, amountOut, gasEstimate, zeroForOne: zfo, liquidity, liquidityKnown };
    }));
    const candidates = [];
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) candidates.push(r.value);
    }
    if (!candidates.length) return null;
    // Prefer NO-HOOK pools first (open to anyone), then by output size.
    // Hook-gated pools frequently reject external routers with revert(),
    // so trying a permissionless pool first avoids the confusing failure.
    const ZERO_HOOKS = '0x0000000000000000000000000000000000000000';
    candidates.sort((a, b) => {
      const aHook = a.poolKey.hooks.toLowerCase() !== ZERO_HOOKS ? 1 : 0;
      const bHook = b.poolKey.hooks.toLowerCase() !== ZERO_HOOKS ? 1 : 0;
      if (aHook !== bHook) return aHook - bHook; // no-hook first
      return b.amountOut > a.amountOut ? 1 : -1;
    });
    console.debug('[arc-univ4] pool candidates (' + candidates.length + '):',
      candidates.map(c => ({ fee: c.poolKey.fee, tickSpacing: c.poolKey.tickSpacing, hooks: c.poolKey.hooks, liq: c.liquidity.toString(), out: c.amountOut.toString() })));
    const best = candidates[0];
    best._candidates = candidates; // stash for fallback iteration
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

    // Log calldata so the user can inspect / share (helpful when "missing
    // revert data" happens because the RPC drops the revert bytes).
    console.groupCollapsed('[arc-univ4] swap calldata');
    console.log('router:',      routerAddr);
    console.log('tokenIn:',     tokenIn, '  tokenOut:', tokenOut);
    console.log('amountIn:',    amountIn.toString(), '  minOut:', minOut.toString());
    console.log('deadline:',    deadline.toString());
    console.log('poolKey:',     poolKey);
    console.log('zeroForOne:',  zfo);
    console.log('commands:',    commands);
    console.log('inputs[0]:',   inputs[0]);
    console.groupEnd();

    const router = new Contract(routerAddr, ONELIQ_ROUTER_ABI, signer);

    // Simulate first so any revert surfaces a decoded reason instead of a
    // bare "execution reverted" from the wallet popup. Use OUR provider
    // (not the signer's) so MetaMask RPCs that strip revert data don't
    // give a blank "missing revert data" error. eth_call with explicit
    // `from = owner` lets Permit2/allowance checks pass.
    onStep?.('Simulating…');
    let simErr = null;
    const arcProvider = ARC.rpcProvider('arc');
    const routerRead = new Contract(routerAddr, ONELIQ_ROUTER_ABI, arcProvider);
    try {
      await routerRead.swap.staticCall(
        tokenIn,
        BigInt(amountIn),
        tokenOut,
        minOut,
        deadline,
        commands,
        inputs,
        { from: owner }
      );
    } catch (e) { simErr = e; }

    if (simErr) {
      // Try to extract raw revert bytes from every place ethers/RPC might stash them.
      const raw = simErr?.data
                || simErr?.info?.error?.data
                || simErr?.error?.data
                || simErr?.info?.error?.body
                || '';
      const rawStr = typeof raw === 'string' ? raw : (raw?.data || raw?.originalError?.data || '');
      const shortSel = rawStr && rawStr.length >= 10 && rawStr.startsWith('0x') ? rawStr.slice(0, 10) : '';
      const KNOWN_ERRORS = {
        '0xd93c0665': 'OneliqRouter.IsPaused()',
        '0x2c5211c6': 'OneliqRouter.InsufficientOutput()',
        '0x7c9c6e8f': 'OneliqRouter.DeadlinePassed()',
        '0x8b063d73': 'V4Router.V4TooMuchRequested()',
        '0x39d35496': 'V4Router.V4TooLittle()',
        '0x815e1d64': 'Permit2.AllowanceExpired()',
        '0xf96fb071': 'Permit2.InsufficientAllowance()',
      };
      const decoded = KNOWN_ERRORS[shortSel]
        || (shortSel ? `revert selector ${shortSel}` : '')
        || (simErr?.shortMessage || simErr?.reason || simErr?.message || 'unknown');

      // Deep diagnostic:
      // (a) probe transferFrom on the tokenIn wrapper — proves whether the
      //     ERC-20 layer accepts moves at all (Arc's USDC has native/wrapper
      //     dual-facade weirdness that can cause silent revert).
      // (b) direct-call Universal Router with the same commands (as if the
      //     USER were the payer). If that also reverts with a real selector,
      //     the pool hook is the culprit, not OneliqRouter.
      onStep?.('Deep diagnostic…');
      let xferErr = null;
      try {
        const erc20Read = new Contract(tokenIn, ERC20_MIN_ABI, arcProvider);
        // Static call transferFrom(owner, routerAddr, amountIn) as if OneliqRouter did it
        await erc20Read.transferFrom.staticCall(owner, routerAddr, BigInt(amountIn), { from: routerAddr });
      } catch (e) { xferErr = e; }

      let directErr = null, directOk = false;
      try {
        const uniAbi = ['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'];
        const uni = new Contract(V4.universalRouter, uniAbi, arcProvider);
        await uni.execute.staticCall(commands, inputs, deadline, { from: owner });
        directOk = true;
      } catch (dErr) { directErr = dErr; }
      const directRaw = directErr?.data || directErr?.info?.error?.data || '';
      const directStr = typeof directRaw === 'string' ? directRaw : (directRaw?.data || '');
      const directSel = directStr && directStr.length >= 10 && directStr.startsWith('0x') ? directStr.slice(0, 10) : '';
      const directDecoded = KNOWN_ERRORS[directSel] || (directSel ? `direct selector ${directSel}` : (directErr?.shortMessage || 'unknown'));
      const xferOk = !xferErr;

      console.error('[arc-univ4] simulation revert', {
        oneliqRouterSelector: shortSel,
        oneliqRouterMsg: decoded,
        tokenTransferFromOk: xferOk,
        tokenTransferFromErr: xferErr?.shortMessage || xferErr?.message,
        directUniversalRouterSelector: directSel,
        directUniversalRouterMsg: directDecoded,
        directWouldSucceed: directOk,
        rawSimErr: simErr,
        rawXferErr: xferErr,
        rawDirectErr: directErr,
      });

      const hookHex = (poolKey.hooks || '0x0000000000000000000000000000000000000000').toLowerCase();
      const hasHook = hookHex !== '0x0000000000000000000000000000000000000000';
      const hint = !xferOk
        ? ` (ERC-20 transferFrom on ${tokenIn.slice(0,6)}… also reverts → wrapper doesn't accept normal transfers)`
        : directOk
        ? ' (Universal Router direct call would succeed → issue is OneliqRouter Permit2 flow)'
        : directSel
        ? ` (direct-call selector ${directSel} = ${directDecoded})`
        : hasHook
        ? ` — pool is hook-gated (${poolKey.hooks.slice(0,10)}…). This pool's hook contract rejects swaps from external routers. Try a different pool or token pair.`
        : ' (direct call also gave no revert data → likely low liquidity or a hook rejecting with revert())';
      const err = new Error(`Simulation reverted — ${decoded}${hint}`);
      err.cause = simErr;
      err.selector = shortSel;
      err.directSelector = directSel;
      err.poolKey = poolKey;
      throw err;
    }

    onStep?.('Submitting swap...');
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
