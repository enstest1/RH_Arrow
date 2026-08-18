/**
 * routes/v4.js — thin adapter over existing swap.js (preserved, not replaced).
 */
import { quoteBuy, executeBuy, checkSellable, V4_QUOTER } from '../swap.js';

/**
 * Discover V4 buy route using existing quoter probe.
 * @param {import('ethers').Provider} provider
 * @param {string} token
 * @param {bigint} amountIn
 */
export async function discoverV4Route(provider, token, amountIn) {
  if (!V4_QUOTER) return null;
  const quote = await quoteBuy(provider, token, amountIn);
  if (!quote?.amountOut) return null;
  return {
    venue: 'v4',
    amountIn,
    expectedOut: quote.amountOut,
    quote,
  };
}

export { executeBuy as executeV4Buy, checkSellable, V4_QUOTER };
