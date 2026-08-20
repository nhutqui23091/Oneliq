/**
 * OneliqRouterV2 — attack and behaviour suite, run on a real EVM.
 */
import { makeVM, deploy, call, read, ACCOUNTS, NOW } from './harness.mjs';

let pass = 0, fail = 0;
const R = 'OneliqRouterV2';
const MAX = (1n << 256n) - 1n;
const FAR  = NOW + 3600n;   // một giờ nữa
const PAST = NOW - 1n;      // vừa hết hạn một giây

function check(name, got, want) {
  const ok = String(got) === String(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else    { fail++; console.log(`  FAIL ${name}\n       got  ${got}\n       want ${want}`); }
}
function section(t) { console.log(`\n${t}`); }

async function fixture({ poolKind = 'MockPool', tokenKind = 'MockERC20', fee = 30 } = {}) {
  const vm = await makeVM();
  const usdc = await deploy(vm, tokenKind, tokenKind === 'MockERC20' ? ['USDC'] : []);
  const eurc = await deploy(vm, tokenKind, tokenKind === 'MockERC20' ? ['EURC'] : []);
  const pool = await deploy(vm, poolKind, [usdc, eurc]);
  const router = await deploy(vm, R, [pool, usdc, eurc, fee, ACCOUNTS.owner]);
  // Fund: users get USDC, the pool gets EURC to pay out with.
  const mint = async (tok, to, amt) => (await call(vm, tokenKind, tok, 'mint', [to, amt], ACCOUNTS.owner));
  await mint(usdc, ACCOUNTS.alice, 1_000_000_000n);
  await mint(usdc, ACCOUNTS.mallory, 1_000_000_000n);
  await mint(eurc, pool, 1_000_000_000n);
  await mint(usdc, pool, 1_000_000_000n);
  const approve = async (tok, from) =>
    call(vm, tokenKind, tok, 'approve', [router, MAX], from);
  await approve(usdc, ACCOUNTS.alice);
  await approve(usdc, ACCOUNTS.mallory);
  await approve(eurc, ACCOUNTS.alice);
  const bal = (tok, who) => read(vm, tokenKind, tok, 'balanceOf', [who]);
  return { vm, usdc, eurc, pool, router, bal, tokenKind, mint, approve };
}

const swap = (f, args, from = ACCOUNTS.alice) =>
  call(f.vm, R, f.router, 'swap', args, from);

/* ══════════════════════════════════════════════════════ */
section('1. Đường đi bình thường và sổ phí');
{
  const f = await fixture();
  const IN = 1_000_000n;                   // 1 USDC
  const before = await f.bal(f.eurc, ACCOUNTS.alice);
  const r = await swap(f, [f.usdc, f.eurc, IN, 0n, FAR]);
  check('swap thành công', r.ok, true);

  const fee = IN * 30n / 10_000n;          // 0.30% = 3000
  check('phí ghi sổ đúng 0.30%', await read(f.vm, R, f.router, 'accruedFees', [f.usdc]), fee);

  const got = (await f.bal(f.eurc, ACCOUNTS.alice)) - before;
  const expected = (IN - fee) * 8500n / 10_000n;
  check('người dùng nhận đúng số EURC', got, expected);
  check('router không giữ EURC thừa', await f.bal(f.eurc, f.router), 0n);
  check('router chỉ giữ đúng phí USDC', await f.bal(f.usdc, f.router), fee);
}

section('2. Approve cho pool phải được thu hồi sau swap');
{
  const f = await fixture();
  await swap(f, [f.usdc, f.eurc, 1_000_000n, 0n, FAR]);
  check('allowance USDC -> pool về 0', await read(f.vm, 'MockERC20', f.usdc, 'allowance', [f.router, f.pool]), 0n);

  // Pool chỉ tiêu một nửa allowance — phần dư vẫn phải bị xoá.
  const g = await fixture({ poolKind: 'MockPartialPool' });
  await swap(g, [g.usdc, g.eurc, 1_000_000n, 0n, FAR]);
  check('pool tiêu một phần -> allowance vẫn về 0',
        await read(g.vm, 'MockERC20', g.usdc, 'allowance', [g.router, g.pool]), 0n);
}

section('3. Pool nói dối — báo số lớn, gửi 1 đơn vị');
{
  const f = await fixture({ poolKind: 'MockLyingPool' });
  // Nạp sẵn phí EURC vào router để xem nó có bị rút mất không.
  await call(f.vm, 'MockERC20', f.eurc, 'mint', [f.router, 500_000n], ACCOUNTS.owner);
  const routerEurcBefore = await f.bal(f.eurc, f.router);

  const before = await f.bal(f.eurc, ACCOUNTS.alice);
  const r = await swap(f, [f.usdc, f.eurc, 1_000_000n, 0n, FAR]);
  check('swap không revert', r.ok, true);
  const got = (await f.bal(f.eurc, ACCOUNTS.alice)) - before;
  check('chỉ trả đúng số THỰC nhận (1), không phải số pool báo', got, 1n);
  check('kho EURC của router không bị đụng',
        await f.bal(f.eurc, f.router), routerEurcBefore);

  // Với minOut hợp lý, pool nói dối phải làm swap revert.
  const r2 = await swap(f, [f.usdc, f.eurc, 1_000_000n, 800_000n, FAR]);
  check('minOut chặn được pool nói dối', r2.revert, 'InsufficientOutput');
}

section('4. Pool gọi ngược lại router giữa chừng (reentrancy)');
{
  const f = await fixture({ poolKind: 'MockReentrantPool' });
  await call(f.vm, 'MockReentrantPool', f.pool, 'arm', [f.router], ACCOUNTS.owner);
  const r = await swap(f, [f.usdc, f.eurc, 1_000_000n, 0n, FAR]);
  // Mock revert với "REENTRANCY-SUCCEEDED" nếu cuộc gọi lồng nhau thành công.
  check('cuộc gọi lồng nhau BỊ CHẶN', r.revert !== 'REENTRANCY-SUCCEEDED', true);
  check('swap ngoài vẫn hoàn tất bình thường', r.ok, true);
}

section('5. Deadline và minOut');
{
  const f = await fixture();
  const expired = await swap(f, [f.usdc, f.eurc, 1_000_000n, 0n, PAST]);
  check('deadline vừa hết hạn 1 giây -> revert', expired.revert, 'DeadlinePassed');
  const edge = await swap(f, [f.usdc, f.eurc, 1_000_000n, 0n, NOW]);
  check('deadline đúng bằng giây hiện tại -> vẫn hợp lệ', edge.ok, true);

  const g = await fixture();
  const greedy = await swap(g, [g.usdc, g.eurc, 1_000_000n, 999_999_999n, FAR]);
  check('minOut không đạt -> revert', greedy.revert, 'InsufficientOutput');
  check('swap thất bại KHÔNG ghi phí nào',
        await read(g.vm, R, g.router, 'accruedFees', [g.usdc]), 0n);
  check('và không giữ lại token nào của người dùng', await g.bal(g.usdc, g.router), 0n);
  check('tiền người dùng còn nguyên',
        await g.bal(g.usdc, ACCOUNTS.alice), 1_000_000_000n);
}

section('6. Rút phí — không bao giờ vượt sổ');
{
  const f = await fixture();
  await swap(f, [f.usdc, f.eurc, 1_000_000n, 0n, FAR]);
  const accrued = await read(f.vm, R, f.router, 'accruedFees', [f.usdc]);

  // Ai đó gửi nhầm 10 USDC vào router.
  await call(f.vm, 'MockERC20', f.usdc, 'mint', [f.router, 10_000_000n], ACCOUNTS.owner);
  check('router giữ nhiều hơn sổ phí', (await f.bal(f.usdc, f.router)) > accrued, true);

  const over = await call(f.vm, R, f.router, 'withdrawFees',
                          [f.usdc, ACCOUNTS.treasury, accrued + 1n], ACCOUNTS.owner);
  check('rút quá sổ -> revert', over.revert, 'AmountExceedsAccrued');

  const exact = await call(f.vm, R, f.router, 'withdrawFees',
                           [f.usdc, ACCOUNTS.treasury, accrued], ACCOUNTS.owner);
  check('rút đúng sổ -> ok', exact.ok, true);
  check('treasury nhận đủ', await f.bal(f.usdc, ACCOUNTS.treasury), accrued);
  check('sổ phí về 0', await read(f.vm, R, f.router, 'accruedFees', [f.usdc]), 0n);

  const again = await call(f.vm, R, f.router, 'withdrawAllFees',
                           [f.usdc, ACCOUNTS.treasury], ACCOUNTS.owner);
  check('rút lần hai khi sổ rỗng -> revert', again.revert, 'NothingToWithdraw');
}

section('7. rescue() không được chạm vào phí');
{
  const f = await fixture();
  await swap(f, [f.usdc, f.eurc, 10_000_000n, 0n, FAR]);
  const accrued = await read(f.vm, R, f.router, 'accruedFees', [f.usdc]);
  await call(f.vm, 'MockERC20', f.usdc, 'mint', [f.router, 7_000_000n], ACCOUNTS.owner);

  const tooMuch = await call(f.vm, R, f.router, 'rescue',
                             [f.usdc, ACCOUNTS.treasury, 7_000_001n], ACCOUNTS.owner);
  check('rescue quá phần dư -> revert', tooMuch.revert, 'AmountExceedsAccrued');

  const okr = await call(f.vm, R, f.router, 'rescue',
                         [f.usdc, ACCOUNTS.treasury, 7_000_000n], ACCOUNTS.owner);
  check('rescue đúng phần dư -> ok', okr.ok, true);
  check('phí vẫn nguyên vẹn', await f.bal(f.usdc, f.router), accrued);
  check('sổ phí không đổi', await read(f.vm, R, f.router, 'accruedFees', [f.usdc]), accrued);
}

section('8. Phân quyền — Mallory không làm gì được');
{
  const f = await fixture();
  await swap(f, [f.usdc, f.eurc, 1_000_000n, 0n, FAR]);
  const M = ACCOUNTS.mallory;
  for (const [fn, args] of [
    ['setFee', [100]],
    ['pause', []],
    ['unpause', []],
    ['withdrawFees', [f.usdc, M, 1n]],
    ['withdrawAllFees', [f.usdc, M]],
    ['rescue', [f.usdc, M, 1n]],
    ['transferOwnership', [M]],
    ['cancelOwnershipTransfer', []],
  ]) {
    const r = await call(f.vm, R, f.router, fn, args, M);
    check(`${fn} bởi người lạ -> NotOwner`, r.revert, 'NotOwner');
  }
}

section('9. Chuyển quyền sở hữu hai bước');
{
  const f = await fixture();
  const TYPO = '0x000000000000000000000000000000000000dead';

  await call(f.vm, R, f.router, 'transferOwnership', [TYPO], ACCOUNTS.owner);
  check('owner CHƯA đổi sau khi đề xuất',
        (await read(f.vm, R, f.router, 'owner')).toLowerCase(), ACCOUNTS.owner);
  check('pendingOwner được ghi nhận',
        (await read(f.vm, R, f.router, 'pendingOwner')).toLowerCase(), TYPO);

  const wrong = await call(f.vm, R, f.router, 'acceptOwnership', [], ACCOUNTS.mallory);
  check('người không được đề xuất không nhận được', wrong.revert, 'NotPendingOwner');

  // Gõ nhầm địa chỉ vẫn cứu được: chỉ cần huỷ.
  await call(f.vm, R, f.router, 'cancelOwnershipTransfer', [], ACCOUNTS.owner);
  check('huỷ được đề xuất sai',
        (await read(f.vm, R, f.router, 'pendingOwner')), '0x0000000000000000000000000000000000000000');
  check('owner vẫn là mình',
        (await read(f.vm, R, f.router, 'owner')).toLowerCase(), ACCOUNTS.owner);

  await call(f.vm, R, f.router, 'transferOwnership', [ACCOUNTS.newOwner], ACCOUNTS.owner);
  await call(f.vm, R, f.router, 'acceptOwnership', [], ACCOUNTS.newOwner);
  check('chủ mới nhận thành công',
        (await read(f.vm, R, f.router, 'owner')).toLowerCase(), ACCOUNTS.newOwner);
  const oldTry = await call(f.vm, R, f.router, 'setFee', [50], ACCOUNTS.owner);
  check('chủ cũ mất quyền ngay', oldTry.revert, 'NotOwner');
}

section('10. Tạm dừng');
{
  const f = await fixture();
  await call(f.vm, R, f.router, 'pause', [], ACCOUNTS.owner);
  const blocked = await swap(f, [f.usdc, f.eurc, 1_000_000n, 0n, FAR]);
  check('đang pause -> swap revert', blocked.revert, 'IsPaused');
  const twice = await call(f.vm, R, f.router, 'pause', [], ACCOUNTS.owner);
  check('pause hai lần -> revert', twice.revert, 'IsPaused');
  await call(f.vm, R, f.router, 'unpause', [], ACCOUNTS.owner);
  const after = await swap(f, [f.usdc, f.eurc, 1_000_000n, 0n, FAR]);
  check('unpause -> swap chạy lại', after.ok, true);
  // Rút phí vẫn được khi pause, để xử lý sự cố.
  await call(f.vm, R, f.router, 'pause', [], ACCOUNTS.owner);
  const w = await call(f.vm, R, f.router, 'withdrawAllFees', [f.usdc, ACCOUNTS.treasury], ACCOUNTS.owner);
  check('vẫn rút được phí khi đang pause', w.ok, true);
}

section('11. Trần phí');
{
  const f = await fixture();
  check('setFee 101 bps -> revert', (await call(f.vm, R, f.router, 'setFee', [101], ACCOUNTS.owner)).revert, 'FeeTooHigh');
  check('setFee 100 bps -> ok', (await call(f.vm, R, f.router, 'setFee', [100], ACCOUNTS.owner)).ok, true);
  check('feeBps = 100', await read(f.vm, R, f.router, 'feeBps'), 100n);
  check('MAX_FEE_BPS là hằng số 100', await read(f.vm, R, f.router, 'MAX_FEE_BPS'), 100n);
}

section('12. Đầu vào không hợp lệ');
{
  const f = await fixture();
  const BAD = '0x00000000000000000000000000000000000000ff';
  check('amountIn = 0', (await swap(f, [f.usdc, f.eurc, 0n, 0n, FAR])).revert, 'ZeroAmount');
  check('cùng một token', (await swap(f, [f.usdc, f.usdc, 1n, 0n, FAR])).revert, 'InvalidPair');
  check('token lạ', (await swap(f, [BAD, f.eurc, 1_000_000n, 0n, FAR])).revert, 'InvalidPair');
  check('rút về địa chỉ 0',
        (await call(f.vm, R, f.router, 'withdrawFees',
          [f.usdc, '0x0000000000000000000000000000000000000000', 1n], ACCOUNTS.owner)).revert, 'ZeroAddress');
}

section('13. Constructor phải từ chối cấu hình hỏng');
{
  const vm = (await fixture()).vm;
  const Z = '0x0000000000000000000000000000000000000000';
  const A = '0x00000000000000000000000000000000000000a1';
  const B = '0x00000000000000000000000000000000000000b2';
  const tryDeploy = async (args) => {
    try { await deploy(vm, R, args); return 'DEPLOYED'; } catch { return 'REVERTED'; }
  };
  check('pool = 0',        await tryDeploy([Z, A, B, 30, ACCOUNTS.owner]), 'REVERTED');
  check('token0 = 0',      await tryDeploy([A, Z, B, 30, ACCOUNTS.owner]), 'REVERTED');
  check('owner = 0',       await tryDeploy([A, A, B, 30, Z]),              'REVERTED');
  check('hai token trùng', await tryDeploy([A, B, B, 30, ACCOUNTS.owner]), 'REVERTED');
  check('fee > trần',      await tryDeploy([A, B, A, 101, ACCOUNTS.owner]),'REVERTED');
  check('cấu hình hợp lệ', await tryDeploy([A, B, A, 30, ACCOUNTS.owner]), 'DEPLOYED');
}

section('14. Token không trả về giá trị (kiểu USDT)');
{
  const f = await fixture({ tokenKind: 'MockNoReturnERC20' });
  const before = await f.bal(f.eurc, ACCOUNTS.alice);
  const r = await swap(f, [f.usdc, f.eurc, 1_000_000n, 0n, FAR]);
  check('swap vẫn chạy', r.ok, true);
  check('người dùng vẫn nhận được EURC', (await f.bal(f.eurc, ACCOUNTS.alice)) > before, true);
  check('phí vẫn ghi đúng', await read(f.vm, R, f.router, 'accruedFees', [f.usdc]), 3000n);
}

section('15. Token thu phí khi chuyển (fee-on-transfer)');
{
  const f = await fixture({ tokenKind: 'MockFeeOnTransferERC20' });
  const IN = 1_000_000n;
  const r = await swap(f, [f.usdc, f.eurc, IN, 0n, FAR]);
  check('swap chạy', r.ok, true);
  // Router chỉ thực nhận 99% -> phí phải tính trên số thực nhận, không phải amountIn.
  const realIn = IN - IN / 100n;
  check('phí tính trên số THỰC nhận',
        await read(f.vm, R, f.router, 'accruedFees', [f.usdc]), realIn * 30n / 10_000n);
}

section('16. Phí làm tròn xuống 0 với số quá nhỏ');
{
  const f = await fixture();
  const r = await swap(f, [f.usdc, f.eurc, 100n, 0n, FAR]);   // 100 * 30 / 10000 = 0
  check('vẫn swap được', r.ok, true);
  check('không ghi phí', await read(f.vm, R, f.router, 'accruedFees', [f.usdc]), 0n);
}

section('17. Bất biến sau nhiều lượt: số dư luôn >= sổ phí');
{
  const f = await fixture();
  let worst = true;
  for (let i = 0; i < 12; i++) {
    const from = i % 2 ? ACCOUNTS.mallory : ACCOUNTS.alice;
    await swap(f, [f.usdc, f.eurc, BigInt(500_000 + i * 37_000), 0n, FAR], from);
    const bal = await f.bal(f.usdc, f.router);
    const owed = await read(f.vm, R, f.router, 'accruedFees', [f.usdc]);
    if (bal < owed) worst = false;
  }
  check('12 lượt swap: số dư USDC luôn >= sổ phí', worst, true);
  const bal = await f.bal(f.usdc, f.router);
  const owed = await read(f.vm, R, f.router, 'accruedFees', [f.usdc]);
  check('và khớp chính xác (không thất thoát)', bal, owed);
  check('không kẹt EURC nào trong router', await f.bal(f.eurc, f.router), 0n);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
