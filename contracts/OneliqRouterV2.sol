// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  OneliqRouter (v4 + v3 wrapper) — Arc Mainnet
 * @notice Successor to the v4-only OneliqRouter at 0xB1Ed79…78F0. Adds a
 *         dedicated `swapV3()` method that wraps SwapRouter02 (Uniswap v3)
 *         because Arc's Universal Router v3 handler is broken
 *         (SliceOutOfBounds on every V3_SWAP_EXACT_IN input shape). This
 *         lets Oneliq collect the 0.30% fee on v3 memes (TOLLY, MALA, …)
 *         the same way it does on v4 pairs (USDC/EURC/AKARII).
 *
 *         File is `OneliqRouterV2.sol` to keep git history clean, but the
 *         contract class name is `OneliqRouter` so Arcscan shows the same
 *         brand as the v1 deployment.
 *
 * Layout mirrors OneliqRouter:
 *   swap()   → Uniswap v4 via Universal Router (unchanged from v1)
 *   swapV3() → Uniswap v3 via SwapRouter02 (new)
 *
 * Security identical to v1: fee capped at 1%, executor targets FIXED at
 * deploy time, output measured by balance delta, reentrancy guard, pause
 * switch, two-step ownership, rescue can't touch accruedFees.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
}

contract OneliqRouter {
    // ── Immutable config ───────────────────────────────────────────────────
    address public immutable UNIVERSAL_ROUTER; // Uniswap v4 Universal Router
    address public immutable PERMIT2;          // Uniswap Permit2 (canonical)
    address public immutable SWAP_ROUTER;      // Uniswap v3 SwapRouter02 on Arc
    uint16  public constant  MAX_FEE_BPS = 100; // 1.00%

    // ── Mutable admin state ────────────────────────────────────────────────
    uint16  public feeBps;
    address public owner;
    address public pendingOwner;
    bool    public paused;

    // ── Fee ledger ─────────────────────────────────────────────────────────
    mapping(address => uint256) public accruedFees;

    // ── Reentrancy guard ───────────────────────────────────────────────────
    uint256 private _locked = 1;

    // ── Events ─────────────────────────────────────────────────────────────
    event Swap(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee,
        uint8   venue // 0 = v4, 1 = v3
    );
    event FeesWithdrawn(address indexed token, address indexed to, uint256 amount);
    event FeeBpsSet(uint16 oldBps, uint16 newBps);
    event OwnershipNominated(address indexed pendingOwner);
    event OwnershipAccepted(address indexed newOwner);
    event Paused();
    event Unpaused();
    event Rescued(address indexed token, address indexed to, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────────
    error OnlyOwner();
    error OnlyPending();
    error IsPaused();
    error Reentered();
    error FeeTooHigh();
    error DeadlinePassed();
    error InsufficientOutput();
    error TransferFailed();
    error ApproveFailed();
    error ZeroAddress();
    error ZeroAmount();
    error ExceedsAccrued();
    error SameToken();

    // ── Modifiers ──────────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }
    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }
    modifier nonReentrant() {
        if (_locked != 1) revert Reentered();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ── Constructor ────────────────────────────────────────────────────────
    /**
     * @param universalRouter Uniswap v4 Universal Router on Arc Mainnet
     *                        (0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1)
     * @param permit2         Canonical Permit2
     *                        (0x000000000022D473030F116dDEE9F6B43aC78BA3)
     * @param swapRouter02    Uniswap v3 SwapRouter02 on Arc Mainnet
     *                        (0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77)
     * @param initialFeeBps   0-100 (0.00% – 1.00%). 30 = 0.30%.
     * @param initialOwner    Deployer or their EOA
     */
    constructor(
        address universalRouter,
        address permit2,
        address swapRouter02,
        uint16  initialFeeBps,
        address initialOwner
    ) {
        if (universalRouter == address(0) || permit2 == address(0)
         || swapRouter02 == address(0) || initialOwner == address(0)) revert ZeroAddress();
        if (initialFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        UNIVERSAL_ROUTER = universalRouter;
        PERMIT2 = permit2;
        SWAP_ROUTER = swapRouter02;
        feeBps = initialFeeBps;
        owner = initialOwner;
    }

    // ── V4 swap (unchanged from v1) ────────────────────────────────────────
    function swap(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minOut,
        uint256 deadline,
        bytes calldata uniCommands,
        bytes[] calldata uniInputs
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        if (tokenIn == tokenOut) revert SameToken();
        if (amountIn == 0) revert ZeroAmount();

        _pull(tokenIn, msg.sender, amountIn);

        uint256 fee = (amountIn * feeBps) / 10_000;
        if (fee > 0) accruedFees[tokenIn] += fee;
        uint256 netIn = amountIn - fee;

        _ensureApproval(tokenIn, PERMIT2);
        IPermit2(PERMIT2).approve(tokenIn, UNIVERSAL_ROUTER, uint160(netIn), uint48(deadline));

        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));
        IUniversalRouter(UNIVERSAL_ROUTER).execute(uniCommands, uniInputs, deadline);
        uint256 balAfter = IERC20(tokenOut).balanceOf(address(this));
        amountOut = balAfter - balBefore;
        if (amountOut < minOut) revert InsufficientOutput();
        _push(tokenOut, msg.sender, amountOut);

        IPermit2(PERMIT2).approve(tokenIn, UNIVERSAL_ROUTER, 0, 0);
        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, amountOut, fee, 0);
    }

    // ── V3 swap (new) ──────────────────────────────────────────────────────
    /**
     * @notice Wrap a Uniswap v3 exactInputSingle with a fee take at source.
     *         Bypasses Universal Router because Arc's UR v3 module is
     *         broken (SliceOutOfBounds on every V3_SWAP_EXACT_IN input we
     *         tried, whereas SwapRouter02 executes v3 pools fine).
     *
     *         Pool used = pool.getPool(tokenIn, tokenOut, poolFee) inside
     *         SwapRouter02. Fee tier passed in from the frontend after
     *         DexScreener pool discovery.
     *
     * @param tokenIn            ERC-20 the user is spending
     * @param amountIn           Total user is sending (fee deducted BEFORE swap)
     * @param tokenOut           ERC-20 the user is receiving
     * @param minOut             Minimum tokenOut delta this router must forward
     * @param deadline           Unix timestamp after which the tx reverts
     * @param poolFee            Uniswap v3 fee tier (e.g. 500, 3000, 10000)
     * @param sqrtPriceLimitX96  Price limit for the swap (0 = no limit)
     * @return amountOut         Actual tokenOut forwarded to msg.sender
     */
    function swapV3(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minOut,
        uint256 deadline,
        uint24  poolFee,
        uint160 sqrtPriceLimitX96
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        if (tokenIn == tokenOut) revert SameToken();
        if (amountIn == 0) revert ZeroAmount();

        _pull(tokenIn, msg.sender, amountIn);

        uint256 fee = (amountIn * feeBps) / 10_000;
        if (fee > 0) accruedFees[tokenIn] += fee;
        uint256 netIn = amountIn - fee;

        _ensureApproval(tokenIn, SWAP_ROUTER);

        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));

        ISwapRouter02(SWAP_ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn:           tokenIn,
                tokenOut:          tokenOut,
                fee:               poolFee,
                recipient:         address(this),
                amountIn:          netIn,
                amountOutMinimum:  0, // enforced below via balance delta
                sqrtPriceLimitX96: sqrtPriceLimitX96
            })
        );

        uint256 balAfter = IERC20(tokenOut).balanceOf(address(this));
        amountOut = balAfter - balBefore;
        if (amountOut < minOut) revert InsufficientOutput();
        _push(tokenOut, msg.sender, amountOut);

        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, amountOut, fee, 1);
    }

    // ── Fee management ─────────────────────────────────────────────────────
    function withdrawFees(address token, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amt = accruedFees[token];
        if (amt == 0) return;
        accruedFees[token] = 0;
        _push(token, to, amt);
        emit FeesWithdrawn(token, to, amt);
    }

    function setFeeBps(uint16 newBps) external onlyOwner {
        if (newBps > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeBpsSet(feeBps, newBps);
        feeBps = newBps;
    }

    // ── Admin ──────────────────────────────────────────────────────────────
    function pause()   external onlyOwner { paused = true;  emit Paused(); }
    function unpause() external onlyOwner { paused = false; emit Unpaused(); }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipNominated(newOwner);
    }
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert OnlyPending();
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipAccepted(owner);
    }

    function rescue(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 accrued = accruedFees[token];
        if (bal < accrued || bal - accrued < amount) revert ExceedsAccrued();
        _push(token, to, amount);
        emit Rescued(token, to, amount);
    }

    // ── Low-level ERC-20 helpers ───────────────────────────────────────────
    function _pull(address token, address from, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
    function _push(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
    /**
     * Ensure `spender` (Permit2 for v4, SwapRouter02 for v3) holds an
     * effectively-infinite allowance for `token`. Reset to 0 first for
     * USDT-style tokens that require a reset before a new non-zero value.
     */
    function _ensureApproval(address token, address spender) private {
        uint256 cur = IERC20(token).allowance(address(this), spender);
        if (cur >= type(uint256).max / 2) return;
        (bool ok1,) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, 0));
        ok1;
        (bool ok2, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, type(uint256).max)
        );
        if (!ok2 || (data.length > 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }
}
