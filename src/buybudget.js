/**
 * buybudget.js — AUTO-SAFE total-wallet budget. ETH pays both token input and gas.
 *
 * TOTAL_BUY_BUDGET_ETH is a ceiling on buyInput + worst-case gas, not the token
 * input. Recalculate immediately before send; never drain the wallet to zero.
 *
 * Gas method (Robinhood 4663, ETH native):
 *   1. eth_estimateGas on the actual planned tx (fallback units if it fails)
 *   2. pad gas units 30% (same as computeGas)
 *   3. live getFeeData(); maxFee = 2× suggested (same as computeGas)
 *   4. reserve = (gasLimit * maxFee) * GAS_RESERVE_MULTIPLIER + dust contingency
 *
 * Default multiplier 1.5: L2 inclusion can exceed the 2× fee pad slightly;
 * measured aggregator/V4 estimates on this chain are << 0.001 ETH, so 1.5×
 * still leaves ~0.01 ETH for token input on a 0.011 ETH wallet.
 */
import { ethers } from 'ethers';
import { ethToWei, weiToEthNum, minOutWei } from './swaprules.js';

export const BUY_SIZE_MODE_AUTO = 'auto-safe';
export const BUY_SIZE_MODE_FIXED = 'fixed';

/** Dust left in addition to scaled gas reserve so balance cannot hit 0. */
export const GAS_CONTINGENCY_WEI = 10n ** 12n; // 0.000001 ETH

/** Below this, a swap is not a meaningful CLOCKIN buy. */
export const MIN_BUY_WEI = 10n ** 14n; // 0.0001 ETH

export function buySizeMode(settings = {}) {
  const m = String(settings.buySizeMode || process.env.BUY_SIZE_MODE || BUY_SIZE_MODE_AUTO).toLowerCase();
  return m === BUY_SIZE_MODE_FIXED ? BUY_SIZE_MODE_FIXED : BUY_SIZE_MODE_AUTO;
}

export function gasReserveMultiplier(settings = {}) {
  const n = Number(settings.gasReserveMultiplier || process.env.GAS_RESERVE_MULTIPLIER || '1.5');
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 1.5;
}

export function totalBudgetWei(settings = {}) {
  // AUTO-SAFE: TOTAL_BUY_BUDGET_ETH is the ceiling on buy + gas, not legacy token-input.
  if (buySizeMode(settings) === BUY_SIZE_MODE_FIXED) {
    const w = ethToWei(settings.maxSpendEth || settings.totalBuyBudgetEth || '0.011');
    return w > 0n ? w : ethToWei('0.011');
  }
  const raw = settings.totalBuyBudgetEth || process.env.TOTAL_BUY_BUDGET_ETH;
  if (raw) {
    const w = ethToWei(raw);
    if (w > 0n) return w;
  }
  return ethToWei('0.011');
}

export function fallbackGasLimit(venue) {
  if (venue === 'v4') return 350_000n;
  if (venue === 'aggregator') return 400_000n;
  return 500_000n;
}

/**
 * Live gas cost for a populated tx. No broadcast.
 * @param {import('ethers').Provider} provider
 * @param {object} txReq
 * @param {{ venue?: string, multiplier?: number, nowFee?: object, estimateGas?: Function }} [opts]
 */
export async function estimateTxGasCost(provider, txReq, opts = {}) {
  const multiplier = opts.multiplier ?? gasReserveMultiplier();
  let gasLimit;
  const canEstimate = Boolean(txReq) && !opts.skipEstimate;
  try {
    if (!canEstimate) throw new Error('skip_estimate');
    const est = opts.estimateGas
      ? await opts.estimateGas(txReq)
      : await provider.estimateGas(txReq);
    gasLimit = (BigInt(est) * 130n) / 100n;
  } catch {
    gasLimit = fallbackGasLimit(opts.venue);
  }
  let fee = opts.nowFee;
  if (!fee) {
    try {
      fee = await provider.getFeeData();
    } catch {
      fee = {};
    }
  }
  const suggested = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits('0.1', 'gwei');
  const maxFeePerGas = suggested * 2n;
  const rawCost = gasLimit * maxFeePerGas;
  const mill = BigInt(Math.round(multiplier * 1000));
  const reserve = (rawCost * mill) / 1000n + GAS_CONTINGENCY_WEI;
  return {
    gasLimit,
    maxFeePerGas,
    suggestedFee: suggested,
    rawCost,
    reserve,
    multiplier,
    method: canEstimate ? 'estimateGas+getFeeData' : 'fallbackGas+getFeeData',
  };
}

/**
 * Representative AUTO-SAFE snapshot when the CLOCKIN route is not yet known.
 * Uses live fees + venue fallback gas units. Recalculate on the real route before send.
 */
