/**
 * verify-aggregator-live.js — READ-ONLY EIP-1967 + recent swap() calldata check.
 * Never sends a transaction.
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { makeProvider } from '../src/provider.js';
import {
  AGGREGATOR_PROXY,
  AGGREGATOR_EXPECTED_IMPL,
  AGGREGATOR_SWAP_ABI,
  EIP1967_IMPL_SLOT,
  FEE_RATE_ABI,
  VERIFIED_SWAP_TYPES,
} from '../src/routes/constants.js';
import { initAggregator, getAggregatorStatus } from '../src/routes/aggregator.js';

const SAMPLE_TXS = [
  // Fill from prior forensic notes if still present; extra txs discovered live are appended.
];

const provider = makeProvider();
const proxy = ethers.getAddress(AGGREGATOR_PROXY);
const slot = await provider.getStorage(proxy, EIP1967_IMPL_SLOT);
const impl = ethers.getAddress('0x' + slot.slice(-40));
const implCode = await provider.getCode(impl);
const proxyCode = await provider.getCode(proxy);
await initAggregator(provider);
const st = getAggregatorStatus();

let feeRate = null;
try {
  feeRate = await new ethers.Contract(proxy, FEE_RATE_ABI, provider).feeRate();
} catch (e) {
  feeRate = 'unreadable: ' + e.message;
}

console.log('Proxy:', proxy);
console.log('EIP-1967 slot:', EIP1967_IMPL_SLOT);
console.log('Current implementation:', impl);
console.log('Previous expected implementation:', ethers.getAddress(AGGREGATOR_EXPECTED_IMPL));
console.log('Implementation bytecode:', implCode && implCode !== '0x' ? ('present (' + implCode.length + ' chars)') : 'MISSING');
console.log('Proxy bytecode:', proxyCode && proxyCode !== '0x' ? ('present (' + proxyCode.length + ' chars)') : 'MISSING');
console.log('Selector:', '0x4d819a2a');
console.log('Verified swap types:', Object.keys(VERIFIED_SWAP_TYPES).join(', '));
console.log('feeRate():', feeRate?.toString?.() ?? feeRate);
console.log('Fee source (initAggregator):', st.feeSource, 'bps', st.feeBps);
console.log('Collector (observed-only):', st.feeCollector);
console.log('Startup validated:', st.validated);

const iface = new ethers.Interface(AGGREGATOR_SWAP_ABI);
const head = await provider.getBlockNumber();
console.log('Head block:', head);

// Bounded recent-block scan for successful ETH-in swap() txs (no Blockscout).
const lookback = Math.min(40, head);
const seen = [];
for (let b = head; b > head - lookback && seen.length < 6; b--) {
  const block = await provider.getBlock(b, true);
  const txs = (block?.prefetchedTransactions?.length ? block.prefetchedTransactions : []);
  for (const tx of txs) {
    if (!tx?.to || tx.to.toLowerCase() !== AGGREGATOR_PROXY) continue;
    if (!tx.data || !tx.data.startsWith('0x4d819a2a')) continue;
    if (tx.value == null || BigInt(tx.value) === 0n) continue;
    const rcpt = await provider.getTransactionReceipt(tx.hash);
    if (!rcpt || rcpt.status !== 1) continue;
    let decoded;
    try {
      decoded = iface.decodeFunctionData('swap', tx.data);
    } catch (e) {
      console.log('decode failed', tx.hash, e.message);
      continue;
    }
    const types = [...decoded[0]].map((d) => Number(d.swapType));
    seen.push({
      hash: tx.hash,
      value: tx.value.toString(),
      amountIn: decoded[2].toString(),
      minReturn: decoded[3].toString(),
      feeToken: decoded[1],
      types,
    });
    if (seen.length >= 6) break;
  }
}

console.log('Recent successful ETH-in swap txs in last', lookback, 'blocks:', seen.length);
for (const s of seen) {
  console.log(' ', s.hash, 'types', s.types.join('+'), 'value==amountIn', s.value === s.amountIn, 'feeToken', s.feeToken);
}

if (!seen.length) {
  console.log('No recent ETH-in aggregator txs in lookback — encoder compatibility inferred from ABI + historical tests.');
}
