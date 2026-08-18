/**
 * launch-replay.mjs — exact-tx historical replay + routing forensics.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { ethers } from 'ethers';
import { makeProvider } from '../src/provider.js';
import {
  extractCandidatesFromReceipt,
  extractDirectDeploy,
  extractMintFromZeroLogs,
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

const LAUNCHES = {
  DERP: {
    ca: '0x6543b7746ca744c4bb2198191e71f40ff04c41b9',
    mintTx: '0x64fdf1925d0a6ab50df04052fdadb00e5f96e63bd39f558e2cf37b4f74a67cd4',
  },
  MANCER: {
    ca: '0xc72f232a6869e6cf34dc06129affd07f8a2a246a',
    mintTx: '0x9a6d78c155fc550083f11b7e5368a6afbf7d62deb0ab012d4980bbe31b2eb340',
  },
  WALL: {
    ca: '0xb03058b8a39f3967df08d833682c1c99b29821b1',
    mintTx: '0xee790e8e1c934dc927a53225854c1fba78a0e7c11a0743f3e9a1ff4b272ed845',
  },
  STRIKE: {
    ca: '0x5aed379a72bd2533371d153135c47d5eb61babc8',
    mintTx: '0x722ff11632f289f94b6add4e36151650ea2ea493307ef99efc31352d768e37b0',
  },
  YARD: {
    ca: '0xe3fa12da7fa026b21817f16622e8ae48fa785166',
    mintTx: '0x97866b98485b94528bbe3752dc3e986af14f1d1c69386a4345d0fae3dcd46985',
  },
};

const TOPICS = {
  TRANSFER: ethers.id('Transfer(address,address,uint256)').toLowerCase(),
  SWAP_V3: ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)').toLowerCase(),
  POOL_CREATED_V3: ethers.id('PoolCreated(address,address,uint24,int24,address)').toLowerCase(),
  PAIR_CREATED_V2: ethers.id('PairCreated(address,address,address,uint256)').toLowerCase(),
  SYNC_V2: ethers.id('Sync(uint112,uint112)').toLowerCase(),
  INITIALIZE_V3: ethers.id('Initialize(uint160,int24)').toLowerCase(),
};

function ser(v) {
  return JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

function decodeTopicAddress(topic) {
  if (!topic || topic.length < 66) return null;
  return ('0x' + topic.slice(26)).toLowerCase();
}

function analyzeLogs(receipt) {
  const out = [];
  for (const lg of receipt.logs || []) {
    const t0 = (lg.topics[0] || '').toLowerCase();
    const row = {
      logIndex: lg.index,
      address: lg.address.toLowerCase(),
      topic0: t0,
    };
    if (t0 === TOPICS.POOL_CREATED_V3) {
      row.kind = 'UniswapV3-PoolCreated';
      row.token0 = decodeTopicAddress(lg.topics[1]);
      row.token1 = decodeTopicAddress(lg.topics[2]);
      row.fee = Number(BigInt(lg.topics[3]));
    } else if (t0 === TOPICS.PAIR_CREATED_V2) {
      row.kind = 'V2-PairCreated';
      row.token0 = decodeTopicAddress(lg.topics[1]);
      row.token1 = decodeTopicAddress(lg.topics[2]);
      row.pair = decodeTopicAddress(lg.data.slice(0, 66));
    } else if (t0 === TOPICS.SWAP_V3) {
      row.kind = 'UniswapV3-Swap';
    } else if (t0 === TOPICS.INITIALIZE_V3) {
      row.kind = 'UniswapV3-Initialize';
    } else if (t0 === TOPICS.TRANSFER && lg.topics[1]?.toLowerCase() === ethers.zeroPadValue('0x00', 32).toLowerCase()) {
      row.kind = 'ERC20-MintFromZero';
      row.to = decodeTopicAddress(lg.topics[2]);
    }
    out.push(row);
  }
  return out;
}

async function simulateV4(provider, quote, spendWei) {
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
  try {
    await provider.call({ to: UNIVERSAL_ROUTER, data, value: spendWei, from: '0x24921b27b43d802c7d1496f7259d1d0c2266f50c' });
    return true;
  } catch (e) {
    return e.shortMessage || e.message;
  }
}

/** Find first swap/pool tx after mint using 10-block windows (routing forensics only). */
async function findFirstLiquidityTx(token, fromBlock) {
  const end = fromBlock + 5000;
  for (let start = fromBlock; start <= end; start += 10) {
    const to = Math.min(start + 9, end);
    let logs = [];
    try {
      logs = await provider.getLogs({
        fromBlock: start,
        toBlock: to,
        topics: [[TOPICS.SWAP_V3, TOPICS.PAIR_CREATED_V2, TOPICS.POOL_CREATED_V3, TOPICS.INITIALIZE_V3]],
      });
    } catch {
      continue;
    }
    for (const lg of logs) {
      const t0 = lg.topics[0].toLowerCase();
      const tokenL = token.toLowerCase();
      const wethL = WETH.toLowerCase();
      let touches = false;
      if (t0 === TOPICS.POOL_CREATED_V3 || t0 === TOPICS.PAIR_CREATED_V2) {
        const t0a = decodeTopicAddress(lg.topics[1]);
        const t1a = decodeTopicAddress(lg.topics[2]);
        touches = [t0a, t1a].includes(tokenL) || [t0a, t1a].includes(wethL);
      } else if (t0 === TOPICS.SWAP_V3 || t0 === TOPICS.INITIALIZE_V3) {
        // verify token involvement via receipt logs
        const rc = await provider.getTransactionReceipt(lg.transactionHash);
        touches = rc.logs.some((x) => x.address.toLowerCase() === tokenL);
      }
      if (touches) return lg.transactionHash;
    }
  }
  return null;
}

