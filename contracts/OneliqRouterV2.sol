// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title OneliqRouterV2
 * @notice Fee-taking router for a two-coin Curve StableSwap pool (USDC <-> EURC).
 *
 * Same job as V1: forward the trade to the pool, keep a protocol fee on the
 * input, hand the output to the caller. The router never holds liquidity and
 * never takes market risk.
 *
 * What changed, and why — each of these is a finding from the V1 audit:
 *
 *  1. Ownership transfer is two-step. In V1 a mistyped address permanently
 *     locked the fee pot.
 *  2. Output is measured, not reported. V1 forwarded whatever number the pool
 *     returned; if that ever exceeded what actually arrived, the difference
 *     came out of accumulated fees. Here the balance delta is the only number
 *     trusted, so a lying or non-standard pool cannot reach the fee pot.
 *  3. Fees are accounted, not inferred. V1's withdrawFees() swept the whole
 *     token balance. Here `accruedFees` is an explicit ledger and a withdrawal
 *     can never exceed it, so no accounting bug can drain funds that are
 *     mid-flight or were sent here by mistake.
 *  4. Allowance to the pool is exact and revoked after use. V1 left an
 *     unlimited approval standing, so a compromised or upgradeable pool could
 *     have pulled the entire fee balance at any time.
 *  5. `swap` takes a deadline, so a transaction stuck in the mempool cannot
 *     execute later at a price the user never agreed to.
 *  6. The router checks `minOut` itself instead of relying on the pool.
 *  7. Reentrancy guard. V1 was safe only because its token set was hardcoded;
 *     this makes that safety explicit rather than incidental.
 *  8. Pausable, so a broken or drained pool can be cut off without waiting for
 *     a redeploy.
 *  9. Token transfers tolerate ERC-20s that return nothing (USDT-style).
 * 10. Pool and token addresses are immutable constructor arguments rather than
 *     hardcoded constants, so the same audited bytecode deploys to testnet and
 *     mainnet without an edit.
 *
 * Deliberately NOT added: a recipient parameter (output always goes to the
 * caller, as in V1), arbitrary token support, and any upgrade mechanism. Each
 * would widen the attack surface for convenience this router does not need.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

interface ICurveStableSwap {
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256);
}

