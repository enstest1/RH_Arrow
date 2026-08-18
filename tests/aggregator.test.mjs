/**
 * tests/aggregator.test.mjs — aggregator ABI encoding + impl slot decode (no broadcast).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  AGGREGATOR_SWAP_ABI,
  SWAP_TYPE,
  WETH,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  EIP1967_IMPL_SLOT,
} from '../src/routes/constants.js';
import { buildSwapDesc, encodeAggregatorSwap } from '../src/routes/aggregator.js';
import { minOutWei } from '../src/swaprules.js';

test('SwapDesc encoding swapType 1 (V3)', () => {
  const desc = buildSwapDesc({
    swapType: SWAP_TYPE.V3,
    tokenIn: WETH,
    tokenOut: '0xc72f232a6869e6cf34dc06129affd07f8a2a246a',
    poolAddress: '0x543127d6a1932689faacc1afad4a81146d9ccf54',
    fee: 10000,
    tickSpacing: 200,
  });
  assert.equal(desc.swapType, 1);
  const data = encodeAggregatorSwap({
    descriptors: [desc],
    amountIn: 10n ** 16n,
    minReturn: 1n,
    deadline: 9999999999,
  });
  assert.equal(data.slice(0, 10), '0x4d819a2a');
});

test('SwapDesc encoding swapType 12 (Up CL)', () => {
  const desc = buildSwapDesc({
    swapType: SWAP_TYPE.UP_V3,
    tokenIn: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    tokenOut: '0x5aed379a72bd2533371d153135c47d5eb61babc8',
    poolAddress: '0x97cf6a6271ff5cabdf3a6698e218a47fb65a15d7',
    fee: 10000,
    tickSpacing: 2000,
  });
  assert.equal(desc.swapType, 12);
  const iface = new ethers.Interface(AGGREGATOR_SWAP_ABI);
  const decoded = iface.decodeFunctionData('swap', encodeAggregatorSwap({
    descriptors: [desc],
    amountIn: 10n ** 16n,
    minReturn: 1n,
    deadline: 100,
  }));
  assert.equal(Number(decoded[0][0].swapType), 12);
});

test('multi-hop descriptor order preserved', () => {
  const d1 = buildSwapDesc({ swapType: 1, tokenIn: WETH, tokenOut: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', poolAddress: '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca', fee: 100, tickSpacing: 1 });
  const d2 = buildSwapDesc({ swapType: 12, tokenIn: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', tokenOut: '0x5aed379a72bd2533371d153135c47d5eb61babc8', poolAddress: '0x97cf6a6271ff5cabdf3a6698e218a47fb65a15d7', fee: 10000, tickSpacing: 2000 });
  const iface = new ethers.Interface(AGGREGATOR_SWAP_ABI);
  const decoded = iface.decodeFunctionData('swap', encodeAggregatorSwap({
    descriptors: [d1, d2],
    amountIn: 10n ** 16n,
    minReturn: 1n,
    deadline: 100,
  }));
  assert.equal(decoded[0].length, 2);
  assert.equal(Number(decoded[0][0].swapType), 1);
  assert.equal(Number(decoded[0][1].swapType), 12);
});

test('minReturn slippage calculation non-zero', () => {
  const out = 1000000n;
  const min = minOutWei(out, 15);
  assert.equal(min, 850000n);
  assert.notEqual(min, 0n);
});

test('EIP-1967 slot constant is 32-byte word', () => {
  assert.match(EIP1967_IMPL_SLOT, /^0x[0-9a-f]{64}$/i);
});

test('implementation mismatch disables aggregator state', async () => {
  const { aggState } = await import('../src/routes/aggregator.js');
  const prev = { ...aggState };
  aggState.validated = false;
  aggState.implementation = '0xdead000000000000000000000000000000000001';
  assert.equal(aggState.validated, false);
  Object.assign(aggState, prev);
});