export async function estimateBudgetSnapshot(provider, from, settings = {}, venue = 'aggregator') {
  const walletBalanceWei = provider && from
    ? await provider.getBalance(from).catch(() => 0n)
    : 0n;
  const budgetWei = totalBudgetWei(settings);
  const multiplier = gasReserveMultiplier(settings);
  const gas = await estimateTxGasCost(provider, null, { venue, multiplier, skipEstimate: true });
  const sized = computeSafeBuy({
    walletBalanceWei,
    totalBudgetWei: budgetWei,
    gasReserveWei: gas.reserve,
  });
  return {
    ...sized,
    walletBalanceWei,
    totalBudgetWei: budgetWei,
    gas,
    snapshot: snapshotBudget(
      { ...sized, walletBalanceWei, totalBudgetWei: budgetWei },
      { multiplier, venue, mode: buySizeMode(settings) },
    ),
  };
}

/**
 * Pure sizing once gas reserve is known.
 * @param {{ walletBalanceWei: bigint, totalBudgetWei: bigint, gasReserveWei: bigint }} p
 */
export function computeSafeBuy(p) {
  const balance = p.walletBalanceWei ?? 0n;
  const budget = p.totalBudgetWei ?? 0n;
  const reserve = p.gasReserveWei ?? 0n;
  if (balance <= 0n || budget <= 0n) {
    return { ok: false, reason: 'insufficient_safe_budget', buyWei: 0n, gasReserveWei: reserve, worstCaseWei: 0n, headroomWei: 0n };
  }
  const usable = balance < budget ? balance : budget;
  if (reserve >= usable) {
    return {
      ok: false,
      reason: 'insufficient_safe_budget',
      buyWei: 0n,
      gasReserveWei: reserve,
      worstCaseWei: reserve,
      headroomWei: 0n,
      detail: 'gas reserve exceeds usable budget',
    };
  }
  const buyWei = usable - reserve;
  if (buyWei < MIN_BUY_WEI) {
    return {
      ok: false,
      reason: 'insufficient_safe_budget',
      buyWei,
      gasReserveWei: reserve,
      worstCaseWei: buyWei + reserve,
      headroomWei: 0n,
      detail: 'safe token input below minimum',
    };
  }
  const worstCaseWei = buyWei + reserve;
  if (worstCaseWei > balance || worstCaseWei > budget) {
    return { ok: false, reason: 'insufficient_safe_budget', buyWei, gasReserveWei: reserve, worstCaseWei, headroomWei: 0n };
  }
  // Leftover after buy must cover reserve — wallet is never designed to hit 0.
  if (balance - buyWei < reserve) {
    return { ok: false, reason: 'insufficient_safe_budget', buyWei, gasReserveWei: reserve, worstCaseWei, headroomWei: 0n };
  }
  return {
    ok: true,
    reason: null,
    buyWei,
    gasReserveWei: reserve,
    worstCaseWei,
    headroomWei: usable - worstCaseWei,
    usableWei: usable,
  };
}

/**
 * Scale a discovered route to a new ETH input. Aggregator fee is in expectedOut
 * from simulation, not subtracted again here.
 */
export function scaleRouteAmount(route, newAmountIn, slippagePct) {
  if (!route || !newAmountIn || newAmountIn <= 0n) return route;
  const oldIn = route.amountIn && route.amountIn > 0n ? route.amountIn : newAmountIn;
  const expectedOut = route.expectedOut && oldIn > 0n
    ? (route.expectedOut * newAmountIn) / oldIn
    : route.expectedOut;
  const minOut = expectedOut && expectedOut > 0n ? minOutWei(expectedOut, slippagePct) : 1n;
  return { ...route, amountIn: newAmountIn, expectedOut, minOut };
}

export function snapshotBudget(sized, extras = {}) {
  return {
    mode: extras.mode || BUY_SIZE_MODE_AUTO,
    walletBalanceEth: sized.walletBalanceWei != null ? weiToEthNum(sized.walletBalanceWei).toFixed(5) : null,
    totalBudgetEth: sized.totalBudgetWei != null ? weiToEthNum(sized.totalBudgetWei).toFixed(5) : null,
    gasReserveEth: sized.gasReserveWei != null ? weiToEthNum(sized.gasReserveWei).toFixed(6) : null,
    safeTokenInputEth: sized.buyWei != null ? weiToEthNum(sized.buyWei).toFixed(6) : null,
    worstCaseTotalEth: sized.worstCaseWei != null ? weiToEthNum(sized.worstCaseWei).toFixed(6) : null,
    headroomEth: sized.headroomWei != null ? weiToEthNum(sized.headroomWei).toFixed(6) : null,
    multiplier: extras.multiplier,
    venue: extras.venue || null,
    ok: sized.ok !== false,
    reason: sized.reason || null,
  };
}
