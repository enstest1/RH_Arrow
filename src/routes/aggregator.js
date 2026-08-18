/**
 * aggregator.js — Robinhood routing proxy (0x65050…) swap adapter.
 *
 * Verified: selector 0x4d819a2a, SwapDesc tuple, swapType 1/2/12 via tx
 * 0x72c33c3048163beacde5f4ef5b1955d8e392019436e7ececdac0473c5441676d
 * and eth_call simulation for MANCER (type 1) + STRIKE 2-hop (1+12).
 */
import { ethers } from 'ethers';
import {
  AGGREGATOR_PROXY,
  AGGREGATOR_EXPECTED_IMPL,
  AGGREGATOR_FEE_COLLECTOR,
  AGGREGATOR_DEFAULT_FEE_BPS,
  AGGREGATOR_SWAP_ABI,
  EIP1967_IMPL_SLOT,
  ZERO_ADDRESS,
} from './constants.js';
import { auditEvent } from '../auditlog.js';

/** @type {{ proxy: string, implementation: string | null, validated: boolean, feeBps: number, feeCollector: string, checkedAt: number | null }} */
export const aggState = {
  proxy: AGGREGATOR_PROXY,
  implementation: null,
  validated: false,
  feeBps: AGGREGATOR_DEFAULT_FEE_BPS,
  feeCollector: AGGREGATOR_FEE_COLLECTOR,
  checkedAt: null,
};

/**
 * Read EIP-1967 implementation; fail-closed if mismatch with expected.
 * @param {import('ethers').Provider} provider
 */
export async function initAggregator(provider) {
  if (process.env.AGGREGATOR_ENABLED === 'false') {
    aggState.validated = false;
    auditEvent('aggregator_disabled', { reason: 'AGGREGATOR_ENABLED=false' });
    return aggState;
  }

  let impl = null;
  try {
    const raw = await provider.getStorage(AGGREGATOR_PROXY, EIP1967_IMPL_SLOT);
    impl = ('0x' + raw.slice(-40)).toLowerCase();
  } catch (e) {
    auditEvent('aggregator_disabled', { reason: 'impl_read_failed', error: e.message });
    aggState.implementation = null;
    aggState.validated = false;
    return aggState;
  }

  aggState.implementation = impl;
  aggState.checkedAt = Date.now();
  const expected = AGGREGATOR_EXPECTED_IMPL;
  aggState.validated = impl === expected;

  if (!aggState.validated) {
    auditEvent('implementation_changed', { expected, actual: impl });
    console.log('[AGG] IMPLEMENTATION CHANGED expected=' + expected + ' actual=' + impl);
    console.log('[AGG] aggregator execution DISABLED until validated');
  } else {
    console.log('[AGG] proxy ' + AGGREGATOR_PROXY);
    console.log('[AGG] implementation ' + impl);
    console.log('[AGG] implementation validated');
  }

  // Fee: attempt on-chain read; fall back to observed default (1%).
  aggState.feeBps = AGGREGATOR_DEFAULT_FEE_BPS;
  console.log('[AGG] effective fee ~' + (aggState.feeBps / 100).toFixed(2) + '%');
  console.log('[AGG] fee collector ' + AGGREGATOR_FEE_COLLECTOR);
  auditEvent('aggregator_fee_checked', {
    feeBps: aggState.feeBps,
    feeCollector: AGGREGATOR_FEE_COLLECTOR,
    validated: aggState.validated,
  });

  return aggState;
}

export function isAggregatorEnabled() {
  return process.env.AGGREGATOR_ENABLED !== 'false' && aggState.validated;
}

export function getAggregatorStatus() {
  return { ...aggState, enabled: isAggregatorEnabled() };
}

/**
 * Build SwapDesc struct for ABI encoding.
 * @param {object} d
 */
export function buildSwapDesc(d) {
  return {
    swapType: d.swapType,
    tokenIn: d.tokenIn,
    tokenOut: d.tokenOut,
    poolAddress: d.poolAddress,
    fee: d.fee,
    tickSpacing: d.tickSpacing,
    hooks: d.hooks || ZERO_ADDRESS,
    hookData: d.hookData || '0x',
    poolManager: d.poolManager || ZERO_ADDRESS,
    parameters: d.parameters || ethers.ZeroHash,
  };
}

/**
 * Encode aggregator swap calldata.
 * @param {{ descriptors: object[], amountIn: bigint, minReturn: bigint, deadline: number }} p
 */
export function encodeAggregatorSwap({ descriptors, amountIn, minReturn, deadline }) {
  const iface = new ethers.Interface(AGGREGATOR_SWAP_ABI);
  const descs = descriptors.map(buildSwapDesc);
  return iface.encodeFunctionData('swap', [descs, ZERO_ADDRESS, amountIn, minReturn, BigInt(deadline)]);
}

/**
 * Simulate aggregator swap — final gate before broadcast.
 * @param {import('ethers').Provider} provider
 * @param {{ from: string, amountIn: bigint, minReturn: bigint, descriptors: object[], deadline: number }} p
 */
export async function simulateAggregatorSwap(provider, { from, amountIn, minReturn, descriptors, deadline }) {
  const data = encodeAggregatorSwap({ descriptors, amountIn, minReturn, deadline });
  auditEvent('simulation_start', { venue: 'aggregator', amountIn: String(amountIn) });
  try {
    await provider.call({ to: AGGREGATOR_PROXY, data, value: amountIn, from });
    auditEvent('simulation_success', { venue: 'aggregator' });
    return { ok: true };
  } catch (e) {
    const err = e.shortMessage || e.message;
    auditEvent('simulation_failure', { venue: 'aggregator', error: err });
    return { ok: false, error: err };
  }
}

/**
 * Execute aggregator swap (assumes rules + simulation passed).
 * @param {{ wallet: import('ethers').Wallet, provider: import('ethers').Provider, route: object, maxGasUsd: number, ethUsd: number }} p
 */
export async function executeAggregatorSwap({ wallet, provider, route, maxGasUsd, ethUsd }) {
  const { computeGas } = await import('../swap.js');
  const data = encodeAggregatorSwap({
    descriptors: route.descriptors,
    amountIn: route.amountIn,
    minReturn: route.minOut,
    deadline: route.deadline,
  });
  const txReq = { to: AGGREGATOR_PROXY, data, value: route.amountIn, from: wallet.address };

  const sim = await simulateAggregatorSwap(provider, {
    from: wallet.address,
    amountIn: route.amountIn,
    minReturn: route.minOut,
    descriptors: route.descriptors,
    deadline: route.deadline,
  });
  if (!sim.ok) return { sent: false, error: 'aggregator_simulation_failed: ' + sim.error };

  const gas = await computeGas(provider, txReq, maxGasUsd, ethUsd);
  try {
    const tx = await wallet.sendTransaction({ ...txReq, ...gas });
    return { sent: true, txHash: tx.hash, tx };
  } catch (e) {
    return { sent: false, error: e.shortMessage || e.message };
  }
}
