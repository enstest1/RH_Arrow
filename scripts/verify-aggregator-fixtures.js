/**
 * verify-aggregator-fixtures.js — READ-ONLY fetch of known hashes + decoder check.
 * Never broadcasts.
 *
 * Usage: node scripts/verify-aggregator-fixtures.js
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProvider } from '../src/provider.js';
import { decodeAggregatorSwap } from '../src/routes/aggregator.js';
import { AGGREGATOR_PROXY } from '../src/routes/constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(path.join(here, '..', 'fixtures', 'aggregator-txs.json'), 'utf8'));

const provider = makeProvider();
let failed = 0;

for (const fx of fixtures.transactions) {
  if (fx.kind !== 'on-chain-success' || !fx.txHash) {
    console.log(fx.id + ': SKIP live fetch (' + fx.kind + ') — ' + (fx.note || ''));
    continue;
  }
  const tx = await provider.getTransaction(fx.txHash);
  const rcpt = await provider.getTransactionReceipt(fx.txHash);
  if (!tx || !rcpt) {
    console.log(fx.id + ': FAIL tx/receipt missing');
    failed += 1;
    continue;
  }
  const okStatus = Number(rcpt.status) === 1;
  const to = String(tx.to || '').toLowerCase();
  const value = tx.value.toString();
  const selector = String(tx.data).slice(0, 10).toLowerCase();
  const decoded = decodeAggregatorSwap(tx.data);
  const types = decoded.descriptors.map((d) => d.swapType);
  const checks = [
    ['to', to === AGGREGATOR_PROXY],
    ['selector', selector === fixtures.selector],
    ['value', value === fx.value],
    ['amountIn', decoded.amountIn === fx.outer.amountIn],
    ['feeToken', decoded.feeToken === fx.outer.feeToken],
    ['swapTypes', JSON.stringify(types) === JSON.stringify(fx.swapTypes)],
    ['pool', decoded.descriptors[0].poolAddress === fx.descriptors[0].poolAddress],
    ['success', okStatus === true],
    ['block', Number(tx.blockNumber) === fx.block],
  ];
  const bad = checks.filter((c) => !c[1]).map((c) => c[0]);
  if (bad.length) {
    failed += 1;
    console.log(fx.id + ': FAIL ' + bad.join(','));
  } else {
    console.log(fx.id + ': PASS ' + fx.txHash + ' types ' + types.join(' -> '));
  }
  console.log('  block=' + tx.blockNumber + ' value=' + value + ' amountIn=' + decoded.amountIn);
  console.log('  descs=' + JSON.stringify(decoded.descriptors.map((d) => ({
    swapType: d.swapType,
    tokenIn: d.tokenIn,
    tokenOut: d.tokenOut,
    poolAddress: d.poolAddress,
    fee: d.fee,
    tickSpacing: d.tickSpacing,
  }))));
}

console.log(failed ? ('FIXTURE VERIFY FAIL ' + failed) : 'FIXTURE VERIFY PASS');
process.exit(failed ? 1 : 0);
