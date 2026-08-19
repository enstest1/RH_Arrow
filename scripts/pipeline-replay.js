/**
 * pipeline-replay.js — READ-ONLY full-path verification.
 *
 * historical tx → watch match → receipt extract → metadata → route discovery → simulation
 * Never sends a transaction.
 *
 * Usage: node scripts/pipeline-replay.js
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { makeProvider } from '../src/provider.js';
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
import { tokenMeta } from '../src/swap.js';
import { evaluateTargetSymbol } from '../src/swaprules.js';
import { initAggregator, getAggregatorStatus, simulateAggregatorSwap } from '../src/routes/aggregator.js';
import { discoverBestBuyRoute, executeRoute } from '../src/routes/index.js';
import { listAggregatorDescriptorSets } from '../src/routes/poolDiscovery.js';
import { SWAP_TYPE, USDG, WETH } from '../src/routes/constants.js';

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

const settings = { chainWatchlist: defaultChainWatchlist(), targetSymbol: 'CLOCKIN' };
const watch = enabledWatchSet(settings);
const weth = (process.env.WETH_ADDRESS || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73').toLowerCase();
const amountIn = ethers.parseEther(process.env.PIPELINE_SPEND_ETH || '0.01');

function yn(ok) {
  return ok ? 'PASS' : 'FAIL';
}

async function replayOne(provider, t) {
  const row = {
    name: t.name,
    detect: false,
    candidate: false,
    symbol: false,
    symbolName: '',
    clockinGate: false,
    route: 'none',
    simulation: false,
    reason: '',
  };
  const token = normAddr(t.token);

  const tx = await provider.getTransaction(t.txHash);
  const receipt = await provider.getTransactionReceipt(t.txHash);
  if (!tx || !receipt) {
    row.reason = 'tx/receipt unavailable';
    return row;
  }

  row.detect = txTouchesWatch(tx, watch);
  const match = matchedWatchSide(tx, watch);
  const entry = match ? findWatchEntry(settings, match.address) : null;
  const extracted = extractCandidatesFromReceipt(receipt, { excludeAddresses: new Set([weth]) });
  const hit = extracted.find((c) => c.contract.toLowerCase() === token.toLowerCase());
  row.candidate = Boolean(hit);
  if (entry) row.reason = 'watch ' + (entry.label || entry.address);

  try {
    const meta = await tokenMeta(provider, token);
    row.symbolName = meta.symbol || '';
    row.symbol = Boolean(meta.symbol);
    row.clockinGate = evaluateTargetSymbol(settings, meta.symbol).ok;
  } catch (e) {
    row.reason = (row.reason ? row.reason + '; ' : '') + 'metadata: ' + e.message;
  }

  // Route/sim independently of CLOCKIN gate — historical tickers are not CLOCKIN.
  try {
    const route = await discoverBestBuyRoute({
      provider,
      token,
      amountIn,
      slippagePct: 15,
      source: {
        type: 'chain',
        address: entry?.address,
        role: entry?.role,
        txHash: t.txHash,
      },
      from: '0x0000000000000000000000000000000000000001',
    });
    if (!route) {
      row.route = 'none';
      return row;
    }
    row.route = route.venue + (route.metadata?.hops ? ' hops=' + route.metadata.hops : '');
    row.simulation = Boolean(route.simulation?.ok);
    row.swapTypes = (route.metadata?.swapTypes || []).join(' -> ');
    row.bridge = (route.descriptors || []).map((d) => d.tokenIn.slice(0, 6) + '->' + d.tokenOut.slice(0, 6)).join(' | ');
    if (t.name === 'STRIKE') {
      const sets = await listAggregatorDescriptorSets(provider, token, amountIn);
      row.directV3 = 'FAIL/REJECT AS EXPECTED';
      for (const set of sets) {
        const types = (set.descriptors || []).map((d) => d.swapType);
        const sim = await simulateAggregatorSwap(provider, {
          from: '0x0000000000000000000000000000000000000001',
          amountIn,
          minReturn: 1n,
          descriptors: set.descriptors,
          deadline: Math.floor(Date.now() / 1000) + 60,
        });
        if (types.length === 1 && types[0] === SWAP_TYPE.V3) {
          row.directV3 = sim.ok ? 'PASS (unexpected)' : 'FAIL/REJECT AS EXPECTED';
        }
        if (types[0] === SWAP_TYPE.V3 && types[1] === SWAP_TYPE.UP_V3) {
          const d0 = set.descriptors[0];
          const d1 = set.descriptors[1];
          if (d0.tokenIn.toLowerCase() === WETH && d0.tokenOut.toLowerCase() === USDG && d1.tokenOut.toLowerCase() === token.toLowerCase()) {
            row.bridgeRoute = 'WETH -> USDG -> STRIKE';
            row.swapTypes = types.join(' -> ');
          }
        }
      }
    }
    const dry = await executeRoute({
      route,
      wallet: { address: '0x0000000000000000000000000000000000000001' },
      provider,
      settings: { slippageTolerancePct: 15 },
      dryRun: true,
    });
    if (dry.sent === true) {
      row.reason = 'DRY-RUN unexpectedly marked sent — aborting';
      process.exitCode = 1;
    }
  } catch (e) {
    row.route = 'error';
    row.reason = (row.reason ? row.reason + '; ' : '') + (e.shortMessage || e.message);
  }
  return row;
}

const provider = makeProvider();
console.log('Full pipeline replay — READ-ONLY, no broadcast\n');
await initAggregator(provider);
const agg = getAggregatorStatus();
console.log('Aggregator proxy', agg.proxy);
console.log('Aggregator impl ', agg.implementation, agg.validated ? 'VERIFIED' : 'MISMATCH/DISABLED');
console.log('Fee', agg.feeRateRaw, agg.feeSource, agg.feeUnit);
console.log('');

const table = [];
for (const t of TARGETS) {
  const r = await replayOne(provider, t);
  table.push(r);
  console.log(t.name);
  if (t.name === 'STRIKE') {
    console.log('DETECTION      ' + yn(r.detect));
    console.log('CANDIDATE      ' + yn(r.candidate));
    console.log('DIRECT V3      ' + (r.directV3 || 'n/a'));
    console.log('BRIDGE ROUTE   ' + (r.bridgeRoute || r.route));
    console.log('SWAP TYPES     ' + (r.swapTypes || 'n/a'));
    console.log('SIMULATION     ' + yn(r.simulation));
  } else {
    console.log('Detection: ' + yn(r.detect));
    console.log('Candidate: ' + yn(r.candidate));
    console.log('Symbol: ' + yn(r.symbol) + (r.symbolName ? ' (' + r.symbolName + ')' : ''));
    console.log('CLOCKIN gate: ' + (r.clockinGate ? 'PASS' : 'FAIL (expected for historical tickers)'));
    console.log('Route: ' + r.route);
    console.log('Simulation: ' + yn(r.simulation));
  }
  if (r.reason) console.log('Note: ' + r.reason);
  console.log('');
}

console.log('TOKEN | DETECT | CANDIDATE | DISCOVERY | SIM');
for (const r of table) {
  const disc = r.name === 'STRIKE'
    ? (r.bridgeRoute || r.route)
    : r.route;
  console.log([r.name, yn(r.detect), yn(r.candidate), disc, yn(r.simulation)].join(' | '));
}

const detectPass = table.filter((r) => r.detect && r.candidate).length;
console.log('\nDetection+candidate: ' + detectPass + '/' + table.length);
console.log('Route+sim: ' + table.filter((r) => r.simulation).length + '/' + table.length);
process.exit(detectPass === table.length && table.every((r) => r.simulation) ? 0 : 1);
