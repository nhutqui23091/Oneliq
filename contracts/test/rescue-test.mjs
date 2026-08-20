import { makeVM, deploy, call, read, ACCOUNTS } from './harness.mjs';
let pass=0, fail=0;
const check=(n,g,w)=>{const ok=String(g)===String(w); if(ok){pass++;console.log(`  ok   ${n}`);}else{fail++;console.log(`  FAIL ${n}\n       got  ${g}\n       want ${w}`);}};
const R='OneliqRouterV2';

console.log('\n24. Token độc gọi ngược rescue() để lấy phần dư hai lần');
const vm = await makeVM();
const evil = await deploy(vm, 'MockRescueReenterToken', []);
const usdc = await deploy(vm, 'MockERC20', ['USDC']);
const eurc = await deploy(vm, 'MockERC20', ['EURC']);
const pool = await deploy(vm, 'MockPool', [usdc, eurc]);
const router = await deploy(vm, R, [pool, usdc, eurc, 30, ACCOUNTS.owner]);

// Router giữ 1000 token độc; giả lập 600 trong đó là "phí đã ghi sổ" bằng cách
// nạp sổ qua một swap không được — nên ta kiểm bằng phần dư thuần.
await call(vm, 'MockRescueReenterToken', evil, 'mint', [router, 1000n]);
await call(vm, 'MockRescueReenterToken', evil, 'arm', [router, ACCOUNTS.mallory, 1000n], ACCOUNTS.owner);

const before = await read(vm, 'MockRescueReenterToken', evil, 'balanceOf', [router]);
const r = await call(vm, R, router, 'rescue', [evil, ACCOUNTS.treasury, 1000n], ACCOUNTS.owner);
const reenters = await read(vm, 'MockRescueReenterToken', evil, 'reenterCount');

check('token ĐÃ cố gọi ngược lại (bẫy có hoạt động)', reenters, 1n);
check('cuộc gọi lồng nhau BỊ CHẶN', r.revert !== 'RESCUE-REENTRANCY-SUCCEEDED', true);
check('rescue ngoài vẫn thành công', r.ok, true);
check('kẻ tấn công không nhận được gì',
      await read(vm, 'MockRescueReenterToken', evil, 'balanceOf', [ACCOUNTS.mallory]), 0n);
check('router chuyển đi đúng một lần',
      await read(vm, 'MockRescueReenterToken', evil, 'balanceOf', [ACCOUNTS.treasury]), before);
check('router còn 0', await read(vm, 'MockRescueReenterToken', evil, 'balanceOf', [router]), 0n);

console.log(`\n${fail===0?'ALL PASS':'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail===0?0:1);
