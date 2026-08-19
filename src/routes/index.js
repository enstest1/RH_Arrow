/**
 * routes/index.js — multi-venue route discovery + normalized execution.
 *
 * Priority: aggregator (verified impl + types, simulated) then V4.
 * Launcher is detection-only — never an executable route.
 */
import { minOutWei } from '../swaprules.js';
import { auditEvent } from '../auditlog.js';
import {
  isAggregatorEnabled,
  simulateAggregatorSwap,
  executeAggregatorSwap,
  getAggregatorStatus,
  initAggregator,
  encodeAggregatorSwap,
} from './aggregator.js';
import { AGGREGATOR_PROXY } from './constants.js';
import { listAggregatorDescriptorSets } from './poolDiscovery.js';
import { discoverV4Route, executeV4Buy } from './v4.js';
import { detectLauncherContext, discoverLauncherRoute } from './launcher.js';
import { encodeV4Swap, UNIVERSAL_ROUTER, UNIVERSAL_ROUTER_ABI } from '../swap.js';
import { ethers } from 'ethers';
import {
  estimateTxGasCost,
  computeSafeBuy,
  scaleRouteAmount,
  totalBudgetWei,
  gasReserveMultiplier,
  snapshotBudget,
} from '../buybudget.js';

export { initAggregator, getAggregatorStatus, detectLauncherContext };

function deadlineSec() {
  return Math.max(15, Number(process.env.AGGREGATOR_DEADLINE_SEC || '60'));
}

function normalizeRoute(partial) {
  return {
    kind: partial.kind || partial.venue,
    venue: partial.venue,
    token: partial.token || null,
    amountIn: partial.amountIn,
    expectedOut: partial.expectedOut,
    minOut: partial.minOut,
    slippagePct: partial.slippagePct ?? null,
    launchTaxPct: partial.launchTaxPct ?? null,
    descriptors: partial.descriptors || [],
    quote: partial.quote || null,
    deadline: partial.deadline,
    simulation: partial.simulation || { ok: true, reason: null },
    metadata: partial.metadata || {},
  };
}

/**
 * Discover best executable buy route across verified venues.
 * @param {{ provider: import('ethers').Provider, token: string, amountIn: bigint, slippagePct: number, source?: object, from?: string }} p
 */
export async function discoverBestBuyRoute({ provider, token, amountIn, slippagePct, source, from }) {
  auditEvent('route_search_started', { candidateContract: token, amountIn: String(amountIn) });

  const launcherCtx = source ? detectLauncherContext(source) : { active: false };
  if (launcherCtx.active) {
    auditEvent('launcher_route_found', { executable: false, reason: launcherCtx.reason });
  }
  await discoverLauncherRoute();

  const simFrom = from || '0x0000000000000000000000000000000000000001';

  // Priority 1: verified aggregator (simulated). Do not lose this to a higher V4 quote.
  if (isAggregatorEnabled()) {
    const sets = await listAggregatorDescriptorSets(provider, token, amountIn);
    for (const agg of sets) {
      if (!agg?.descriptors?.length) continue;
      const dl = Math.floor(Date.now() / 1000) + deadlineSec();
      let expectedOut = agg.amountOut && agg.amountOut > 0n ? agg.amountOut : null;
      const probeMin = expectedOut ? minOutWei(expectedOut, slippagePct) : 1n;
      const sim = await simulateAggregatorSwap(provider, {
        from: simFrom,
        amountIn,
        minReturn: probeMin,
        descriptors: agg.descriptors,
        deadline: dl,
      });
      if (!sim.ok) continue;
      if (sim.amountOut && sim.amountOut > 0n) expectedOut = sim.amountOut;
      if (!expectedOut || expectedOut <= 0n) expectedOut = 1n;
      let minOut = minOutWei(expectedOut, slippagePct);
      if (minOut <= 0n) minOut = 1n;
      const route = normalizeRoute({
        kind: 'aggregator',
        venue: 'aggregator',
        token,
        amountIn,
        expectedOut,
        minOut,
        slippagePct,
        launchTaxPct: null,
        deadline: dl,
        descriptors: agg.descriptors,
        simulation: { ok: true, reason: null },
        metadata: { hops: agg.descriptors.length, swapTypes: agg.descriptors.map((d) => d.swapType) },
      });
      auditEvent('route_found', {
        candidateContract: token,
        venue: 'aggregator',
        hops: agg.descriptors.length,
        expectedOut: String(expectedOut),
      });
      auditEvent('route_selected', {
        candidateContract: token,
        venue: 'aggregator',
        expectedOut: String(expectedOut),
      });
      return route;
    }
  }

  // Priority 2: existing verified V4 quoter route.
  const v4 = await discoverV4Route(provider, token, amountIn);
  if (v4) {
    const minOut = minOutWei(v4.expectedOut, slippagePct);
    const route = normalizeRoute({
      kind: 'v4',
      venue: 'v4',
      token,
      amountIn,
      expectedOut: v4.expectedOut,
      minOut,
      slippagePct,
      launchTaxPct: null,
      quote: v4.quote,
      simulation: { ok: true, reason: null },
      metadata: { fee: v4.quote.fee },
    });
    auditEvent('route_found', { candidateContract: token, venue: 'v4', fee: v4.quote.fee });
    auditEvent('route_selected', {
      candidateContract: token,
      venue: 'v4',
      expectedOut: String(v4.expectedOut),
    });
    return route;
  }

  auditEvent('route_not_found', { candidateContract: token });
  return null;
}

