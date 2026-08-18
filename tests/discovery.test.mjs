/**
 * Token-address → pool discovery → descriptors → calldata → simulation.
 * Uses in-memory historical pool map; never broadcasts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { discoverAggregatorDescriptors } from '../src/routes/poolDiscovery.js';
import { encodeAggregatorSwap, initAggregator, isAggregatorEnabled, aggState } from '../src/routes/aggregator.js';
import { discoverBestBuyRoute } from '../src/routes/index.js';
import { SWAP_TYPE, USDG, WETH, VERIFIED_SWAP_TYPES } from '../src/routes/constants.js';
import {
  makeDiscoveryProvider,
  MANCER,
  MANCER_POOL,
  STRIKE,
  STRIKE_UPCL,
  WETH_USDG,
} from './helpers/mockrpc.mjs';
import { V4_QUOTER } from '../src/swap.js';

test('unsupported aggregator swap type 27 is fail-closed', () => {
  assert.equal(VERIFIED_SWAP_TYPES[27], undefined);
  assert.throws(() => encodeAggregatorSwap({
    descriptors: [{
      swapType: 27,
      tokenIn: WETH,
      tokenOut: MANCER,
      poolAddress: MANCER_POOL,
      fee: 10000,
      tickSpacing: 200,
    }],
    amountIn: 10n ** 16n,
    minReturn: 1n,
    deadline: 100,
  }), /unsupported_swap_type/);
});

test('aggregator implementation mismatch disables execution', async () => {
  const provider = makeDiscoveryProvider({
    impl: '0x20a9d3a9be51e2a36c2943c55ebd6f934d197551',
  });
  const st = await initAggregator(provider);
  assert.equal(st.validated, false);
  assert.equal(isAggregatorEnabled(), false);
  assert.equal(st.implementation, '0x20a9d3a9be51e2a36c2943c55ebd6f934d197551');
});

test('aggregator implementation match enables execution', async () => {
  const provider = makeDiscoveryProvider();
  const st = await initAggregator(provider);
  assert.equal(st.validated, true);
  assert.equal(isAggregatorEnabled(), true);
  assert.equal(st.feeSource, 'contract-reported');
  assert.equal(st.feeBps, 100);
  assert.equal(st.feeRateRaw, 100);
  assert.equal(st.feeUnit, 'verified-bps');
});

test('MANCER token address discovers a direct aggregator V3 route and simulates', async () => {
  const provider = makeDiscoveryProvider();
  await initAggregator(provider);
  const found = await discoverAggregatorDescriptors(provider, MANCER, 10n ** 16n);
  assert.ok(found, 'must discover from token address only');
  assert.equal(found.descriptors.length, 1);
  assert.equal(found.descriptors[0].swapType, SWAP_TYPE.V3);
  assert.equal(found.descriptors[0].poolAddress, MANCER_POOL);
  const data = encodeAggregatorSwap({
    descriptors: found.descriptors,
    amountIn: 10n ** 16n,
    minReturn: 1n,
    deadline: 9999999999,
  });
  assert.equal(data.slice(0, 10), '0x4d819a2a');
  const route = await discoverBestBuyRoute({
    provider,
    token: MANCER,
    amountIn: 10n ** 16n,
    slippagePct: 15,
    from: '0x0000000000000000000000000000000000000001',
  });
  assert.equal(route.venue, 'aggregator');
  assert.equal(route.simulation.ok, true);
  assert.ok(route.minOut > 0n);
});

test('STRIKE token address discovers WETH→USDG→token bridge (type 1 + 12)', async () => {
  const provider = makeDiscoveryProvider();
  await initAggregator(provider);
  const found = await discoverAggregatorDescriptors(provider, STRIKE, 10n ** 16n);
  assert.ok(found, 'must discover bridge from token address only');
  assert.equal(found.descriptors.length, 2);
  assert.equal(found.descriptors[0].swapType, SWAP_TYPE.V3);
  assert.equal(found.descriptors[0].tokenOut, USDG);
  assert.equal(found.descriptors[0].poolAddress, WETH_USDG);
  assert.equal(found.descriptors[1].swapType, SWAP_TYPE.UP_V3);
  assert.equal(found.descriptors[1].tokenIn, USDG);
  assert.equal(found.descriptors[1].tokenOut, STRIKE);
  assert.equal(found.descriptors[1].poolAddress, STRIKE_UPCL);
  const decoded = new ethers.Interface([
    'function swap((uint8,address,address,address,uint24,int24,address,bytes,address,bytes32)[],address,uint256,uint256,uint256) payable',
  ]).decodeFunctionData('swap', encodeAggregatorSwap({
    descriptors: found.descriptors,
    amountIn: 10n ** 16n,
    minReturn: 1n,
    deadline: 100,
  }));
  assert.equal(decoded[0].length, 2);
  const route = await discoverBestBuyRoute({
    provider,
    token: STRIKE,
    amountIn: 10n ** 16n,
    slippagePct: 15,
  });
  assert.equal(route.kind, 'aggregator');
  assert.equal(route.simulation.ok, true);
});

test('V4 is used when aggregator is disabled', async () => {
  const provider = makeDiscoveryProvider({
    impl: '0x20a9d3a9be51e2a36c2943c55ebd6f934d197551',
    v4Quoter: V4_QUOTER,
    v4Out: 777n,
  });
  await initAggregator(provider);
  assert.equal(isAggregatorEnabled(), false);
  if (!V4_QUOTER) {
    assert.equal(aggState.validated, false);
    return;
  }
  const route = await discoverBestBuyRoute({
    provider,
    token: MANCER,
    amountIn: 10n ** 16n,
    slippagePct: 15,
  });
  assert.equal(route.venue, 'v4');
  assert.equal(route.expectedOut, 777n);
});
