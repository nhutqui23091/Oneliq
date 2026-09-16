// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  OneliqRouter (Uniswap v4 wrapper) — Arc Mainnet
 * @notice Thin fee-charging wrapper around Uniswap v4 Universal Router. User
 *         calls swap(); router pulls tokenIn, deducts feeBps (default 30 =
 *         0.30%), forwards the remainder through Universal Router, measures
 *         the tokenOut delta and forwards to user with a minOut guard.
 *
 * Security posture — deliberate choices:
 *   • Executor is FIXED at deploy time (UNIVERSAL_ROUTER immutable). Router
 *     cannot be tricked into calling arbitrary contracts.
 *   • Swap output is measured by balance delta, not trusted from the
 *     Universal Router return. If the Uniswap contract ever mis-reports,
 *     the fee accrual stays honest.
 *   • Fee cap enforced at 1% (MAX_FEE_BPS = 100). setFeeBps cannot exceed.
 *   • Two-step ownership handover (nominate → accept) so one typo can't
 *     lock the fee pot.
 *   • Reentrancy guard on swap and rescue.
 *   • Pause switch cuts new swaps without redeploy.
 *   • rescue() cannot dip into accruedFees ledger.
 *   • Tolerates non-standard ERC-20 return shapes (USDT-style silent tokens).
 *
 * Deliberately NOT included:
 *   • Recipient parameter (msg.sender always receives). Prevents proxying
 *     someone else's swap through a wrapper for phishing UX.
 *   • Upgrade mechanism. New logic ships as a new deployment.
 *   • Direct call surface to arbitrary tokens (no rescueEther, no delegatecall).
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
    function allowance(address owner, address token, address spender) external view returns (uint160, uint48, uint48);
}

contract OneliqRouter {
    // ── Immutable config ───────────────────────────────────────────────────
    address public immutable UNIVERSAL_ROUTER; // Uniswap v4 Universal Router
    address public immutable PERMIT2;          // Uniswap Permit2 (canonical)
    uint16  public constant  MAX_FEE_BPS = 100; // 1.00%

    // ── Mutable admin state ────────────────────────────────────────────────
    uint16  public feeBps;             // current fee in basis points
    address public owner;              // fee pot admin
    address public pendingOwner;       // two-step handover
    bool    public paused;             // pause new swaps

    // ── Fee ledger ─────────────────────────────────────────────────────────
    mapping(address => uint256) public accruedFees; // token → owed to owner

    // ── Reentrancy guard ───────────────────────────────────────────────────
    uint256 private _locked = 1;

    // ── Events ─────────────────────────────────────────────────────────────
    event Swap(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
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
     * @param initialFeeBps   0-100 (0.00% – 1.00%). 30 = 0.30%.
     * @param initialOwner    Deployer or their EOA (upgrade to a multisig
     *                        via transferOwnership + acceptOwnership when
     *                        one is ready).
     */
    constructor(
        address universalRouter,
        address permit2,
        uint16 initialFeeBps,
        address initialOwner
    ) {
        if (universalRouter == address(0) || permit2 == address(0) || initialOwner == address(0)) revert ZeroAddress();
        if (initialFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        UNIVERSAL_ROUTER = universalRouter;
        PERMIT2 = permit2;
        feeBps = initialFeeBps;
        owner = initialOwner;
    }

    // ── Core: swap ────────────────────────────────────────────────────────
    /**
     * @notice Wrap a Uniswap v4 swap with a fee take at source.
     *
     * The Uniswap Universal Router calldata (commands + inputs) is built
     * OFF-CHAIN by the frontend using the @uniswap/universal-router-sdk.
     * It MUST include a final TAKE_ALL / SWEEP action sending the output
     * token to `address(this)` — the router forwards it to msg.sender only
     * after measuring the balance delta and checking minOut.
     *
     * @param tokenIn      ERC-20 the user is spending
     * @param amountIn     Total user is sending (fee is deducted BEFORE swap)
     * @param tokenOut     ERC-20 the user is receiving
     * @param minOut       Minimum tokenOut delta this router must forward
     * @param deadline     Unix timestamp after which the tx reverts
     * @param uniCommands  Universal Router `commands` bytes
     * @param uniInputs    Universal Router `inputs` array
     * @return amountOut   Actual tokenOut forwarded to msg.sender
     */
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

        // 1. Pull full amountIn from user (requires prior ERC20.approve
        //    from user to this router).
        _pull(tokenIn, msg.sender, amountIn);

        // 2. Deduct fee at source. Fee is denominated in tokenIn and never
        //    touches the output leg — same design as OneliqRouterV2.
        uint256 fee = (amountIn * feeBps) / 10_000;
        if (fee > 0) accruedFees[tokenIn] += fee;
        uint256 netIn = amountIn - fee;

        // 3. Ensure Permit2 has our MAX allowance for tokenIn (one-time per
        //    token). Then grant Universal Router a scoped Permit2 allowance
        //    for exactly netIn, expiring at `deadline`.
        _ensurePermit2Approval(tokenIn);
        IPermit2(PERMIT2).approve(tokenIn, UNIVERSAL_ROUTER, uint160(netIn), uint48(deadline));

        // 4. Snapshot output balance so we can measure the true delta.
        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));

        // 5. Forward the swap. Universal Router pulls netIn via Permit2 and
        //    executes the commands/inputs the frontend built. Output MUST
        //    be routed back to this contract (SWEEP → address(this)).
        IUniversalRouter(UNIVERSAL_ROUTER).execute(uniCommands, uniInputs, deadline);

        // 6. Measure delta, enforce minOut, forward the WHOLE delta to user.
        uint256 balAfter = IERC20(tokenOut).balanceOf(address(this));
        amountOut = balAfter - balBefore;
        if (amountOut < minOut) revert InsufficientOutput();
        _push(tokenOut, msg.sender, amountOut);

        // 7. Belt-and-braces: revoke Permit2 allowance to Universal Router.
        //    Not strictly required (allowance expired at `deadline`), but
        //    cheap and clarifies state for any observer.
        IPermit2(PERMIT2).approve(tokenIn, UNIVERSAL_ROUTER, 0, 0);

        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, amountOut, fee);
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
    function pause() external onlyOwner {
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

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

    /**
     * @notice Emergency: send tokens that accidentally landed on the router
     *         (e.g. a user transferred directly) to the owner. Cannot dip
     *         into the accruedFees ledger — that stays ring-fenced for
     *         withdrawFees.
     */
    function rescue(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 accrued = accruedFees[token];
        // bal >= accrued always (invariant); rescue can only take the excess.
        if (bal < accrued || bal - accrued < amount) revert ExceedsAccrued();
        _push(token, to, amount);
        emit Rescued(token, to, amount);
    }

    // ── Low-level ERC-20 helpers (tolerate non-standard return shapes) ─────
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
     * Ensure Permit2 holds an effectively-infinite allowance for the given
     * token. Set to 0 first for USDT-style tokens that require a reset
     * before setting a new non-zero value.
     */
    function _ensurePermit2Approval(address token) private {
        uint256 cur = IERC20(token).allowance(address(this), PERMIT2);
        if (cur >= type(uint256).max / 2) return; // already effectively max
        // Reset to 0 first (safe for both standard and USDT-style tokens)
        (bool ok1,) = token.call(abi.encodeWithSelector(IERC20.approve.selector, PERMIT2, 0));
        ok1; // ignore — some tokens (e.g. correctly-behaved ERC-20) don't strictly need reset
        (bool ok2, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.approve.selector, PERMIT2, type(uint256).max)
        );
        if (!ok2 || (data.length > 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }
}