async function analyzeTx(txHash) {
  const tx = await provider.getTransaction(txHash);
  const receipt = await provider.getTransactionReceipt(txHash);
  return { tx, receipt, logs: analyzeLogs(receipt) };
}

const report = [];
for (const [name, { ca, mintTx }] of Object.entries(LAUNCHES)) {
  const { tx, receipt, logs } = await analyzeTx(mintTx);
  const watchMatch = matchedWatchSide(tx, watch);
  const entry = watchMatch ? findWatchEntry(settings, watchMatch.address) : null;
  const extracted = extractCandidatesFromReceipt(receipt, { excludeAddresses: exclude });
  const pathA = extractDirectDeploy(receipt);
  const pathB = extractMintFromZeroLogs(receipt, { excludeAddresses: exclude });
  const pass = extracted.some((c) => c.contract.toLowerCase() === ca.toLowerCase());

  const spend = ethers.parseEther('0.01');
  const quote = await quoteBuy(provider, ca, spend);
  const sell = quote ? await checkSellable(provider, ca, quote.amountOut) : null;
  const sim = quote ? await simulateV4(provider, quote, spend) : null;

  const liqTx = await findFirstLiquidityTx(ca, receipt.blockNumber);
  let liq = null;
  if (liqTx) liq = await analyzeTx(liqTx);

  report.push({
    name,
    ca: ca.toLowerCase(),
    mintTx,
    blockNumber: receipt.blockNumber,
    txFrom: tx.from.toLowerCase(),
    txTo: tx.to?.toLowerCase() || null,
    txValue: tx.value.toString(),
    receiptContractAddress: receipt.contractAddress?.toLowerCase() || null,
    watchMatched: Boolean(watchMatch),
    watchSide: watchMatch?.side || null,
    watchAddress: entry?.address?.toLowerCase() || null,
    watchRole: entry?.role || null,
    pathA,
    pathB: pathB.filter((c) => c.contract.toLowerCase() === ca.toLowerCase()),
    extracted,
    pass,
    launchLogs: logs.filter((l) => l.kind || l.topic0 === TOPICS.TRANSFER),
    v4Quote: quote ? { fee: quote.fee, amountOut: quote.amountOut.toString() } : null,
    v4Sellable: sell,
    v4Simulate: sim,
    firstLiquidityTx: liqTx,
    firstLiquidity: liq
      ? {
          txFrom: liq.tx.from.toLowerCase(),
          txTo: liq.tx.to?.toLowerCase() || null,
          txValue: liq.tx.value.toString(),
          logs: liq.logs.filter((l) => l.kind),
        }
      : null,
  });
}

writeFileSync('scripts/launch-replay-output.json', JSON.stringify(ser(report), null, 2));
console.log(JSON.stringify(report.map((r) => ({
  token: r.name,
  pass: r.pass,
  watch: r.watchMatched,
  method: r.extracted[0]?.method,
  v4: Boolean(r.v4Quote),
  liqTx: r.firstLiquidityTx?.slice(0, 18),
})), null, 2));
