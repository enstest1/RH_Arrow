/**
 * poolDiscovery.js — bounded RPC-only pool/route discovery for CLOCKIN buys.
 *
 * Search graph (no universal optimizer):
 *   WETH → token (Uniswap V3 factory, swapType 1)
 *   WETH → USDG (V3) → token (Up CL factory getPool(address,address,int24), swapType 12)
 *   WETH → USDG (V3) → token (V3 factory, swapType 1) if such a pool exists
 *
 * Up CL is NOT the Uniswap V3 factory. Historical STRIKE USDG pool.factory()
 * = 0x1ac9dB4a… and getPool(USDG, STRIKE, 2000) returns 0x97cf6a….
 */
import { ethers } from 'ethers';
import {
  WETH,
  USDG,
  UNI_V3_FACTORY,
  UNI_V3_QUOTER_V2,
  UNI_V3_TICK_SPACING,
  V3_FEE_TIERS,
  V3_FACTORY_ABI,
  V3_QUOTER_ABI,
  V3_POOL_ABI,
  SWAP_TYPE,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  UP_CL_FACTORY,
  UP_CL_FACTORY_ABI,
  UP_CL_TICK_SPACINGS,
} from './constants.js';

/**
 * @typedef {{ swapType: number, tokenIn: string, tokenOut: string, poolAddress: string, fee: number, tickSpacing: number, hooks: string, hookData: string, poolManager: string, parameters: string }} RouteDescriptor
 */

function emptyDesc(over) {
  return {
    hooks: ZERO_ADDRESS,
    hookData: '0x',
    poolManager: ZERO_ADDRESS,
    parameters: ZERO_BYTES32,
    ...over,
  };
}

/**
 * Best V3 hop tokenIn→tokenOut via Uniswap V3 factory + QuoterV2.
 * @param {import('ethers').Provider} provider
 * @param {string} tokenIn
 * @param {string} tokenOut
 * @param {bigint} amountIn
 */
export async function findV3Hop(provider, tokenIn, tokenOut, amountIn) {
  const factory = new ethers.Contract(UNI_V3_FACTORY, V3_FACTORY_ABI, provider);
  const quoter = new ethers.Contract(UNI_V3_QUOTER_V2, V3_QUOTER_ABI, provider);
  const tin = tokenIn.toLowerCase();
  const tout = tokenOut.toLowerCase();
  let best = null;

  for (const fee of V3_FEE_TIERS) {
    try {
      const pool = await factory.getPool(tin, tout, fee);
      if (!pool || pool.toLowerCase() === ZERO_ADDRESS) continue;
      const poolAddr = pool.toLowerCase();
      // Keep the hop even if the quoter is not ready yet — aggregator sim is the gate.
      let amountOut = null;
      try {
        const res = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: tin,
          tokenOut: tout,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0,
        });
        const n = BigInt(res[0] ?? res.amountOut ?? 0);
        if (n > 0n) amountOut = n;
      } catch {
        /* quoter unavailable while the pool is still initializing */
      }
      const ranked = amountOut || 0n;
      const bestRanked = best?.amountOut || 0n;
      if (!best || ranked > bestRanked) {
        best = {
          descriptor: emptyDesc({
            swapType: SWAP_TYPE.V3,
            tokenIn: tin,
            tokenOut: tout,
            poolAddress: poolAddr,
            fee,
            tickSpacing: UNI_V3_TICK_SPACING[fee] ?? 60,
          }),
          amountOut,
        };
      }
    } catch { /* no pool / no quote at this fee */ }
  }
  return best;
}

/** @param {import('ethers').Provider} provider @param {string} tokenOut @param {bigint} amountIn */
export async function findV3DirectHop(provider, tokenOut, amountIn) {
  return findV3Hop(provider, WETH, tokenOut, amountIn);
}

/** @param {import('ethers').Provider} provider @param {bigint} amountIn */
export async function findWethToUsdgHop(provider, amountIn) {
  return findV3Hop(provider, WETH, USDG, amountIn);
}

/**
 * USDG → token via Up CL factory. ABI verified: getPool(address,address,int24).
 * @param {import('ethers').Provider} provider
 * @param {string} tokenOut
 */
