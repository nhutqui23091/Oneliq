// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Plain, well-behaved ERC-20.
contract MockERC20 {
    string public name; uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor(string memory n) { name = n; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

/// Returns NOTHING from transfer/approve/transferFrom (USDT-style).
contract MockNoReturnERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external { balanceOf[msg.sender] -= a; balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function transferFrom(address f, address t, uint256 a) external {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[t] += a;
    }
}

/// Burns 1% on every transfer — delivers less than requested.
contract MockFeeOnTransferERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function _move(address f, address t, uint256 a) private {
        uint256 burn = a / 100;
        balanceOf[f] -= a; balanceOf[t] += (a - burn);
    }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        _move(f, t, a); return true;
    }
}

interface IMintable { function balanceOf(address) external view returns (uint256); function transfer(address,uint256) external returns (bool); function transferFrom(address,address,uint256) external returns (bool); }

/// Real Curve pools handle their own tokens; these helpers make the mocks
/// equally tolerant so a no-return token exercises the ROUTER, not the mock.
library SafeMove {
    function pull(address t, address f, address to, uint256 a) internal {
        (bool ok, bytes memory r) = t.call(abi.encodeWithSelector(IMintable.transferFrom.selector, f, to, a));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "pull");
    }
    function push(address t, address to, uint256 a) internal {
        (bool ok, bytes memory r) = t.call(abi.encodeWithSelector(IMintable.transfer.selector, to, a));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "push");
    }
}

/// Honest 1:1-ish Curve pool: pulls dx of coin i, sends out dy of coin j.
contract MockPool {
    address public coin0; address public coin1;
    uint256 public rateBps = 8500;   // 1 token0 -> 0.85 token1
    constructor(address c0, address c1) { coin0 = c0; coin1 = c1; }
    function _tok(int128 k) internal view returns (address) { return k == 0 ? coin0 : coin1; }
    function get_dy(int128 i, int128 j, uint256 dx) public view returns (uint256) {
        return i == 0 ? (dx * rateBps) / 10_000 : (dx * 10_000) / rateBps;
    }
    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external virtual returns (uint256) {
        uint256 dy = get_dy(i, j, dx);
        require(dy >= min_dy, "slippage");
        SafeMove.pull(_tok(i), msg.sender, address(this), dx);
        SafeMove.push(_tok(j), msg.sender, dy);
        return dy;
    }
}

/// Reports a huge dy but only sends a token. Tries to make the router
/// hand over more than it actually received.
contract MockLyingPool is MockPool {
    constructor(address c0, address c1) MockPool(c0, c1) {}
    function exchange(int128 i, int128 j, uint256 dx, uint256) external override returns (uint256) {
        SafeMove.pull(_tok(i), msg.sender, address(this), dx);
        SafeMove.push(_tok(j), msg.sender, 1);   // sends almost nothing
        return get_dy(i, j, dx) * 1000;               // claims a fortune
    }
}

/// Calls back into the router mid-exchange.
contract MockReentrantPool is MockPool {
    address public router; bool public armed;
    constructor(address c0, address c1) MockPool(c0, c1) {}
    function arm(address r) external { router = r; armed = true; }
    function exchange(int128 i, int128 j, uint256 dx, uint256) external override returns (uint256) {
        uint256 dy = get_dy(i, j, dx);
        SafeMove.pull(_tok(i), msg.sender, address(this), dx);
        if (armed) {
            armed = false;
            (bool ok, ) = router.call(
                abi.encodeWithSignature("swap(address,address,uint256,uint256,uint256)",
                                        coin0, coin1, uint256(1_000_000), uint256(0), type(uint256).max));
            require(!ok, "REENTRANCY-SUCCEEDED");   // the guard must have stopped it
        }
        SafeMove.push(_tok(j), msg.sender, dy);
        return dy;
    }
}

/// Consumes only part of the allowance, to prove the router revokes the rest.
contract MockPartialPool is MockPool {
    constructor(address c0, address c1) MockPool(c0, c1) {}
    function exchange(int128 i, int128 j, uint256 dx, uint256) external override returns (uint256) {
        uint256 half = dx / 2;
        uint256 dy = get_dy(i, j, half);
        SafeMove.pull(_tok(i), msg.sender, address(this), half);
        SafeMove.push(_tok(j), msg.sender, dy);
        return dy;
    }
}
