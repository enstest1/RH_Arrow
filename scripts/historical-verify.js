/**
 * historical-verify.js — READ-ONLY validation using exact launch tx hashes.
 * No wallet, no buys, no wide eth_getLogs scans.
 *
 * Usage: node scripts/historical-verify.js
 */
import 'dotenv/config';
import {
  extractCandidatesFromReceipt,
  txTouchesWatch,
  matchedWatchSide,
} from '../src/candidateextract.js';
import {
  defaultChainWatchlist,
  enabledWatchSet,
  findWatchEntry,
  normAddr,
} from '../src/chainwatchlist.js';
import { makeProvider } from '../src/provider.js';
import { tokenMeta } from '../src/swap.js';

/** Exact launch txs verified in prior replay (no log-range guessing). */
const TARGETS = [
  {
    name: 'DERP',
    token: '0x6543b7746Ca744C4bb2198191E71F40fF04C41B9',
    txHash: '0x64fdf1925d0a6ab50df04052fdadb00e5f96e63bd39f558e2cf37b4f74a67cd4',
  },
  {
    name: 'MANCER',
    token: '0xc72F232a6869e6CF34dC06129AfFD07F8a2a246A',
    txHash: '0x9a6d78c155fc550083f11b7e5368a6afbf7d62deb0ab012d4980bbe31b2eb340',
  },
  {
    name: 'WALL',
    token: '0xB03058B8A39f3967DF08d833682C1c99b29821B1',
    txHash: '0xee790e8e1c934dc927a53225854c1fba78a0e7c11a0743f3e9a1ff4b272ed845',
  },
  {
    name: 'STRIKE',
    token: '0x5aeD379A72BD2533371d153135c47d5EB61BaBc8',
    txHash: '0x722ff11632f289f94b6add4e36151650ea2ea493307ef99efc31352d768e37b0',
  },
  {
    name: 'YARD',
    token: '0xE3FA12dA7fa026B21817f16622E8AE48fA785166',
    txHash: '0x97866b98485b94528bbe3752dc3e986af14f1d1c69386a4345d0fae3dcd46985',
  },
];

const settings = { chainWatchlist: defaultChainWatchlist() };
const watch = enabledWatchSet(settings);
const weth = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

/**
 * Replay one historical launch tx through the same detector path as live scanner.
 * @param {import('ethers').JsonRpcProvider} provider
 * @param {{ name: string, token: string, txHash: string }} t
 */
async function verifyOne(provider, t) {
  const row = { token: t.name, detected: false, method: '', reason: '', txHash: t.txHash };
  const token = normAddr(t.token);
  if (!token) {
    row.reason = 'invalid token address';
    return row;
  }

  const tx = await provider.getTransaction(t.txHash);
  const receipt = await provider.getTransactionReceipt(t.txHash);
  if (!tx || !receipt) {
    row.reason = 'Tx/receipt unavailable (check RPC URL)';
    return row;
  }

  if (!txTouchesWatch(tx, watch)) {
    row.reason = 'Tx does not touch seeded watch list';
    return row;
  }

  const match = matchedWatchSide(tx, watch);
  const entry = findWatchEntry(settings, match?.address);
  const candidates = extractCandidatesFromReceipt(receipt, { excludeAddresses: new Set([weth]) });
  const hit = candidates.find((c) => c.contract.toLowerCase() === token.toLowerCase());

  if (hit) {
    row.detected = true;
    row.method = hit.method + ' via ' + (entry?.label || match?.address || 'watch');
    try {
      const meta = await tokenMeta(provider, token);
      row.symbol = meta.symbol;
    } catch {
      /* symbol optional */
    }
  } else {
    row.reason = 'Receipt parsed but token not in extracted candidates';
  }
  return row;
}

const provider = makeProvider();
console.log('Historical verification — exact launch txs (read-only)\n');

let pass = 0;
for (const t of TARGETS) {
  const r = await verifyOne(provider, t);
  const status = r.detected ? 'PASS' : 'FAIL';
  if (r.detected) pass += 1;
  console.log(t.name, status);
  console.log('  tx:', r.txHash);
  if (r.detected) {
    console.log('  matched:', r.method);
    console.log('  result:', t.token);
    if (r.symbol) console.log('  symbol:', r.symbol);
  } else {
    console.log('  reason:', r.reason);
  }
  console.log('');
}

console.log(`Summary: ${pass}/${TARGETS.length} PASS`);
process.exit(pass === TARGETS.length ? 0 : 1);
