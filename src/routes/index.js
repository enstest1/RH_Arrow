/**
 * routes/index.js — multi-venue route discovery + normalized execution.
 *
 * Priority when multiple routes exist: highest expectedOut among simulatable routes.
 * Launcher execution omitted until ABI verified.
 */
import { minOutWei } from '../swaprules.js';
import { auditEvent } from '../auditlog.js';
import {
  isAggregatorEnabled,
  simulateAggregatorSwap,
  executeAggregatorSwap,
  getAggregatorStatus,
  initAggregator,
} from './aggregator.js';
import { discoverAggregatorDescriptors } from './poolDiscovery.js';
import { discoverV4Route, executeV4Buy } from './v4.js';
import { detectLauncherContext, discoverLauncherRoute } from './launcher.js';

export { initAggregator, getAggregatorStatus, detectLauncherContext };

function deadlineSec() {
  return Math.max(15, Number(process.env.AGGREGATOR_DEADLINE_SEC || '60'));
}

/**
 * Discover best executable buy route across verified venues.
 * @param {{ provider: import('ethers').Provider, token: string, amountIn: bigint, slippagePct: number, source?: object }} p
 * @returns {Promise<object | null>}
 */
export async function discoverBestBuyRoute({ provider, token, amountIn, slippagePct, source }) {
  auditEvent('route_discovery_start', { candidateContract: token, amountIn: String(amountIn) });
  /** @type {object[]} */
  const found = [];

  const launcherCtx = source ? detectLauncherContext(source) : { active: false };
  if (launcherCtx.active) {
    auditEvent('launcher_route_found', { executable: false, reason: launcherCtx.reason });
  }
  const launcherRoute = await discoverLauncherRoute();
  if (launcherRoute) found.push(launcherRoute);

  if (isAggregatorEnabled()) {
    const agg = await discoverAggregatorDescriptors(provider, token, amountIn);
    if (agg?.descriptors?.length) {
      const expectedOut = agg.amountOut;
      const minOut = minOutWei(expectedOut, slippagePct);
      const dl = Math.floor(Date.now() / 1000) + deadlineSec();
      const sim = await simulateAggregatorSwap(provider, {
        from: '0x0000000000000000000000000000000000000001',
        amountIn,
        minReturn: minOut,
        descriptors: agg.descriptors,
        deadline: dl,
      });
      if (sim.ok) {
        const route = {
          venue: 'aggregator',
          amountIn,
          expectedOut,
          minOut,
          deadline: dl,
          descriptors: agg.descriptors,
          metadata: { hops: agg.descriptors.length, swapTypes: agg.descriptors.map((d) => d.swapType) },
        };
        found.push(route);
        auditEvent('aggregator_route_found', {
          candidateContract: token,
          hops: agg.descriptors.length,
          expectedOut: String(expectedOut),
        });
      }
    }
  }

  const v4 = await discoverV4Route(provider, token, amountIn);
  if (v4) {
    const minOut = minOutWei(v4.expectedOut, slippagePct);
    found.push({
      venue: 'v4',
      amountIn,
      expectedOut: v4.expectedOut,
      minOut,
      quote: v4.quote,
      metadata: { fee: v4.quote.fee },
    });
    auditEvent('v4_route_found', { candidateContract: token, fee: v4.quote.fee });
  }

  if (!found.length) {
    auditEvent('route_missing', { candidateContract: token });
    return null;
  }

  found.sort((a, b) => (a.expectedOut > b.expectedOut ? -1 : 1));
  const best = found[0];
  auditEvent('route_selected', {
    candidateContract: token,
    venue: best.venue,
    expectedOut: String(best.expectedOut),
  });
  return best;
}

/**
 * Execute a normalized route from discoverBestBuyRoute().
 * @param {{ route: object, wallet: import('ethers').Wallet, provider: import('ethers').Provider, settings: object }} p
 */
export async function executeRoute({ route, wallet, provider, settings }) {
  const maxGasUsd = Number(process.env.MAX_GAS_USD || '5');
  const ethUsd = Number(process.env.ETH_USD || '3000');

  if (route.venue === 'aggregator') {
    return executeAggregatorSwap({ wallet, provider, route, maxGasUsd, ethUsd });
  }
  if (route.venue === 'v4') {
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
  return { sent: false, error: 'unsupported_route_venue: ' + route.venue };
}

/** Normalize route for evaluateBuy() — exposes amountOut on quote field. */
export function routeAsQuote(route) {
  if (!route) return null;
  return {
    amountOut: route.expectedOut,
    venue: route.venue,
    priceImpactPct: route.quote?.priceImpactPct ?? null,
  };
}
