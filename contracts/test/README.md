# OneliqRouterV2 test suite

Runs the contract on a real EVM in-process — no node, no network.

```bash
npm install solc@0.8.24 @ethereumjs/vm @ethereumjs/common @ethereumjs/block @ethereumjs/util ethers
node compile.mjs ../OneliqRouterV2.sol Mocks.sol Attackers.sol
node test.mjs && node test2.mjs && node rescue-test.mjs
```

`Mocks.sol` holds well-behaved fixtures; `Attackers.sol` holds the hostile
ones. A mock that reverts is a mock that caught something — the pool mocks
deliberately revert with `REENTRANCY-SUCCEEDED`, `OVER-PULLED-INPUT` and
`DRAINED-OUTPUT-FEES` when an attack lands, so a passing suite means those
strings never appeared.

`compile.mjs` writes `artifacts.json`, which the tests read. Recompile after
every edit to the contract — an early run of this suite reported green against
a stale copy.
