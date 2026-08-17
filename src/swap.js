/**
 * swap.js — Uniswap v4 quoting and swap execution on Robinhood Chain (4663).
 *
 * Verified deployment addresses (Uniswap Universal Router SDK chain map +
 * Robinhood docs):
 *   Universal Router v2.1.1  0x8876789976decbfcbbbe364623c63652db8c0904
 *   WETH                     0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
 *
 * ROUTER VERSION MATTERS: Robinhood has no UR v2.0 deployment. Command
 * encoding differs between versions; this targets v2.1.1. If the address is
 * overridden, re-check the command bytes too — the address alone is not enough.
 *
 * v4 uses a singleton PoolManager rather than one contract per pair, which is
 * exactly why wallets can't find brand-new pools: there's no pair address to
 * look up. Quoting probes fee tiers directly, so a pool is tradeable the
 * moment it exists — no indexer in the loop.
 *
 * Everything here fails soft (null / checked:false) rather than throwing: a
 * quote failure must become a skip, never a crash.
 */

import 'dotenv/config';
import { ethers } from 'ethers';

export const ROBINHOOD_CHAIN_ID = 4663;
export const UNIVERSAL_ROUTER = (process.env.UNIVERSAL_ROUTER || '0x8876789976decbfcbbbe364623c63652db8c0904').toLowerCase();
export const WETH = (process.env.WETH_ADDRESS || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73').toLowerCase();
export const NATIVE = '0x0000000000000000000000000000000000000000';

/** V4Quoter address — set V4_QUOTER in .env. Required; there is no default. */
export const V4_QUOTER = (process.env.V4_QUOTER || '').toLowerCase();

export const FEE_TIERS = (process.env.SWAP_FEE_TIERS || '10000,3000,500')
  .split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);

const TICK_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

export const QUOTER_ABI = [
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
];
export const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
];
export const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
];

export const CMD_V4_SWAP = 0x10;
export const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
export const ACTION_SETTLE_ALL = 0x0c;
export const ACTION_TAKE_ALL = 0x0f;

const abi = ethers.AbiCoder.defaultAbiCoder();

/** Canonical v4 PoolKey — currencies sorted by address, native ETH is 0x0. */
export function buildPoolKey(tokenAddress, fee) {
  const token = String(tokenAddress).toLowerCase();
  const [currency0, currency1] = NATIVE < token ? [NATIVE, token] : [token, NATIVE];
  return {
    poolKey: { currency0, currency1, fee, tickSpacing: TICK_SPACING[fee] ?? 60, hooks: NATIVE },
    zeroForOne: currency0 === NATIVE,   // buying token with ETH
  };
}

/** Best ETH→token quote across fee tiers. → quote | null */
export async function quoteBuy(provider, tokenAddress, amountInWei) {
  if (!V4_QUOTER) return null;
  const quoter = new ethers.Contract(V4_QUOTER, QUOTER_ABI, provider);

  let best = null;
  for (const fee of FEE_TIERS) {
    const { poolKey, zeroForOne } = buildPoolKey(tokenAddress, fee);
    try {
      const res = await quoter.quoteExactInputSingle.staticCall({
        poolKey, zeroForOne, exactAmount: amountInWei, hookData: '0x',
      });
      const amountOut = BigInt(res[0] ?? res.amountOut ?? 0);
      if (amountOut > 0n && (!best || amountOut > best.amountOut)) {
        best = { amountOut, fee, poolKey, zeroForOne };
      }
    } catch { /* no pool at this tier */ }
  }
  if (!best) return null;

  // Impact: a 1%-size probe extrapolated linearly. Deep pools scale ~linearly.
  try {
    const probeIn = amountInWei / 100n;
    if (probeIn > 0n) {
      const { poolKey, zeroForOne } = buildPoolKey(tokenAddress, best.fee);
      const p = await quoter.quoteExactInputSingle.staticCall({
        poolKey, zeroForOne, exactAmount: probeIn, hookData: '0x',
      });
      const probeOut = BigInt(p[0] ?? p.amountOut ?? 0);
      if (probeOut > 0n) {
        const ideal = probeOut * 100n;
        const lost = ideal > best.amountOut ? ideal - best.amountOut : 0n;
        best.priceImpactPct = Number((lost * 10000n) / ideal) / 100;
      }
    }
  } catch { best.priceImpactPct = null; }

  return best;
}

/**
 * Honeypot check: quote the REVERSE swap for the tokens we'd receive. If no
 * sell route quotes, the position can't be exited.
 * Fails CLOSED — an un-runnable check reports checked:false and the rules
 * refuse the buy.
 */
export async function checkSellable(provider, tokenAddress, amountOut) {
  if (!V4_QUOTER || !amountOut || amountOut <= 0n) {
    return { checked: false, sellable: false, reason: 'quoter or amount missing' };
  }
  const quoter = new ethers.Contract(V4_QUOTER, QUOTER_ABI, provider);
  for (const fee of FEE_TIERS) {
    const { poolKey, zeroForOne } = buildPoolKey(tokenAddress, fee);
    try {
      const res = await quoter.quoteExactInputSingle.staticCall({
        poolKey, zeroForOne: !zeroForOne, exactAmount: amountOut, hookData: '0x',
      });
      const back = BigInt(res[0] ?? res.amountOut ?? 0);
      if (back > 0n) return { checked: true, sellable: true, ethBack: back, reason: 'sell route quoted' };
    } catch { /* try next tier */ }
  }
  return { checked: true, sellable: false, reason: 'no sell route on any fee tier' };
}

