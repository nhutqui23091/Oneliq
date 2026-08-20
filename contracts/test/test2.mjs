/**
 * Vòng 2 + 3: các hướng tấn công còn lại, và fuzz bất biến.
 */
import { makeVM, deploy, call, read, ACCOUNTS, NOW } from './harness.mjs';

let pass = 0, fail = 0;
const R = 'OneliqRouterV2';
const MAX = (1n << 256n) - 1n;
const FAR = NOW + 3600n;
const ZERO = '0x0000000000000000000000000000000000000000';

function check(name, got, want) {
  const ok = String(got) === String(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else    { fail++; console.log(`  FAIL ${name}\n       got  ${got}\n       want ${want}`); }
}
const section = t => console.log(`\n${t}`);

/* ══════════════════════════════════════════════════════ */
section('18. Token độc gọi ngược router từ trong transfer()');
{
  const vm = await makeVM();
  const evil = await deploy(vm, 'MockReentrantToken', []);
  const eurc = await deploy(vm, 'MockERC20', ['EURC']);
  const pool = await deploy(vm, 'MockPool', [evil, eurc]);
  const router = await deploy(vm, R, [pool, evil, eurc, 30, ACCOUNTS.owner]);

  await call(vm, 'MockReentrantToken', evil, 'mint', [ACCOUNTS.alice, 1_000_000_000n]);
  await call(vm, 'MockERC20', eurc, 'mint', [pool, 1_000_000_000n]);
  await call(vm, 'MockReentrantToken', evil, 'approve', [router, MAX], ACCOUNTS.alice);
  await call(vm, 'MockReentrantToken', evil, 'arm', [router, eurc], ACCOUNTS.owner);

  const r = await call(vm, R, router, 'swap', [evil, eurc, 1_000_000n, 0n, FAR], ACCOUNTS.alice);
  // Token revert với "REENTRANCY-SUCCEEDED" nếu cuộc gọi lồng nhau lọt qua.
  check('token độc KHÔNG reenter được', r.revert !== 'REENTRANCY-SUCCEEDED', true);
  check('swap vẫn hoàn tất', r.ok, true);
}

section('19. Pool tham lam — cố lấy quá hạn mức và cướp kho phí đầu ra');
{
  const vm = await makeVM();
  const usdc = await deploy(vm, 'MockERC20', ['USDC']);
  const eurc = await deploy(vm, 'MockERC20', ['EURC']);
  const pool = await deploy(vm, 'MockGreedyPool', [usdc, eurc]);
  const router = await deploy(vm, R, [pool, usdc, eurc, 30, ACCOUNTS.owner]);

  await call(vm, 'MockERC20', usdc, 'mint', [ACCOUNTS.alice, 1_000_000_000n]);
  await call(vm, 'MockERC20', eurc, 'mint', [pool, 1_000_000_000n]);
  await call(vm, 'MockERC20', usdc, 'approve', [router, MAX], ACCOUNTS.alice);

  // Nạp sẵn kho phí ở CẢ HAI token để pool có thứ để cướp.
  await call(vm, 'MockERC20', usdc, 'mint', [router, 400_000n], ACCOUNTS.owner);
  await call(vm, 'MockERC20', eurc, 'mint', [router, 900_000n], ACCOUNTS.owner);
  const usdcBefore = await read(vm, 'MockERC20', usdc, 'balanceOf', [router]);
  const eurcBefore = await read(vm, 'MockERC20', eurc, 'balanceOf', [router]);

  const r = await call(vm, R, router, 'swap', [usdc, eurc, 1_000_000n, 0n, FAR], ACCOUNTS.alice);
  check('pool KHÔNG lấy quá hạn mức đầu vào', r.revert !== 'OVER-PULLED-INPUT', true);
  check('pool KHÔNG cướp được kho phí đầu ra', r.revert !== 'DRAINED-OUTPUT-FEES', true);

  const eurcAfter = await read(vm, 'MockERC20', eurc, 'balanceOf', [router]);
  check('kho EURC còn nguyên sau swap', eurcAfter, eurcBefore);
  const usdcAfter = await read(vm, 'MockERC20', usdc, 'balanceOf', [router]);
  check('kho USDC chỉ tăng đúng phần phí', usdcAfter - usdcBefore, 3000n);
}

section('20. Allowance đúng bằng swapAmount, không dư một đơn vị');
{
  const vm = await makeVM();
  const usdc = await deploy(vm, 'MockERC20', ['USDC']);
  const eurc = await deploy(vm, 'MockERC20', ['EURC']);
  const pool = await deploy(vm, 'MockPartialPool', [usdc, eurc]);   // chỉ tiêu một nửa
  const router = await deploy(vm, R, [pool, usdc, eurc, 30, ACCOUNTS.owner]);
  await call(vm, 'MockERC20', usdc, 'mint', [ACCOUNTS.alice, 1_000_000_000n]);
  await call(vm, 'MockERC20', eurc, 'mint', [pool, 1_000_000_000n]);
  await call(vm, 'MockERC20', usdc, 'approve', [router, MAX], ACCOUNTS.alice);

  await call(vm, R, router, 'swap', [usdc, eurc, 1_000_000n, 0n, FAR], ACCOUNTS.alice);
  check('không còn hạn mức tồn đọng cho pool',
        await read(vm, 'MockERC20', usdc, 'allowance', [router, pool]), 0n);
}

section('21. Người dùng không có allowance / không đủ tiền');
{
  const vm = await makeVM();
  const usdc = await deploy(vm, 'MockERC20', ['USDC']);
  const eurc = await deploy(vm, 'MockERC20', ['EURC']);
  const pool = await deploy(vm, 'MockPool', [usdc, eurc]);
  const router = await deploy(vm, R, [pool, usdc, eurc, 30, ACCOUNTS.owner]);
  await call(vm, 'MockERC20', eurc, 'mint', [pool, 1_000_000_000n]);

  const noAllow = await call(vm, R, router, 'swap', [usdc, eurc, 1_000n, 0n, FAR], ACCOUNTS.mallory);
  check('chưa approve -> revert, không âm thầm bỏ qua', noAllow.ok, false);

  await call(vm, 'MockERC20', usdc, 'approve', [router, MAX], ACCOUNTS.mallory);
  const noFunds = await call(vm, R, router, 'swap', [usdc, eurc, 1_000n, 0n, FAR], ACCOUNTS.mallory);
  check('không đủ số dư -> revert', noFunds.ok, false);
  check('không ghi phí ma', await read(vm, R, router, 'accruedFees', [usdc]), 0n);
}

section('22. Fuzz 300 lượt hai chiều — bất biến phải luôn đúng');
{
  const vm = await makeVM();
  const usdc = await deploy(vm, 'MockERC20', ['USDC']);
  const eurc = await deploy(vm, 'MockERC20', ['EURC']);
  const pool = await deploy(vm, 'MockPool', [usdc, eurc]);
  const router = await deploy(vm, R, [pool, usdc, eurc, 30, ACCOUNTS.owner]);

  for (const t of [usdc, eurc]) {
    await call(vm, 'MockERC20', t, 'mint', [ACCOUNTS.alice, 10n ** 15n]);
    await call(vm, 'MockERC20', t, 'mint', [ACCOUNTS.mallory, 10n ** 15n]);
    await call(vm, 'MockERC20', t, 'mint', [pool, 10n ** 18n]);
    await call(vm, 'MockERC20', t, 'approve', [router, MAX], ACCOUNTS.alice);
    await call(vm, 'MockERC20', t, 'approve', [router, MAX], ACCOUNTS.mallory);
  }

  let expectedUsdcFees = 0n, expectedEurcFees = 0n;
  let invariantHeld = true, feeExact = true, swaps = 0;
  let seed = 987654321n;
  const rnd = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return seed % n; };

  for (let i = 0; i < 300; i++) {
    // Thỉnh thoảng đổi phí, kể cả về 0 và kịch trần.
    if (i % 50 === 0) {
      const newFee = [0, 1, 30, 77, 100][Number(rnd(5n))];
      await call(vm, R, router, 'setFee', [newFee], ACCOUNTS.owner);
    }
    const fee = await read(vm, R, router, 'feeBps');
    const forward = rnd(2n) === 0n;
    const tIn = forward ? usdc : eurc;
    const tOut = forward ? eurc : usdc;
    const amt = 1_000n + rnd(50_000_000n);
    const from = rnd(2n) === 0n ? ACCOUNTS.alice : ACCOUNTS.mallory;

    const r = await call(vm, R, router, 'swap', [tIn, tOut, amt, 0n, FAR], from);
    if (!r.ok) continue;
    swaps++;
    const f = amt * fee / 10_000n;
    if (forward) expectedUsdcFees += f; else expectedEurcFees += f;

    // Thỉnh thoảng rút phí ra — sổ sách phải theo kịp.
    if (i % 37 === 0) {
      const acc = await read(vm, R, router, 'accruedFees', [usdc]);
      if (acc > 0n) {
        await call(vm, R, router, 'withdrawFees', [usdc, ACCOUNTS.treasury, acc], ACCOUNTS.owner);
        expectedUsdcFees -= acc;
      }
    }

    for (const t of [usdc, eurc]) {
      const bal = await read(vm, 'MockERC20', t, 'balanceOf', [router]);
      const owed = await read(vm, R, router, 'accruedFees', [t]);
      if (bal < owed) invariantHeld = false;
    }
  }

  check(`${swaps} lượt swap thành công`, swaps > 250, true);
  check('BẤT BIẾN: số dư router luôn >= sổ phí, mọi lượt', invariantHeld, true);
  check('sổ phí USDC khớp tính tay', await read(vm, R, router, 'accruedFees', [usdc]), expectedUsdcFees);
  check('sổ phí EURC khớp tính tay', await read(vm, R, router, 'accruedFees', [eurc]), expectedEurcFees);

  const balU = await read(vm, 'MockERC20', usdc, 'balanceOf', [router]);
  const balE = await read(vm, 'MockERC20', eurc, 'balanceOf', [router]);
  check('không thất thoát USDC (số dư == sổ)', balU, expectedUsdcFees);
  check('không thất thoát EURC (số dư == sổ)', balE, expectedEurcFees);

  const finalOwner = await read(vm, R, router, 'owner');
  check('quyền sở hữu không đổi sau 300 lượt', finalOwner.toLowerCase(), ACCOUNTS.owner);
  check('không kẹt hạn mức nào cho pool',
        await read(vm, 'MockERC20', usdc, 'allowance', [router, pool]), 0n);
}