contract OneliqRouterV2 {
    // ------------------------------ Config ------------------------------

    /// @notice Curve StableSwap pool this router forwards to.
    address public immutable POOL;
    /// @notice Pool coin index 0.
    address public immutable TOKEN0;
    /// @notice Pool coin index 1.
    address public immutable TOKEN1;

    /// @notice Hard ceiling on the protocol fee: 1.00%. Cannot be raised.
    uint16 public constant MAX_FEE_BPS = 100;

    // ------------------------------ State -------------------------------

    /// @notice Protocol fee in basis points, taken from the input token.
    uint16 public feeBps;

    /// @notice Current owner.
    address public owner;
    /// @notice Nominated owner, who must call acceptOwnership() to take over.
    address public pendingOwner;

    /// @notice When true, swaps revert. Views stay available.
    bool public paused;

    /// @notice Protocol fees earned per token and not yet withdrawn.
    /// @dev The only balance the owner may withdraw. Anything above this is
    ///      either mid-swap or was sent here by mistake; see rescue().
    mapping(address => uint256) public accruedFees;

    uint256 private _entered;   // 0 = idle, 1 = inside a swap

    // ------------------------------ Events ------------------------------

    event Swapped(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );
    event FeeUpdated(uint16 oldFeeBps, uint16 newFeeBps);
    event FeesWithdrawn(address indexed token, address indexed to, uint256 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ------------------------------ Errors ------------------------------

    error NotOwner();
    error NotPendingOwner();
    error InvalidPair();
    error ZeroAmount();
    error ZeroAddress();
    error FeeTooHigh();
    error DeadlinePassed();
    error InsufficientOutput(uint256 received, uint256 minOut);
    error Reentrancy();
    error IsPaused();
    error NotPaused();
    error AmountExceedsAccrued(uint256 requested, uint256 available);
    error NothingToWithdraw();
    error TransferFailed();
    error ApproveFailed();
    error DuplicateToken();

    // ----------------------------- Modifiers -----------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_entered != 0) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    // ---------------------------- Constructor ----------------------------

    /**
     * @param pool     Curve StableSwap pool (must hold token0 at index 0, token1 at index 1).
     * @param token0   Pool coin index 0 (USDC on Arc).
     * @param token1   Pool coin index 1 (EURC on Arc).
     * @param initialFeeBps Starting protocol fee, capped by MAX_FEE_BPS.
     * @param initialOwner  Owner. Pass a multisig — a single key controls every
     *                      admin function and the whole fee balance.
     */
    constructor(
        address pool,
        address token0,
        address token1,
        uint16 initialFeeBps,
        address initialOwner
    ) {
        if (pool == address(0) || token0 == address(0) || token1 == address(0)) revert ZeroAddress();
        if (initialOwner == address(0)) revert ZeroAddress();
        if (token0 == token1) revert DuplicateToken();
        if (initialFeeBps > MAX_FEE_BPS) revert FeeTooHigh();

        POOL = pool;
        TOKEN0 = token0;
        TOKEN1 = token1;
        feeBps = initialFeeBps;
        owner = initialOwner;

        emit OwnershipTransferred(address(0), initialOwner);
        emit FeeUpdated(0, initialFeeBps);
    }

    // ------------------------- ERC-20 plumbing ---------------------------
    //
    // Some tokens return no value from transfer/approve instead of a bool.
    // A plain IERC20 call reverts on those when decoding the return data, so
    // go through a low-level call and accept "no return data" as success.

    function _callOptionalReturn(address token, bytes memory data) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) return false;
        if (ret.length == 0) return token.code.length > 0;
        return abi.decode(ret, (bool));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        if (!_callOptionalReturn(token, abi.encodeWithSelector(IERC20.transfer.selector, to, amount))) {
            revert TransferFailed();
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        if (!_callOptionalReturn(token, abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount))) {
            revert TransferFailed();
        }
    }

    /// @dev Set allowance to exactly `amount`, clearing first for tokens that
    ///      reject a non-zero-to-non-zero approve.
    function _forceApprove(address token, address spender, uint256 amount) private {
        if (!_callOptionalReturn(token, abi.encodeWithSelector(IERC20.approve.selector, spender, uint256(0)))) {
            revert ApproveFailed();
        }
        if (amount != 0) {
            if (!_callOptionalReturn(token, abi.encodeWithSelector(IERC20.approve.selector, spender, amount))) {
                revert ApproveFailed();
            }
        }
    }

    // ------------------------------ Views --------------------------------

    /// @dev Pool coin index for a supported token.
    function _indexOf(address token) private view returns (int128) {
        if (token == TOKEN0) return 0;
        if (token == TOKEN1) return 1;
        revert InvalidPair();
    }

    /// @notice Fee charged on `amountIn`, in the input token.
    function feeOn(uint256 amountIn) public view returns (uint256) {
        return (amountIn * feeBps) / 10_000;
    }

    /**
     * @notice Preview a swap, net of the protocol fee.
     * @dev Indicative only. `get_dy` reflects pool state at call time and the
     *      real swap is bounded by `minOut`, not by this number.
     */
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256 fee)
    {
        if (tokenIn == tokenOut) revert InvalidPair();
        int128 i = _indexOf(tokenIn);
        int128 j = _indexOf(tokenOut);
        fee = feeOn(amountIn);
        amountOut = ICurveStableSwap(POOL).get_dy(i, j, amountIn - fee);
    }

    // ------------------------------- Swap --------------------------------

    /**
     * @notice Swap `amountIn` of `tokenIn` for `tokenOut` through the pool.
     * @param minOut   Minimum output the caller will accept, enforced here.
     * @param deadline Unix timestamp after which the swap reverts.
     * @return amountOut Tokens actually delivered to the caller.
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (amountIn == 0) revert ZeroAmount();
        if (tokenIn == tokenOut) revert InvalidPair();
        int128 i = _indexOf(tokenIn);
        int128 j = _indexOf(tokenOut);

        // Measure what actually arrives — a fee-on-transfer or rebasing token
        // would deliver less than `amountIn`, and the pool must only be given
        // what this router really holds.
        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        _safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - inBefore;
        if (received == 0) revert ZeroAmount();

        uint256 fee = feeOn(received);
        uint256 swapAmount = received - fee;
        if (swapAmount == 0) revert ZeroAmount();

        // Approve exactly this swap, then revoke, so no standing allowance is
        // ever left for the pool to draw on.
        _forceApprove(tokenIn, POOL, swapAmount);

        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        // `minOut` is enforced below against the measured delta; passing 0 here
        // keeps the pool from reverting on its own accounting of the same bound.
        ICurveStableSwap(POOL).exchange(i, j, swapAmount, 0);
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - outBefore;

        _forceApprove(tokenIn, POOL, 0);

        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);

        // Credit the fee only once the swap has succeeded, so a reverted swap
        // never leaves a phantom entry in the ledger.
        if (fee != 0) accruedFees[tokenIn] += fee;

        _safeTransfer(tokenOut, msg.sender, amountOut);

        emit Swapped(msg.sender, tokenIn, tokenOut, received, amountOut, fee);
    }

    // ------------------------------ Admin --------------------------------

    /// @notice Update the protocol fee. Capped at MAX_FEE_BPS and unable to
    ///         harm an in-flight swap, since a higher fee lowers the output and
    ///         the caller's own `minOut` rejects it.
    function setFee(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    /// @notice Stop swaps. Reversible.
    function pause() external onlyOwner {
        if (paused) revert IsPaused();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Resume swaps.
    function unpause() external onlyOwner {
        if (!paused) revert NotPaused();
        paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Withdraw accrued protocol fees for `token`.
     * @dev Bounded by the ledger, never by the raw balance, so this cannot
     *      touch funds that are mid-swap or were sent here by accident.
     */
    function withdrawFees(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 available = accruedFees[token];
        if (amount == 0) revert ZeroAmount();
        if (amount > available) revert AmountExceedsAccrued(amount, available);

        accruedFees[token] = available - amount;   // effects before interaction
        _safeTransfer(token, to, amount);
        emit FeesWithdrawn(token, to, amount);
    }

    /// @notice Withdraw the full accrued balance of `token`.
    function withdrawAllFees(address token, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = accruedFees[token];
        if (amount == 0) revert NothingToWithdraw();

        accruedFees[token] = 0;
        _safeTransfer(token, to, amount);
        emit FeesWithdrawn(token, to, amount);
    }

    /**
     * @notice Recover tokens sent here by mistake.
     * @dev Can only move the surplus above what the fee ledger owes, so it can
     *      never be used to reach into fees or an in-flight swap.
     *
     *      `token` is caller-supplied and therefore arbitrary, unlike the swap
     *      path where it is fixed at construction, and unlike withdrawFees this
     *      function writes no state before transferring — so a token that calls
     *      back from inside transfer() would see the pre-transfer balance and
     *      compute the same surplus twice.
     *
     *      onlyOwner already stops that: the re-entering caller is the token,
     *      not the owner. Verified by removing the guard and re-running the
     *      attack, which still failed. The guard is kept because that argument
     *      depends on the owner never being a contract that can be induced to
     *      forward a call, which is a property of a future deployment rather
     *      than of this code.
     */
    function rescue(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 owed = accruedFees[token];
        uint256 surplus = balance > owed ? balance - owed : 0;
        if (amount == 0) revert ZeroAmount();
        if (amount > surplus) revert AmountExceedsAccrued(amount, surplus);

        _safeTransfer(token, to, amount);
        emit Rescued(token, to, amount);
    }

    // --------------------------- Ownership -------------------------------

    /// @notice Nominate a new owner. Takes effect only when they accept.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Cancel a pending nomination.
    function cancelOwnershipTransfer() external onlyOwner {
        pendingOwner = address(0);
        emit OwnershipTransferStarted(owner, address(0));
    }

    /// @notice Accept a nomination. Only the nominated address can call this,
    ///         which is what makes a mistyped address harmless.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address old = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(old, owner);
    }
}
