/**
 * poolDiscovery.js — bounded RPC-only pool/route discovery for CLOCKIN buys.
 *
 * Search graph (no universal optimizer):
 *   WETH → token (V3, swapType 1)
 *   WETH → USDG (V3) → token (Up CL swapType 12 when pool readable)
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
} from './constants.js';

/**
 * @typedef {{ swapType: number, tokenIn: string, tokenOut: string, poolAddress: string, fee: number, tickSpacing: number, hooks: string, hookData: string, poolManager: string, parameters: string }} RouteDescriptor
 */

/**
 * Best V3 WETH→token single hop via factory + QuoterV2.
 * @param {import('ethers').Provider} provider
 * @param {string} tokenOut
 * @param {bigint} amountIn
 */
export async function findV3DirectHop(provider, tokenOut, amountIn) {
  const factory = new ethers.Contract(UNI_V3_FACTORY, V3_FACTORY_ABI, provider);
  const quoter = new ethers.Contract(UNI_V3_QUOTER_V2, V3_QUOTER_ABI, provider);
  const target = tokenOut.toLowerCase();
  let best = null;

  for (const fee of V3_FEE_TIERS) {
    try {
      const pool = await factory.getPool(WETH, target, fee);
      if (!pool || pool === ZERO_ADDRESS) continue;
      const poolAddr = pool.toLowerCase();
      const poolC = new ethers.Contract(poolAddr, V3_POOL_ABI, provider);
      const liq = await poolC.liquidity().catch(() => 0n);
      if (BigInt(liq) <= 0n) continue;

      const res = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: WETH,
        tokenOut: target,
        amountIn,
        fee,
        sqrtPriceLimitX96: 0,
      });
      const amountOut = BigInt(res[0] ?? res.amountOut ?? 0);
      if (amountOut <= 0n) continue;
      if (!best || amountOut > best.amountOut) {
        best = {
          descriptor: {
            swapType: SWAP_TYPE.V3,
            tokenIn: WETH,
            tokenOut: target,
            poolAddress: poolAddr,
            fee,
            tickSpacing: UNI_V3_TICK_SPACING[fee] ?? 60,
            hooks: ZERO_ADDRESS,
            hookData: '0x',
            poolManager: ZERO_ADDRESS,
            parameters: ZERO_BYTES32,
          },
          amountOut,
        };
      }
    } catch { /* no pool at tier */ }
  }
  return best;
}

/**
 * WETH → USDG best V3 hop.
 * @param {import('ethers').Provider} provider
 * @param {bigint} amountIn
 */
export async function findWethToUsdgHop(provider, amountIn) {
  return findV3DirectHop(provider, USDG, amountIn);
}

/**
 * USDG → token via Up CL pool (swapType 12) when pool contract exposes fee/tickSpacing.
 * @param {import('ethers').Provider} provider
 * @param {string} tokenOut
 */
export async function findUpClUsdgHop(provider, tokenOut) {
  const factory = new ethers.Contract(UNI_V3_FACTORY, V3_FACTORY_ABI, provider);
  const target = tokenOut.toLowerCase();
  /** @type {RouteDescriptor | null} */
  let bestDesc = null;

  for (const fee of V3_FEE_TIERS) {
    try {
      const pool = await factory.getPool(USDG, target, fee);
      if (!pool || pool === ZERO_ADDRESS) continue;
      const poolAddr = pool.toLowerCase();
      const poolC = new ethers.Contract(poolAddr, V3_POOL_ABI, provider);
      const [t0, t1, pf, ts, liq] = await Promise.all([
        poolC.token0(),
        poolC.token1(),
        poolC.fee(),
        poolC.tickSpacing().catch(() => UNI_V3_TICK_SPACING[fee] ?? 60),
        poolC.liquidity().catch(() => 0n),
      ]);
      if (BigInt(liq) <= 0n) continue;
      const t0l = t0.toLowerCase();
      const t1l = t1.toLowerCase();
      if (!([t0l, t1l].includes(USDG) && [t0l, t1l].includes(target))) continue;

      // Up CL pools use non-standard tickSpacing (e.g. STRIKE pool tickSpacing=2000).
      const tickSpacing = Number(ts);
      bestDesc = {
        swapType: SWAP_TYPE.UP_V3,
        tokenIn: USDG,
        tokenOut: target,
        poolAddress: poolAddr,
        fee: Number(pf),
        tickSpacing,
        hooks: ZERO_ADDRESS,
        hookData: '0x',
        poolManager: ZERO_ADDRESS,
        parameters: ZERO_BYTES32,
      };
      break;
    } catch { /* try next fee */ }
  }
  return bestDesc;
}

/**
 * Quote chained route output using QuoterV2 for V3 legs; Up leg passes input through
 * (conservative — simulation is authoritative).
 * @param {import('ethers').Provider} provider
 * @param {RouteDescriptor[]} descriptors
 * @param {bigint} amountIn
 */
export async function quoteDescriptorChain(provider, descriptors, amountIn) {
  const quoter = new ethers.Contract(UNI_V3_QUOTER_V2, V3_QUOTER_ABI, provider);
  let amt = amountIn;
  for (const d of descriptors) {
    if (d.swapType === SWAP_TYPE.V3) {
      const res = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: d.tokenIn,
        tokenOut: d.tokenOut,
        amountIn: amt,
        fee: d.fee,
        sqrtPriceLimitX96: 0,
      });
      amt = BigInt(res[0] ?? res.amountOut ?? 0);
      if (amt <= 0n) return null;
    } else if (d.swapType === SWAP_TYPE.UP_V3) {
      // No verified Up CL quoter wired — use V3 quoter attempt; may underestimate.
      try {
        const res = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: d.tokenIn,
          tokenOut: d.tokenOut,
          amountIn: amt,
          fee: d.fee,
          sqrtPriceLimitX96: 0,
        });
        amt = BigInt(res[0] ?? res.amountOut ?? 0);
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
 * Discover best aggregator descriptor set for ETH → token.
 * @param {import('ethers').Provider} provider
 * @param {string} token
 * @param {bigint} amountIn
 */
export async function discoverAggregatorDescriptors(provider, token, amountIn) {
  const target = token.toLowerCase();
  const candidates = [];

  const direct = await findV3DirectHop(provider, target, amountIn);
  if (direct) candidates.push({ descriptors: [direct.descriptor], amountOut: direct.amountOut });

  const leg1 = await findWethToUsdgHop(provider, amountIn);
  if (leg1?.descriptor) {
    const leg2 = await findUpClUsdgHop(provider, target);
    if (leg2) {
      const mid = await quoteDescriptorChain(provider, [leg1.descriptor], amountIn);
      if (mid && mid > 0n) {
        const out = await quoteDescriptorChain(provider, [leg2], mid);
        if (out && out > 0n) {
          candidates.push({ descriptors: [leg1.descriptor, leg2], amountOut: out });
        }
      }
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1));
  return candidates[0];
}
