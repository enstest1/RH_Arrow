/**
 * AUTO-SAFE total-wallet budget. Never broadcasts.
 *
 * TOTAL_BUY_BUDGET_ETH is buyInput + worst-case gas, not a guaranteed token input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import {
  computeSafeBuy,
  estimateTxGasCost,
  totalBudgetWei,
  buySizeMode,
  fallbackGasLimit,
  MIN_BUY_WEI,
  GAS_CONTINGENCY_WEI,
  scaleRouteAmount,
} from '../src/buybudget.js';
import { classifyCandidateResult } from '../src/candidateretry.js';
import { defaultChainWatchlist } from '../src/chainwatchlist.js';

const dir = path.join(os.tmpdir(), 'rh-budget-' + process.pid);
mkdirSync(dir, { recursive: true });
process.env.AUTOBUY_STATE_PATH = path.join(dir, 'state.json');
process.env.AUTOBUY_AUDIT_PATH = path.join(dir, 'audit.jsonl');

const ETH = 10n ** 18n;
const BUDGET = ethers.parseEther('0.011');

function mockProvider({ balance = BUDGET, gasUnits = 250_000n, maxFee = ethers.parseUnits('0.05', 'gwei') } = {}) {
  let fee = maxFee;
  return {
    getBalance: async () => balance,
    estimateGas: async () => gasUnits,
    getFeeData: async () => ({ maxFeePerGas: fee, gasPrice: fee }),
    setFee: (v) => { fee = v; },
    sendTransaction: async () => { throw new Error('send_forbidden_in_tests'); },
  };
}

test('default AUTO-SAFE total budget is 0.011 ETH', () => {
  assert.equal(buySizeMode({}), 'auto-safe');
  assert.equal(totalBudgetWei({}), BUDGET);
  assert.equal(totalBudgetWei({ maxSpendEth: '0.01' }), BUDGET);
  assert.equal(totalBudgetWei({ totalBuyBudgetEth: '0.011' }), BUDGET);
});

test('balance exactly 0.011 deducts gas reserve and never drains to zero', async () => {
  const provider = mockProvider({ balance: BUDGET });
  const gas = await estimateTxGasCost(provider, { to: '0x1', from: '0x1', data: '0x', value: 0n }, { venue: 'aggregator', multiplier: 1.5 });
  const sized = computeSafeBuy({
    walletBalanceWei: BUDGET,
    totalBudgetWei: BUDGET,
    gasReserveWei: gas.reserve,
  });
  assert.equal(sized.ok, true);
  assert.ok(sized.buyWei < BUDGET);
  assert.equal(sized.buyWei + sized.gasReserveWei, sized.worstCaseWei);
  assert.ok(sized.worstCaseWei <= BUDGET);
  assert.ok(BUDGET - sized.buyWei >= sized.gasReserveWei);
  assert.ok(sized.buyWei >= MIN_BUY_WEI);
  assert.ok(gas.reserve > GAS_CONTINGENCY_WEI);
});

test('actual balance less than configured budget uses the smaller usable amount', () => {
  const bal = ethers.parseEther('0.008');
  const reserve = ethers.parseEther('0.0004');
  const sized = computeSafeBuy({
    walletBalanceWei: bal,
    totalBudgetWei: BUDGET,
    gasReserveWei: reserve,
  });
  assert.equal(sized.ok, true);
  assert.equal(sized.buyWei, bal - reserve);
  assert.ok(sized.worstCaseWei <= bal);
});

test('actual balance greater than configured budget still caps at 0.011', () => {
  const bal = ethers.parseEther('1');
  const reserve = ethers.parseEther('0.0004');
  const sized = computeSafeBuy({
    walletBalanceWei: bal,
    totalBudgetWei: BUDGET,
    gasReserveWei: reserve,
  });
  assert.equal(sized.ok, true);
  assert.equal(sized.buyWei, BUDGET - reserve);
  assert.ok(sized.worstCaseWei <= BUDGET);
  assert.ok(sized.worstCaseWei <= bal);
});

test('aggregator vs V4 fallback gas units produce different reserves', async () => {
  const provider = mockProvider();
  const agg = await estimateTxGasCost(provider, null, { venue: 'aggregator', skipEstimate: true, multiplier: 1.5 });
  const v4 = await estimateTxGasCost(provider, null, { venue: 'v4', skipEstimate: true, multiplier: 1.5 });
  assert.equal(agg.gasLimit, fallbackGasLimit('aggregator'));
  assert.equal(v4.gasLimit, fallbackGasLimit('v4'));
  assert.notEqual(agg.reserve, v4.reserve);
  const a = computeSafeBuy({ walletBalanceWei: BUDGET, totalBudgetWei: BUDGET, gasReserveWei: agg.reserve });
  const b = computeSafeBuy({ walletBalanceWei: BUDGET, totalBudgetWei: BUDGET, gasReserveWei: v4.reserve });
  assert.notEqual(a.buyWei, b.buyWei);
});

test('route change recalculates the safe token input', () => {
  const aggReserve = 4_000_000_000_000_000n;
  const v4Reserve = 3_000_000_000_000_000n;
  const agg = computeSafeBuy({ walletBalanceWei: BUDGET, totalBudgetWei: BUDGET, gasReserveWei: aggReserve });
  const v4 = computeSafeBuy({ walletBalanceWei: BUDGET, totalBudgetWei: BUDGET, gasReserveWei: v4Reserve });
  assert.equal(agg.ok && v4.ok, true);
  assert.ok(v4.buyWei > agg.buyWei);
});

test('gas price rise before send reduces the safe token input', async () => {
  const provider = mockProvider({ maxFee: ethers.parseUnits('0.05', 'gwei') });
  const low = await estimateTxGasCost(provider, { to: '0x1', data: '0x', value: 1n, from: '0x1' }, { venue: 'aggregator' });
  provider.setFee(ethers.parseUnits('1', 'gwei'));
  const high = await estimateTxGasCost(provider, { to: '0x1', data: '0x', value: 1n, from: '0x1' }, { venue: 'aggregator' });
  assert.ok(high.reserve > low.reserve);
  const a = computeSafeBuy({ walletBalanceWei: BUDGET, totalBudgetWei: BUDGET, gasReserveWei: low.reserve });
  const b = computeSafeBuy({ walletBalanceWei: BUDGET, totalBudgetWei: BUDGET, gasReserveWei: high.reserve });
  assert.ok(b.buyWei < a.buyWei);
});

test('unsafe budget is insufficient_safe_budget and classifies terminal', async () => {
  const provider = mockProvider({
    balance: BUDGET,
    gasUnits: 5_000_000n,
    maxFee: ethers.parseUnits('100', 'gwei'),
  });
  const gas = await estimateTxGasCost(provider, { to: '0x1', data: '0x', value: 1n, from: '0x1' }, { venue: 'aggregator', multiplier: 1.5 });
  const sized = computeSafeBuy({
    walletBalanceWei: BUDGET,
    totalBudgetWei: BUDGET,
    gasReserveWei: gas.reserve,
  });
  assert.equal(sized.ok, false);
  assert.equal(sized.reason, 'insufficient_safe_budget');
  assert.equal(classifyCandidateResult({ action: 'skipped', reason: 'insufficient_safe_budget' }), 'terminal');
});

test('safe budget dry-run continues without sending', async () => {
  const { handleCandidate, saveSettings } = await import('../src/autobuy.js');
  const { makeDiscoveryProvider, STRIKE } = await import('./helpers/mockrpc.mjs');
  const { initAggregator } = await import('../src/routes/aggregator.js');
  saveSettings({
    enabled: true,
    maxSpendEth: '0.01',
    totalBuyBudgetEth: '0.011',
    buySizeMode: 'auto-safe',
    slippageTolerancePct: '15',
    targetSymbol: 'CLOCKIN',
    chainEnabled: true,
    xEnabled: false,
    chainWatchlist: defaultChainWatchlist(),
  });
  let sends = 0;
  const base = makeDiscoveryProvider({
    tokenMeta: { [STRIKE]: { symbol: 'CLOCKIN', name: 'CLOCKIN', decimals: 18 } },
  });
  const provider = {
    ...base,
    getBlockNumber: async () => 1000,
    getBalance: async () => BUDGET,
    sendTransaction: async () => { sends += 1; return { hash: '0xdead' }; },
  };
  await initAggregator(provider);
  const r = await handleCandidate({
    contract: STRIKE,
    source: {
      type: 'chain',
      address: '0x4Be25231574464E58c593BC3001b4BdEE37954A6',
      role: 'direct-deployer-eoa',
      blockNumber: 999,
      detectedAt: Date.now(),
    },
    dryRun: true,
    provider,
    wallet: { address: '0x0000000000000000000000000000000000000001', provider },
  });
  assert.equal(r.action, 'simulated');
  assert.equal(r.dryRun, true);
  assert.equal(sends, 0);
  assert.ok(r.budget);
  assert.equal(r.budget.ok, true);
  assert.ok(Number(r.budget.safeTokenInputEth) > 0);
  assert.ok(Number(r.budget.worstCaseTotalEth) <= 0.0110001);
});

test('unsafe live-sized budget does not send', async () => {
  const { handleCandidate, saveSettings } = await import('../src/autobuy.js');
  const { makeDiscoveryProvider, MANCER } = await import('./helpers/mockrpc.mjs');
  const { initAggregator } = await import('../src/routes/aggregator.js');
  saveSettings({
    enabled: true,
    totalBuyBudgetEth: '0.011',
    slippageTolerancePct: '15',
    targetSymbol: 'CLOCKIN',
    chainEnabled: true,
    xEnabled: false,
    chainWatchlist: defaultChainWatchlist(),
  });
  let sends = 0;
  const base = makeDiscoveryProvider({
    tokenMeta: { [MANCER]: { symbol: 'CLOCKIN', name: 'CLOCKIN', decimals: 18 } },
  });
  const provider = {
    ...base,
    getBlockNumber: async () => 1000,
    getBalance: async () => BUDGET,
    estimateGas: async () => 8_000_000n,
    getFeeData: async () => ({
      maxFeePerGas: ethers.parseUnits('200', 'gwei'),
      gasPrice: ethers.parseUnits('200', 'gwei'),
    }),
    sendTransaction: async () => { sends += 1; return { hash: '0xdead' }; },
  };
  await initAggregator(provider);
  const r = await handleCandidate({
    contract: MANCER,
    source: {
      type: 'chain',
      address: '0x4Be25231574464E58c593BC3001b4BdEE37954A6',
      role: 'direct-deployer-eoa',
      blockNumber: 999,
      detectedAt: Date.now(),
    },
    dryRun: false,
    provider,
    wallet: { address: '0x0000000000000000000000000000000000000001', provider },
  });
  assert.equal(r.reason, 'insufficient_safe_budget');
  assert.equal(sends, 0);
});

test('scaleRouteAmount does not subtract aggregator fee twice', () => {
  const route = {
    venue: 'aggregator',
    amountIn: ETH / 100n,
    expectedOut: 1_000_000n,
    minOut: 850_000n,
  };
  const next = scaleRouteAmount(route, ETH / 200n, 15);
  assert.equal(next.amountIn, ETH / 200n);
  assert.equal(next.expectedOut, 500_000n);
});
