/**
 * Local decode of immutable aggregator fixtures. No RPC, no broadcast.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAggregatorSwap, decodeAggregatorSwap, buildSwapDesc } from '../src/routes/aggregator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(path.join(here, '..', 'fixtures', 'aggregator-txs.json'), 'utf8'));

test('fixture file names proxy, selector, and type 1 on-chain success', () => {
  assert.equal(fixtures.proxy.toLowerCase(), '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc');
  assert.equal(fixtures.selector, '0x4d819a2a');
  const t1 = fixtures.transactions.find((t) => t.id === 'type1-eth-in-pons');
  assert.equal(t1.kind, 'on-chain-success');
  assert.equal(t1.success, true);
  assert.equal(t1.swapTypes[0], 1);
  assert.equal(t1.block, 39445351);
});

test('type 1 fixture descriptors round-trip through current encoder/decoder', () => {
  const t1 = fixtures.transactions.find((t) => t.id === 'type1-eth-in-pons');
  const data = encodeAggregatorSwap({
    descriptors: t1.descriptors.map(buildSwapDesc),
    amountIn: BigInt(t1.outer.amountIn),
    minReturn: 1n,
    deadline: 1,
  });
  assert.equal(data.slice(0, 10), fixtures.selector);
  const decoded = decodeAggregatorSwap(data);
  assert.equal(decoded.selector, '0x4d819a2a');
  assert.equal(decoded.amountIn, t1.outer.amountIn);
  assert.equal(decoded.feeToken, t1.outer.feeToken);
  assert.equal(decoded.descriptors[0].swapType, 1);
  assert.equal(decoded.descriptors[0].poolAddress, t1.descriptors[0].poolAddress);
});

test('type 12 is documented as live eth_call, not a standalone historical tx', () => {
  const t12 = fixtures.transactions.find((t) => t.id === 'type12-strike-eth-call');
  assert.equal(t12.kind, 'live-eth-call-simulation');
  assert.equal(t12.txHash, null);
  assert.deepEqual(t12.swapTypes, [1, 12]);
  const data = encodeAggregatorSwap({
    descriptors: t12.descriptors.map(buildSwapDesc),
    amountIn: 10n ** 16n,
    minReturn: 1n,
    deadline: 1,
  });
  const decoded = decodeAggregatorSwap(data);
  assert.equal(decoded.descriptors.length, 2);
  assert.equal(decoded.descriptors[0].swapType, 1);
  assert.equal(decoded.descriptors[1].swapType, 12);
  assert.equal(decoded.descriptors[1].poolAddress, t12.descriptors[1].poolAddress);
});
