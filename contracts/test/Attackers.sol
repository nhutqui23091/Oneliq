// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IRouter {
    function swap(address,address,uint256,uint256,uint256) external returns (uint256);
    function accruedFees(address) external view returns (uint256);
}
interface ITok {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
    function transferFrom(address,address,uint256) external returns (bool);
    function approve(address,uint256) external returns (bool);
    function allowance(address,address) external view returns (uint256);
}

/// A token that calls back into the router from inside transfer().
/// If the router had no guard, this reenters while its balances are mid-flight.
contract MockReentrantToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public router; address public other; bool public armed;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function arm(address r, address o) external { router = r; other = o; armed = true; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function _hook() private {
        if (armed && router != address(0)) {
            armed = false;
            (bool ok, ) = router.call(abi.encodeWithSelector(
                IRouter.swap.selector, address(this), other, uint256(1000), uint256(0), type(uint256).max));
            require(!ok, "REENTRANCY-SUCCEEDED");
        }
    }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; _hook(); return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[t] += a; _hook(); return true;
    }
}

/// Tries to take MORE than the router approved, and to touch the output token.
contract MockGreedyPool {
    address public coin0; address public coin1;
    constructor(address c0, address c1) { coin0 = c0; coin1 = c1; }
    function get_dy(int128 i, int128, uint256 dx) external pure returns (uint256) { return dx; }

    /// Attempt 1: pull far more tokenIn than the exact allowance granted.
    function exchange(int128 i, int128 j, uint256 dx, uint256) external returns (uint256) {
        address tin  = i == 0 ? coin0 : coin1;
        address tout = j == 0 ? coin0 : coin1;
        // Take everything the router will let us take.
        uint256 routerBal = ITok(tin).balanceOf(msg.sender);
        (bool grabbedIn, ) = tin.call(abi.encodeWithSelector(ITok.transferFrom.selector, msg.sender, address(this), routerBal));
        // Attempt 2: drain the router's OUTPUT-token fee pot.
        uint256 outBal = ITok(tout).balanceOf(msg.sender);
        (bool grabbedOut, ) = tout.call(abi.encodeWithSelector(ITok.transferFrom.selector, msg.sender, address(this), outBal));
        require(!grabbedIn || routerBal <= dx, "OVER-PULLED-INPUT");
        require(!grabbedOut || outBal == 0, "DRAINED-OUTPUT-FEES");
        // Behave normally so the swap can complete.
        ITok(tin).transferFrom(msg.sender, address(this), dx);
        ITok(tout).transfer(msg.sender, dx);
        return dx;
    }
}

/// Token that re-enters rescue() from inside transfer(). If the router does
/// not hold a lock there, the second pass sees the pre-transfer balance and
/// takes the surplus twice — the difference coming out of accrued fees.
contract MockRescueReenterToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public router; address public thief; uint256 public amount; bool public armed;
    uint256 public reenterCount;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
    function arm(address r, address th, uint256 amt) external { router = r; thief = th; amount = amt; armed = true; }

    function transfer(address to, uint256 a) external returns (bool) {
        // Move funds first, exactly like a normal token.
        balanceOf[msg.sender] -= a; balanceOf[to] += a;
        if (armed) {
            armed = false;
            reenterCount++;
            // Try to take the surplus a second time before the outer call ends.
            (bool ok, ) = router.call(abi.encodeWithSignature(
                "rescue(address,address,uint256)", address(this), thief, amount));
            require(!ok, "RESCUE-REENTRANCY-SUCCEEDED");
        }
        return true;
    }
}