/**
 * Build the unsigned tx that would be sent for this route. Used for estimateGas.
 * Never broadcasts.
 * @param {object} route
 * @param {string} from
 */
export function encodeRouteTxReq(route, from) {
  if (!route || !from) return null;
  if (route.venue === 'aggregator' || route.kind === 'aggregator') {
    const data = encodeAggregatorSwap({
      descriptors: route.descriptors,
      amountIn: route.amountIn,
      minReturn: route.minOut || 1n,
      deadline: route.deadline || (Math.floor(Date.now() / 1000) + deadlineSec()),
    });
    return { to: AGGREGATOR_PROXY, data, value: route.amountIn, from };
  }
  if ((route.venue === 'v4' || route.kind === 'v4') && route.quote?.poolKey) {
    const { commands, inputs } = encodeV4Swap({
      poolKey: route.quote.poolKey,
      zeroForOne: route.quote.zeroForOne,
      amountIn: route.amountIn,
      amountOutMin: route.minOut || 1n,
    });
    const iface = new ethers.Interface(UNIVERSAL_ROUTER_ABI);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec());
    const data = iface.encodeFunctionData('execute', [commands, inputs, deadline]);
    return { to: UNIVERSAL_ROUTER, data, value: route.amountIn, from };
  }
  return { to: AGGREGATOR_PROXY, data: '0x', value: route.amountIn || 0n, from };
}

/**
 * Recalculate token input from live balance + gas for this specific route.
 * Re-simulates aggregator after resize. Never broadcasts.
 */
export async function sizeRouteForWallet({ provider, route, settings, from }) {
  const walletBalanceWei = await provider.getBalance(from);
  const budgetWei = totalBudgetWei(settings);
  const multiplier = gasReserveMultiplier(settings);
  let txReq;
  try {
    txReq = encodeRouteTxReq(route, from);
  } catch (e) {
    return {
      ok: false,
      reason: e.reason || 'unsupported_swap_type',
      walletBalanceWei,
      totalBudgetWei: budgetWei,
    };
  }
  const gas = await estimateTxGasCost(provider, txReq, { venue: route.venue, multiplier });
  const sized = computeSafeBuy({
    walletBalanceWei,
    totalBudgetWei: budgetWei,
    gasReserveWei: gas.reserve,
  });
  if (!sized.ok) {
    return {
      ...sized,
      walletBalanceWei,
      totalBudgetWei: budgetWei,
      gas,
      snapshot: snapshotBudget(
        { ...sized, walletBalanceWei, totalBudgetWei: budgetWei },
        { multiplier, venue: route.venue, mode: 'auto-safe' },
      ),
    };
  }
  let next = scaleRouteAmount(route, sized.buyWei, Number(settings.slippageTolerancePct));
  if ((next.venue === 'aggregator' || next.kind === 'aggregator') && next.descriptors?.length) {
    const sim = await simulateAggregatorSwap(provider, {
      from,
      amountIn: next.amountIn,
      minReturn: next.minOut,
      descriptors: next.descriptors,
      deadline: next.deadline || (Math.floor(Date.now() / 1000) + deadlineSec()),
    });
    if (sim.ok && sim.amountOut && sim.amountOut > 0n) {
      next = {
        ...next,
        expectedOut: sim.amountOut,
        minOut: minOutWei(sim.amountOut, Number(settings.slippageTolerancePct)),
        simulation: { ok: true, reason: null },
      };
    }
  }
  return {
    ...sized,
    ok: true,
    route: next,
    gas,
    walletBalanceWei,
    totalBudgetWei: budgetWei,
    snapshot: snapshotBudget(
      { ...sized, walletBalanceWei, totalBudgetWei: budgetWei },
      { multiplier, venue: next.venue, mode: 'auto-safe' },
    ),
  };
}

/**
 * Execute a normalized route from discoverBestBuyRoute().
 * @param {{ route: object, wallet: import('ethers').Wallet, provider: import('ethers').Provider, settings: object, dryRun?: boolean }} p
 */
export async function executeRoute({ route, wallet, provider, settings, dryRun }) {
  if (!route?.minOut || route.minOut <= 0n) {
    return { sent: false, error: 'invalid_minOut', reason: 'invalid_minOut', status: 'retry' };
  }
  const maxGasUsd = Number(process.env.MAX_GAS_USD || '5');
  const ethUsd = Number(process.env.ETH_USD || '3000');

  if (route.venue === 'aggregator' || route.kind === 'aggregator') {
    return executeAggregatorSwap({ wallet, provider, route, maxGasUsd, ethUsd, dryRun });
  }
  if (route.venue === 'v4' || route.kind === 'v4') {
    if (dryRun) return { sent: false, dryRun: true, status: 'sent', txHash: null };
    return executeV4Buy({
      wallet,
      provider,
      quote: route.quote,
      spendWei: route.amountIn,
      tolerancePct: Number(settings.slippageTolerancePct),
      maxGasUsd,
      ethUsd,
      dryRun: false,
      deadlineSec: deadlineSec(),
    });
  }
  return { sent: false, error: 'unsupported_route_venue: ' + route.venue, reason: 'unsupported_route_venue', status: 'terminal' };
}

/** Normalize route for evaluateBuy() — exposes amountOut on quote field. */
export function routeAsQuote(route) {
  if (!route) return null;
  return {
    amountOut: route.expectedOut,
    venue: route.venue,
    kind: route.kind,
    priceImpactPct: route.quote?.priceImpactPct ?? null,
    launchTaxPct: route.launchTaxPct ?? null,
  };
}