export async function findUpClUsdgHop(provider, tokenOut) {
  const factory = new ethers.Contract(UP_CL_FACTORY, UP_CL_FACTORY_ABI, provider);
  const target = tokenOut.toLowerCase();
  /** @type {RouteDescriptor | null} */
  let bestDesc = null;
  let bestLiq = 0n;

  const pairs = [
    [USDG, target],
    [target, USDG],
  ];

  for (const [a, b] of pairs) {
    for (const spacing of UP_CL_TICK_SPACINGS) {
      try {
        const pool = await factory.getPool(a, b, spacing);
        if (!pool || pool.toLowerCase() === ZERO_ADDRESS) continue;
        const poolAddr = pool.toLowerCase();
        const poolC = new ethers.Contract(poolAddr, V3_POOL_ABI, provider);
        const [t0, t1, pf, ts, liq] = await Promise.all([
          poolC.token0(),
          poolC.token1(),
          poolC.fee().catch(() => 0),
          poolC.tickSpacing().catch(() => spacing),
          poolC.liquidity().catch(() => 0n),
        ]);
        const liqN = BigInt(liq);
        const t0l = t0.toLowerCase();
        const t1l = t1.toLowerCase();
        if (!([t0l, t1l].includes(USDG) && [t0l, t1l].includes(target))) continue;
        // Include 0-liquidity pools so launch-time init can still be simulated.
        if (!bestDesc || liqN > bestLiq) {
          bestLiq = liqN;
          bestDesc = emptyDesc({
            swapType: SWAP_TYPE.UP_V3,
            tokenIn: USDG,
            tokenOut: target,
            poolAddress: poolAddr,
            fee: Number(pf) || 0,
            tickSpacing: Number(ts) || spacing,
          });
        }
      } catch { /* spacing unused or not a CL pool */ }
    }
  }
  return bestDesc;
}

/**
 * Quote chained route. Type 12 has no verified dedicated quoter — try V3 quoter
 * and return null amountOut so the aggregator eth_call is the validity gate.
 * @param {import('ethers').Provider} provider
 * @param {RouteDescriptor[]} descriptors
 * @param {bigint} amountIn
 * @returns {Promise<bigint | null>}
 */
export async function quoteDescriptorChain(provider, descriptors, amountIn) {
  const quoter = new ethers.Contract(UNI_V3_QUOTER_V2, V3_QUOTER_ABI, provider);
  let amt = amountIn;
  for (const d of descriptors) {
    if (d.swapType === SWAP_TYPE.V3) {
      try {
        const res = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: d.tokenIn,
          tokenOut: d.tokenOut,
          amountIn: amt,
          fee: d.fee,
          sqrtPriceLimitX96: 0,
        });
        amt = BigInt(res[0] ?? res.amountOut ?? 0);
        if (amt <= 0n) return null;
      } catch {
        return null;
      }
    } else if (d.swapType === SWAP_TYPE.UP_V3) {
      try {
        const res = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: d.tokenIn,
          tokenOut: d.tokenOut,
          amountIn: amt,
          fee: d.fee,
          sqrtPriceLimitX96: 0,
        });
        amt = BigInt(res[0] ?? res.amountOut ?? 0);
        if (amt <= 0n) return null;
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  return amt;
}

/**
 * All bounded aggregator descriptor sets for ETH → token.
 * Quoted paths first, then unquoted (sim is the validity gate).
 * @param {import('ethers').Provider} provider
 * @param {string} token
 * @param {bigint} amountIn
 * @returns {Promise<{ descriptors: RouteDescriptor[], amountOut: bigint | null }[]>}
 */
export async function listAggregatorDescriptorSets(provider, token, amountIn) {
  const target = token.toLowerCase();
  const candidates = [];

  const direct = await findV3Hop(provider, WETH, target, amountIn);
  if (direct) candidates.push({ descriptors: [direct.descriptor], amountOut: direct.amountOut });

  const leg1 = await findWethToUsdgHop(provider, amountIn);
  if (leg1?.descriptor) {
    const mid = (leg1.amountOut && leg1.amountOut > 0n) ? leg1.amountOut : amountIn;
    const up = await findUpClUsdgHop(provider, target);
    if (up) {
      const out = await quoteDescriptorChain(provider, [up], mid);
      candidates.push({ descriptors: [leg1.descriptor, up], amountOut: out });
    }
    const v3Usdg = await findV3Hop(provider, USDG, target, mid);
    if (v3Usdg) {
      candidates.push({
        descriptors: [leg1.descriptor, v3Usdg.descriptor],
        amountOut: v3Usdg.amountOut,
      });
    }
  }

  const quoted = candidates.filter((c) => c.amountOut && c.amountOut > 0n);
  const unquoted = candidates.filter((c) => !(c.amountOut && c.amountOut > 0n));
  quoted.sort((a, b) => ((a.amountOut || 0n) > (b.amountOut || 0n) ? -1 : 1));
  return [...quoted, ...unquoted];
}

/**
 * Best single descriptor set (tests + callers that want one candidate).
 * @param {import('ethers').Provider} provider
 * @param {string} token
 * @param {bigint} amountIn
 */
export async function discoverAggregatorDescriptors(provider, token, amountIn) {
  const all = await listAggregatorDescriptorSets(provider, token, amountIn);
  return all[0] || null;
}
