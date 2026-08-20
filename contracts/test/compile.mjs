import solc from 'solc';
import fs from 'node:fs';

const sources = {};
for (const f of process.argv.slice(2)) sources[f] = { content: fs.readFileSync(f, 'utf8') };

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
let fatal = 0;
for (const e of out.errors || []) {
  if (e.severity === 'error') { fatal++; console.error('ERROR  ' + e.formattedMessage); }
  else console.error('WARN   ' + e.formattedMessage.split('\n')[0]);
}
if (fatal) { console.error(`\n${fatal} compile error(s)`); process.exit(1); }

const artifacts = {};
for (const [file, contracts] of Object.entries(out.contracts || {})) {
  for (const [name, c] of Object.entries(contracts)) {
    artifacts[name] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object,
                        deployed: '0x' + c.evm.deployedBytecode.object };
    console.log(`  ${name.padEnd(24)} ${(c.evm.deployedBytecode.object.length/2)} bytes deployed`);
  }
}
fs.writeFileSync('artifacts.json', JSON.stringify(artifacts, null, 2));
console.log('\ncompiled OK');