section('23. Rút sạch phí rồi swap tiếp — sổ phải bắt đầu lại từ 0');
{
  const vm = await makeVM();
  const usdc = await deploy(vm, 'MockERC20', ['USDC']);
  const eurc = await deploy(vm, 'MockERC20', ['EURC']);
  const pool = await deploy(vm, 'MockPool', [usdc, eurc]);
  const router = await deploy(vm, R, [pool, usdc, eurc, 30, ACCOUNTS.owner]);
  await call(vm, 'MockERC20', usdc, 'mint', [ACCOUNTS.alice, 10n ** 12n]);
  await call(vm, 'MockERC20', eurc, 'mint', [pool, 10n ** 12n]);
  await call(vm, 'MockERC20', usdc, 'approve', [router, MAX], ACCOUNTS.alice);

  await call(vm, R, router, 'swap', [usdc, eurc, 10_000_000n, 0n, FAR], ACCOUNTS.alice);
  await call(vm, R, router, 'withdrawAllFees', [usdc, ACCOUNTS.treasury], ACCOUNTS.owner);
  check('sổ về 0 sau khi rút sạch', await read(vm, R, router, 'accruedFees', [usdc]), 0n);
  check('số dư router về 0', await read(vm, 'MockERC20', usdc, 'balanceOf', [router]), 0n);

  await call(vm, R, router, 'swap', [usdc, eurc, 10_000_000n, 0n, FAR], ACCOUNTS.alice);
  check('swap sau đó vẫn ghi phí bình thường',
        await read(vm, R, router, 'accruedFees', [usdc]), 30_000n);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
