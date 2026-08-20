/**
 * Minimal EVM harness: deploys and calls compiled contracts in-process.
 */
import { createVM } from '@ethereumjs/vm';
import { Common, Mainnet, Hardfork } from '@ethereumjs/common';
import { createBlock } from '@ethereumjs/block';
import { hexToBytes, bytesToHex, createAddressFromString, createAccount } from '@ethereumjs/util';
import { Interface } from 'ethers';
import fs from 'node:fs';

export const artifacts = JSON.parse(fs.readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));

export const ACCOUNTS = {
  owner:   '0x1000000000000000000000000000000000000001',
  alice:   '0x1000000000000000000000000000000000000002',
  mallory: '0x1000000000000000000000000000000000000003',
  treasury:'0x1000000000000000000000000000000000000004',
  newOwner:'0x1000000000000000000000000000000000000005',
};

const addr = (h) => createAddressFromString(h.toLowerCase());

export async function makeVM() {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai });
  const vm = await createVM({ common });
  for (const a of Object.values(ACCOUNTS)) {
    await vm.stateManager.putAccount(addr(a), createAccount({ balance: 10n ** 24n }));
  }
  return vm;
}

// Deadline logic reads block.timestamp; the default harness block has 0, which
// would make any deadline look valid. Pin a realistic one.
export const NOW = 1787000000n;
export function blockAt(ts = NOW, common) {
  return createBlock({ header: { timestamp: ts, number: 1n, gasLimit: 30000000n } }, { common });
}

export function iface(name) { return new Interface(artifacts[name].abi); }

export async function deploy(vm, name, args = [], from = ACCOUNTS.owner) {
  const i = iface(name);
  const encodedArgs = args.length
    ? i.encodeDeploy(args).replace(/^0x/, '')
    : '';
  const res = await vm.evm.runCall({
    caller: addr(from),
    origin: addr(from),
    data: hexToBytes(artifacts[name].bytecode + encodedArgs),
    gasLimit: 30_000_000n,
    value: 0n,
    block: blockAt(NOW, vm.common),
  });
  if (res.execResult.exceptionError) {
    throw new Error(`deploy ${name} failed: ${res.execResult.exceptionError.error}`);
  }
  return bytesToHex(res.createdAddress.bytes);
}

/** Returns { ok, data, error, revert } — never throws on revert. */
export async function call(vm, name, to, fn, args = [], from = ACCOUNTS.owner, opts = {}) {
  const i = iface(name);
  const data = i.encodeFunctionData(fn, args);
  const res = await vm.evm.runCall({
    caller: addr(from),
    origin: addr(from),
    to: addr(to),
    data: hexToBytes(data),
    gasLimit: 30_000_000n,
    value: 0n,
    block: blockAt(opts.timestamp ?? NOW, vm.common),
  });
  const ret = bytesToHex(res.execResult.returnValue);
  if (res.execResult.exceptionError) {
    let revert = null;
    try {
      const err = i.parseError(ret);
      revert = err ? err.name : null;
    } catch { /* not a custom error */ }
    if (!revert && ret.startsWith('0x08c379a0')) {
      try { revert = new Interface(['function Error(string)']).decodeFunctionData('Error', ret)[0]; } catch {}
    }
    return { ok: false, error: res.execResult.exceptionError.error, revert, data: ret };
  }
  let decoded = null;
  try { decoded = i.decodeFunctionResult(fn, ret); } catch {}
  return { ok: true, data: ret, decoded, logs: res.execResult.logs || [] };
}

/** Convenience: call and require success, returning the first decoded value. */
export async function read(vm, name, to, fn, args = [], from = ACCOUNTS.owner) {
  const r = await call(vm, name, to, fn, args, from);
  if (!r.ok) throw new Error(`${fn} reverted: ${r.revert || r.error}`);
  return r.decoded && r.decoded.length === 1 ? r.decoded[0] : r.decoded;
}

export async function setTimestamp(vm, ts) {
  // runCall uses the block passed in; simplest is to pass a block override.
  vm._customTimestamp = ts;
}
