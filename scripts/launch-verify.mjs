/**
 * launch-verify.mjs — read-only on-chain verification for historical launches.
 * Uses exact tx/receipt replay (no wide log scans for detector validation).
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { writeFileSync } from 'fs';
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
} from '../src/chainwatchlist.js';
import { quoteBuy, checkSellable, WETH, UNIVERSAL_ROUTER } from '../src/swap.js';

const provider = makeProvider();
const settings = { chainWatchlist: defaultChainWatchlist() };
const watch = enabledWatchSet(settings);
const exclude = new Set([WETH.toLowerCase()]);

const TOKENS = {
  DERP: '0x6543b7746ca744c4bb2198191e71f40ff04c41b9',
  MANCER: '0xc72f232a6869e6cf34dc06129affd07f8a2a246a',
  WALL: '0xb03058b8a39f3967df08d833682c1c99b29821b1',
  STRIKE: '0x5aed379a72bd2533371d153135c47d5eb61babc8',
  YARD: '0xe3fa12da7fa026b21817f16622e8ae48fa785166',
};

const TRANSFER = ethers.id('Transfer(address,address,uint256)').toLowerCase();
const SWAP_V3 = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)').toLowerCase();
const POOL_CREATED_V3 = ethers.id('PoolCreated(address,address,uint24,int24,address)').toLowerCase();
const PAIR_CREATED_V2 = ethers.id('PairCreated(address,address,address,uint256)').toLowerCase();

function ser(obj) {
  return JSON.parse(JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

async function findDeployBlock(addr) {
  const head = await provider.getBlockNumber();
  let lo = 0;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await provider.getCode(addr, mid);
    if (code && code !== '0x') hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

async function scanBlockForToken(addr, blockNumber) {
  const block = await provider.getBlock(blockNumber, true);
  for (const tx of block.transactions) {
    if (typeof tx === 'string') continue;
    const rc = await provider.getTransactionReceipt(tx.hash);
    if (rc?.contractAddress?.toLowerCase() === addr) {
      return { tx, receipt: rc, blockNumber, kind: 'direct-deploy' };
    }
    const cands = extractCandidatesFromReceipt(rc, { excludeAddresses: exclude });
    if (cands.some((c) => c.contract.toLowerCase() === addr)) {
      return { tx, receipt: rc, blockNumber, kind: 'mint-or-factory' };
    }
  }
  return null;
}

async function findLaunchTx(addr) {
  const deployBlock = await findDeployBlock(addr);
  for (let b = deployBlock; b <= deployBlock + 10; b++) {
    const hit = await scanBlockForToken(addr, b);
    if (hit) return { ...hit, deployBlock };
  }
  for (let b = deployBlock; b >= Math.max(0, deployBlock - 30); b--) {
    const block = await provider.getBlock(b, true);
    for (const tx of block.transactions) {
      if (typeof tx === 'string') continue;
      if (!txTouchesWatch(tx, watch)) continue;
      const rc = await provider.getTransactionReceipt(tx.hash);
      const cands = extractCandidatesFromReceipt(rc, { excludeAddresses: exclude });
      if (cands.some((c) => c.contract.toLowerCase() === addr)) {
        return { tx, receipt: rc, blockNumber: b, deployBlock, kind: 'watched-tx' };
      }
    }
  }
  return { deployBlock, tx: null, receipt: null, kind: 'not-found' };
}

/** Collect unique counterparties and event signatures from receipt logs. */
function summarizeReceipt(receipt) {
  const topics = new Set();
  const addresses = new Set();
  const events = [];
  for (const lg of receipt?.logs || []) {
    addresses.add(lg.address.toLowerCase());
    const t0 = (lg.topics?.[0] || '').toLowerCase();
    topics.add(t0);
    events.push({
      address: lg.address.toLowerCase(),
      topic0: t0,
      topicCount: lg.topics?.length || 0,
    });
  }
  return { logCount: receipt?.logs?.length || 0, addresses: [...addresses], events };
}

/** Find earliest tx touching token via 10-block getLogs windows (routing only). */
async function findEarlyTokenActivity(addr, fromBlock, maxBlocks = 2000) {
  const end = Math.min(fromBlock + maxBlocks, await provider.getBlockNumber());
  const txs = new Map();
  for (let start = fromBlock; start <= end; start += 10) {
    const to = Math.min(start + 9, end);
    let logs;
    try {
      logs = await provider.getLogs({
        fromBlock: start,
        toBlock: to,
        address: addr,
        topics: [TRANSFER],
      });
    } catch {
      continue;
    }
    for (const lg of logs) txs.set(lg.transactionHash, lg.blockNumber);
    if (txs.size >= 8) break;
  }
  return [...txs.entries()].map(([hash, block]) => ({ hash, block }));
}