/** Crude pool depth in ETH, inferred from how much a 1 ETH probe moves price. */
export async function estimateLiquidityEth(provider, tokenAddress) {
  try {
    const one = 10n ** 18n;
    const small = await quoteBuy(provider, tokenAddress, one / 1000n);
    const large = await quoteBuy(provider, tokenAddress, one);
    if (!small || !large) return null;
    const ideal = small.amountOut * 1000n;
    if (ideal === 0n) return null;
    const retained = Number((large.amountOut * 10000n) / ideal) / 10000;
    if (retained <= 0) return 0;
    return Math.max(0, retained / (1 - Math.min(0.999, retained)));
  } catch { return null; }
}

export async function tokenMeta(provider, tokenAddress) {
  const c = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const out = { symbol: null, name: null, decimals: 18 };
  try { out.symbol = await c.symbol(); } catch {}
  try { out.name = await c.name(); } catch {}
  try { out.decimals = Number(await c.decimals()); } catch {}
  return out;
}

/** Encode a single-hop exact-input v4 swap for Universal Router v2.1.1. */
export function encodeV4Swap({ poolKey, zeroForOne, amountIn, amountOutMin }) {
  const actions = ethers.concat([
    ethers.toBeHex(ACTION_SWAP_EXACT_IN_SINGLE, 1),
    ethers.toBeHex(ACTION_SETTLE_ALL, 1),
    ethers.toBeHex(ACTION_TAKE_ALL, 1),
  ]);
  const keyTuple = [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks];
  const swapParams = abi.encode(
    ['((address,address,uint24,int24,address),bool,uint128,uint128,bytes)'],
    [[keyTuple, zeroForOne, amountIn, amountOutMin, '0x']],
  );
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  const settle = abi.encode(['address', 'uint256'], [currencyIn, amountIn]);
  const take = abi.encode(['address', 'uint256'], [currencyOut, amountOutMin]);
  return {
    commands: ethers.toBeHex(CMD_V4_SWAP, 1),
    inputs: [abi.encode(['bytes', 'bytes[]'], [actions, [swapParams, settle, take]])],
  };
}

/** Gas fields, USD-capped. Ported from rh-minter's mint path. */
export async function computeGas(provider, txReq, maxGasUsd, ethUsd) {
  let gasLimit;
  try {
    gasLimit = ((await provider.estimateGas(txReq)) * 130n) / 100n;
  } catch {
    gasLimit = 600_000n;    // v4 swaps are heavier than mints
  }
  const fee = await provider.getFeeData();
  const suggested = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits('0.1', 'gwei');
  let maxFeePerGas = suggested * 2n;
  const capWei = ethers.parseEther((Number(maxGasUsd) / Number(ethUsd)).toFixed(18)) / gasLimit;
  if (maxFeePerGas > capWei) maxFeePerGas = capWei;
  let maxPriorityFeePerGas = ethers.parseUnits('0.01', 'gwei');
  if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
  return { gasLimit, maxFeePerGas, maxPriorityFeePerGas };
}

/**
 * Send the buy. Assumes the rules gate already passed — this function contains
 * no limit logic by design.
 * → { sent, txHash, dryRun, error, amountOutMin }
 */
export async function executeBuy({ wallet, provider, quote, spendWei, tolerancePct, maxGasUsd, ethUsd, dryRun, deadlineSec = 120 }) {
  const { minOutWei } = await import('./swaprules.js');
  const amountOutMin = minOutWei(quote.amountOut, tolerancePct);

  const { commands, inputs } = encodeV4Swap({
    poolKey: quote.poolKey, zeroForOne: quote.zeroForOne, amountIn: spendWei, amountOutMin,
  });

  const router = new ethers.Contract(UNIVERSAL_ROUTER, UNIVERSAL_ROUTER_ABI, wallet);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);
  const data = router.interface.encodeFunctionData('execute', [commands, inputs, deadline]);
  const txReq = { to: UNIVERSAL_ROUTER, data, value: spendWei, from: wallet.address };

  // Simulate first — a revert here is free; on-chain it costs gas.
  try {
    await provider.call(txReq);
  } catch (e) {
    return { sent: false, amountOutMin, error: 'simulation reverted: ' + (e.shortMessage || e.message) };
  }

  if (dryRun) return { sent: false, dryRun: true, amountOutMin, error: null };

  const gas = await computeGas(provider, txReq, maxGasUsd, ethUsd);
  try {
    const tx = await wallet.sendTransaction({ ...txReq, ...gas });
    return { sent: true, txHash: tx.hash, amountOutMin, tx };
  } catch (e) {
    return { sent: false, amountOutMin, error: e.shortMessage || e.message };
  }
}
