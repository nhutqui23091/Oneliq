/**
 * Per-chain JSON-RPC endpoint lookup.
 *
 * Lived at api/agent/_balance.js until the Agent API was closed (2026-10-04).
 * The metrics Function still needs it to verify a reported tx hash on chain,
 * so the one exported helper moved here rather than dying with that folder.
 *
 * The defaults are PUBLIC, keyless endpoints — safe to commit, fine for our
 * traffic. To use a private endpoint (Alchemy, Infura, QuickNode…), set the
 * matching env var below as a Cloudflare Pages **secret**, never in a file;
 * it is read at runtime and wins over the public default for that chain.
 *
 * Both networks are listed because a stored receipt can carry either chain
 * key: mainnet is what the app runs on, and testnet rows predate the cutover.
 */

const PUBLIC_RPC = {
  // ── Mainnet ──
  arc:             'https://rpc.mainnet.arc.io',
  ethereum:        'https://ethereum-rpc.publicnode.com',
  base:            'https://base-rpc.publicnode.com',
  arbitrum:        'https://arbitrum-one-rpc.publicnode.com',
  optimism:        'https://optimism-rpc.publicnode.com',
  polygon:         'https://polygon-bor-rpc.publicnode.com',
  avalanche:       'https://avalanche-c-chain-rpc.publicnode.com',
  unichain:        'https://unichain-rpc.publicnode.com',

  // ── Testnet (kept for historical receipts) ──
  arcTestnet:      'https://rpc.testnet.arc.network',
  sepolia:         'https://ethereum-sepolia-rpc.publicnode.com',
  baseSepolia:     'https://sepolia.base.org',
  arbitrumSepolia: 'https://sepolia-rollup.arbitrum.io/rpc',
  optimismSepolia: 'https://optimism-sepolia.publicnode.com',
  polygonAmoy:     'https://rpc-amoy.polygon.technology',
  avalancheFuji:   'https://api.avax-test.network/ext/bc/C/rpc',
  unichainSepolia: 'https://sepolia.unichain.org',
};

const ENV_KEY = {
  arc:             'RPC_ARC',
  ethereum:        'RPC_ETHEREUM',
  base:            'RPC_BASE',
  arbitrum:        'RPC_ARBITRUM',
  optimism:        'RPC_OPTIMISM',
  polygon:         'RPC_POLYGON',
  avalanche:       'RPC_AVALANCHE',
  unichain:        'RPC_UNICHAIN',

  arcTestnet:      'RPC_ARC_TESTNET',
  sepolia:         'RPC_SEPOLIA',
  baseSepolia:     'RPC_BASE_SEPOLIA',
  arbitrumSepolia: 'RPC_ARB_SEPOLIA',
  optimismSepolia: 'RPC_OP_SEPOLIA',
  polygonAmoy:     'RPC_POLYGON_AMOY',
  avalancheFuji:   'RPC_AVAX_FUJI',
  unichainSepolia: 'RPC_UNI_SEPOLIA',
};

export function getRpcUrl(env, arcChainKey) {
  const envKey = ENV_KEY[arcChainKey];
  if (envKey && env[envKey]) return env[envKey];
  return PUBLIC_RPC[arcChainKey] || null;
}