async function analyzeTradeTx(txHash) {
  const tx = await provider.getTransaction(txHash);
  const receipt = await provider.getTransactionReceipt(txHash);
  const summary = summarizeReceipt(receipt);
  const routerHits = [];
  const poolHits = [];
  for (const lg of receipt?.logs || []) {
    const t0 = (lg.topics?.[0] || '').toLowerCase();
    if (t0 === SWAP_V3) {
      poolHits.push({ pool: lg.address.toLowerCase(), kind: 'uniswap-v3-swap-event' });
    }
    if (t0 === POOL_CREATED_V3) {
      poolHits.push({
        factory: lg.address.toLowerCase(),
        kind: 'uniswap-v3-pool-created',
        data: lg.data,
      });
    }
    if (t0 === PAIR_CREATED_V2) {
      poolHits.push({ factory: lg.address.toLowerCase(), kind: 'v2-pair-created' });
    }
  }
  if (tx?.to?.toLowerCase() === UNIVERSAL_ROUTER) {
    routerHits.push({ router: UNIVERSAL_ROUTER, kind: 'universal-router-v4-path' });
  }
  return {
    txFrom: tx?.from?.toLowerCase() || null,
    txTo: tx?.to?.toLowerCase() || null,
    txValue: tx?.value?.toString() || '0',
    summary,
    routerHits,
    poolHits,
  };
}

async function simulateExecuteBuy(provider, quote, spendWei) {
  const { encodeV4Swap } = await import('../src/swap.js');
  const { minOutWei } = await import('../src/swaprules.js');
  const amountOutMin = minOutWei(quote.amountOut, 5);
  const { commands, inputs } = encodeV4Swap({
    poolKey: quote.poolKey,
    zeroForOne: quote.zeroForOne,
    amountIn: spendWei,
    amountOutMin,
  });
  const router = new ethers.Contract(
    UNIVERSAL_ROUTER,
    ['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'],
    provider,
  );
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
  const data = router.interface.encodeFunctionData('execute', [commands, inputs, deadline]);
  const txReq = {
    to: UNIVERSAL_ROUTER,
    data,
    value: spendWei,
    from: '0x24921b27b43d802c7d1496f7259d1d0c2266f50c',
  };
  try {
    await provider.call(txReq);
    return { simOk: true };
  } catch (e) {
    return { simOk: false, error: e.shortMessage || e.message };
  }
}

const out = [];
for (const [name, addr] of Object.entries(TOKENS)) {
  const launch = await findLaunchTx(addr);
  let watchMatch = null;
  let extraction = [];
  let pass = false;
  if (launch.tx) {
    watchMatch = matchedWatchSide(launch.tx, watch);
    extraction = extractCandidatesFromReceipt(launch.receipt, { excludeAddresses: exclude });
    pass = extraction.some((c) => c.contract.toLowerCase() === addr);
  }

  const spend = ethers.parseEther('0.01');
  const quote = await quoteBuy(provider, addr, spend);
  const sell = quote
    ? await checkSellable(provider, addr, quote.amountOut)
    : { checked: false, sellable: false, reason: 'no quote' };
  const sim = quote ? await simulateExecuteBuy(provider, quote, spend) : { simOk: false, error: 'no quote' };

  const early = launch.deployBlock
    ? await findEarlyTokenActivity(addr, launch.deployBlock)
    : [];
  const tradeAnalysis = [];
  for (const t of early.slice(0, 5)) {
    tradeAnalysis.push({ ...t, ...(await analyzeTradeTx(t.hash)) });
  }

  // Also analyze launch receipt itself for pool creation
  const launchReceiptSummary = launch.receipt ? summarizeReceipt(launch.receipt) : null;

  out.push({
    name,
    addr,
    deployBlock: launch.deployBlock,
    launchKind: launch.kind,
    launchTx: launch.tx?.hash || null,
    launchBlock: launch.blockNumber || null,
    txFrom: launch.tx?.from?.toLowerCase() || null,
    txTo: launch.tx?.to?.toLowerCase() || null,
    receiptContractAddress: launch.receipt?.contractAddress?.toLowerCase() || null,
    watchMatched: Boolean(watchMatch),
    watchSide: watchMatch?.side || null,
    watchAddress: watchMatch
      ? findWatchEntry(settings, watchMatch.address)?.address?.toLowerCase()
      : null,
    watchRole: watchMatch ? findWatchEntry(settings, watchMatch.address)?.role : null,
    extraction,
    pass,
    launchReceiptSummary,
    v4Quote: quote
      ? { fee: quote.fee, amountOut: quote.amountOut.toString(), priceImpactPct: quote.priceImpactPct }
      : null,
    v4Sellable: ser(sell),
    v4Simulate: sim,
    earlyActivity: early,
    tradeAnalysis,
  });
}

writeFileSync('scripts/launch-verify-output.json', JSON.stringify(ser(out), null, 2));
console.log('Wrote scripts/launch-verify-output.json');
for (const r of out) {
  console.log(
    `${r.name}: launch=${r.launchTx?.slice(0, 14) || 'NONE'} watch=${r.watchMatched} pass=${r.pass} v4=${Boolean(r.v4Quote)} sim=${r.v4Simulate?.simOk}`,
  );
}
