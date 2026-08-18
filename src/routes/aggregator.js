/**
 * aggregator.js — Robinhood routing proxy (0x65050…) swap adapter.
 *
 * Verified 2026-08-17 and re-checked 2026-08-18:
 *   EIP-1967 impl 0xb70DA7425Bc26A6aFd60d080148248389a9073bF
 *   selector 0x4d819a2a
 *   ETH-in: msg.value === amountIn, feeToken = address(0)
 *   swapType 1 (V3) and 12 (Up CL) only — other types fail-closed
 *   feeRate() returns 100. Unit proven as bps: impl bytecode does
 *   amount * 0x64 / 0x2710, and ETH-in tx 0x9e08e895 withheld 1%.
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
  VERIFIED_SWAP_TYPES,
  FEE_RATE_ABI,
} from './constants.js';
import { auditEvent } from '../auditlog.js';

/** @type {{ proxy: string, implementation: string | null, expectedImplementation: string, validated: boolean, feeBps: number, feeRateRaw: number, feeSource: string, feeUnit: string, feeCollector: string, checkedAt: number | null }} */
export const aggState = {
  proxy: AGGREGATOR_PROXY,
  implementation: null,
  expectedImplementation: AGGREGATOR_EXPECTED_IMPL,
  validated: false,
  feeBps: AGGREGATOR_DEFAULT_FEE_BPS,
  feeRateRaw: AGGREGATOR_DEFAULT_FEE_BPS,
  feeSource: 'observed-default',
  feeUnit: 'unverified',
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
  aggState.expectedImplementation = AGGREGATOR_EXPECTED_IMPL;
  aggState.checkedAt = Date.now();
  const expected = AGGREGATOR_EXPECTED_IMPL;
  aggState.validated = impl === expected;

  if (!aggState.validated) {
    auditEvent('aggregator_impl_mismatch', { expected, actual: impl });
    console.log('[AGG] implementation mismatch expected=' + expected + ' actual=' + impl);
    console.log('[AGG] aggregator execution DISABLED — V4 remains available');
  } else {
    const code = await provider.getCode(impl).catch(() => '0x');
    if (!code || code === '0x') {
      aggState.validated = false;
      auditEvent('aggregator_impl_mismatch', { expected, actual: impl, reason: 'no_bytecode' });
      console.log('[AGG] implementation has no bytecode — aggregator DISABLED');
    } else {
      console.log('[AGG] proxy ' + AGGREGATOR_PROXY);
      console.log('[AGG] implementation ' + impl);
      console.log('[AGG] implementation validated');
    }
  }

  aggState.feeBps = AGGREGATOR_DEFAULT_FEE_BPS;
  aggState.feeRateRaw = AGGREGATOR_DEFAULT_FEE_BPS;
  aggState.feeSource = 'observed-default';
  aggState.feeUnit = 'unverified';
  try {
    const feeC = new ethers.Contract(AGGREGATOR_PROXY, FEE_RATE_ABI, provider);
    const rate = await feeC.feeRate();
    if (rate != null) {
      const raw = Number(rate);
      aggState.feeRateRaw = raw;
      aggState.feeBps = raw;
      aggState.feeSource = 'contract-reported';
      // 100-as-bps proven on expected impl (bytecode 100/10000 + tx 0x9e08e895).
      aggState.feeUnit = (aggState.validated && raw === 100) ? 'verified-bps' : 'unverified';
    }
  } catch {
    /* no getter — keep observed default */
  }
  console.log('[AGG] feeRateRaw ' + aggState.feeRateRaw + ' unit=' + aggState.feeUnit + ' (' + aggState.feeSource + ') collector ' + AGGREGATOR_FEE_COLLECTOR);
  auditEvent('aggregator_fee_checked', {
    feeRateRaw: aggState.feeRateRaw,
    feeBps: aggState.feeBps,
    feeSource: aggState.feeSource,
    feeUnit: aggState.feeUnit,
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
 * Reject unverified swapType values fail-closed.
 * @param {object[]} descriptors
 */
export function assertVerifiedSwapTypes(descriptors) {
  for (const d of descriptors || []) {
    if (!VERIFIED_SWAP_TYPES[d.swapType]) {
      const err = new Error('unsupported_swap_type:' + d.swapType);
      err.reason = 'unsupported_swap_type';
      throw err;
    }
  }
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
  assertVerifiedSwapTypes(descriptors);
  const iface = new ethers.Interface(AGGREGATOR_SWAP_ABI);
  const descs = descriptors.map(buildSwapDesc);
  return iface.encodeFunctionData('swap', [descs, ZERO_ADDRESS, amountIn, minReturn, BigInt(deadline)]);
}

/**
 * Decode aggregator swap() calldata into the same shape used by fixtures.
 * Does not assert verified types — historical txs may include 2/27.
 * @param {string} data
 * @returns {{ selector: string, feeToken: string, amountIn: string, minReturn: string, deadline: string, descriptors: object[] }}
 */
export function decodeAggregatorSwap(data) {
  const hex = String(data || '');
  const iface = new ethers.Interface(AGGREGATOR_SWAP_ABI);
  const decoded = iface.decodeFunctionData('swap', hex);
  const descriptors = [...decoded[0]].map((d) => ({
    swapType: Number(d.swapType),
    tokenIn: String(d.tokenIn).toLowerCase(),
    tokenOut: String(d.tokenOut).toLowerCase(),
    poolAddress: String(d.poolAddress).toLowerCase(),
    fee: Number(d.fee),
    tickSpacing: Number(d.tickSpacing),
    hooks: String(d.hooks).toLowerCase(),
    hookData: d.hookData,
    poolManager: String(d.poolManager).toLowerCase(),
    parameters: d.parameters,
  }));
  return {
    selector: hex.slice(0, 10).toLowerCase(),
    feeToken: String(decoded[1]).toLowerCase(),
    amountIn: decoded[2].toString(),
    minReturn: decoded[3].toString(),
    deadline: decoded[4].toString(),
    descriptors,
  };
}

function decodeCallAmount(ret) {
  if (!ret || ret === '0x' || ret.length < 66) return null;
  try {
    const v = BigInt(ret);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/**
 * Simulate aggregator swap — final gate before broadcast.
 * @param {import('ethers').Provider} provider
 * @param {{ from: string, amountIn: bigint, minReturn: bigint, descriptors: object[], deadline: number }} p
 */
export async function simulateAggregatorSwap(provider, { from, amountIn, minReturn, descriptors, deadline }) {
  let data;
  try {
    data = encodeAggregatorSwap({ descriptors, amountIn, minReturn, deadline });
  } catch (e) {
    auditEvent('route_simulation_fail', { venue: 'aggregator', error: e.message });
    return { ok: false, error: e.message, retryable: false };
  }
  auditEvent('simulation_start', { venue: 'aggregator', amountIn: String(amountIn) });
  try {
    const ret = await provider.call({ to: AGGREGATOR_PROXY, data, value: amountIn, from });
    const amountOut = decodeCallAmount(ret);
    auditEvent('route_simulation_pass', { venue: 'aggregator', amountOut: amountOut != null ? String(amountOut) : null });
    return { ok: true, amountOut };
  } catch (e) {
    const err = e.shortMessage || e.message;
    auditEvent('route_simulation_fail', { venue: 'aggregator', error: err });
    return { ok: false, error: err, retryable: true };
  }
}

/**
 * Execute aggregator swap (assumes rules + simulation passed).
 * @param {{ wallet: import('ethers').Wallet, provider: import('ethers').Provider, route: object, maxGasUsd: number, ethUsd: number, dryRun?: boolean }} p
 */
export async function executeAggregatorSwap({ wallet, provider, route, maxGasUsd, ethUsd, dryRun }) {
  const { computeGas } = await import('../swap.js');
  let data;
  try {
    data = encodeAggregatorSwap({
      descriptors: route.descriptors,
      amountIn: route.amountIn,
      minReturn: route.minOut,
      deadline: route.deadline,
    });
  } catch (e) {
    return { sent: false, error: e.message, reason: e.reason || 'unsupported_swap_type', status: 'terminal' };
  }
  const txReq = { to: AGGREGATOR_PROXY, data, value: route.amountIn, from: wallet.address };

  const sim = await simulateAggregatorSwap(provider, {
    from: wallet.address,
    amountIn: route.amountIn,
    minReturn: route.minOut,
    descriptors: route.descriptors,
    deadline: route.deadline,
  });
  if (!sim.ok) {
    return { sent: false, error: 'aggregator_simulation_failed: ' + sim.error, status: 'retry', retryable: true };
  }

  if (dryRun) {
    return { sent: false, dryRun: true, status: 'sent', txHash: null };
  }

  const gas = await computeGas(provider, txReq, maxGasUsd, ethUsd);
  try {
    const tx = await wallet.sendTransaction({ ...txReq, ...gas });
    return { sent: true, status: 'sent', txHash: tx.hash, tx };
  } catch (e) {
    const msg = e.shortMessage || e.message;
    return { sent: false, error: msg, status: 'retry', retryable: true };
  }
}
