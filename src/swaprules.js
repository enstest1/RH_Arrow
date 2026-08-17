/**
 * swaprules.js — pure decision logic for auto-buy. No I/O, no chain, no keys.
 *
 * Every rule that can stop funds leaving the wallet lives here so it can be
 * unit-tested exhaustively. autobuy.js must contain no limit checks of its
 * own — it calls these.
 *
 * There is deliberately NO daily cap: the wallet balance is the bound. Keep
 * only what you're prepared to lose on the key this bot holds.
 *
 * All money is wei (BigInt). No floats touch an amount.
 */

export const ETH = 10n ** 18n;

/** Decimal ETH → wei, exact at 18 places (no float drift). */
export function ethToWei(eth) {
  const s = String(eth ?? '').trim();
  if (!s) return 0n;
  const neg = s.startsWith('-');
  const [whole, frac = ''] = (neg ? s.slice(1) : s).split('.');
  const padded = (frac + '0'.repeat(18)).slice(0, 18);
  const v = BigInt(whole || '0') * ETH + BigInt(padded || '0');
  return neg ? -v : v;
}

export const weiToEthNum = (wei) => Number(wei) / 1e18;

/** Price impact %, quoted output vs a linearly-extrapolated small probe. */
export function priceImpactPct(quotedOut, idealOut) {
  if (!idealOut || idealOut <= 0n) return 100;
  const lost = idealOut > quotedOut ? idealOut - quotedOut : 0n;
  return Number((lost * 10000n) / idealOut) / 100;
}

/** amountOutMinimum given a tolerance percentage. */
export function minOutWei(quotedOut, tolerancePct) {
  const pct = Math.max(0, Math.min(100, Number(tolerancePct) || 0));
  const bps = BigInt(Math.round(pct * 100));
  return (quotedOut * (10000n - bps)) / 10000n;
}

/**
 * Settings come from the UI and start BLANK — nothing is assumed on the
 * user's behalf. → [] when usable, else a list of human-readable problems.
 */
export function validateSettings(s) {
  const errors = [];
  const spend = Number(s?.maxSpendEth);
  if (!s?.maxSpendEth || !Number.isFinite(spend) || spend <= 0) {
    errors.push('Spend per buy (ETH) must be set and greater than 0');
  }
  const tol = Number(s?.slippageTolerancePct);
  if (!s?.slippageTolerancePct || !Number.isFinite(tol) || tol <= 0 || tol > 50) {
    errors.push('Slippage tolerance % must be set, between 0 and 50');
  }
  const handles = Array.isArray(s?.handles) ? s.handles.filter(Boolean) : [];
  if (!handles.length) {
    errors.push('At least one X handle must be watched — refusing to buy CAs from arbitrary accounts');
  }
  return errors;
}

/**
 * The gate. → { ok:true, spendWei } | { ok:false, reason, detail }
 *
 * ctx: { settings, alreadyBought, walletBalanceWei, gasReserveWei,
 *        quote: { amountOut } | null, sourceHandle }
 */
export function evaluateBuy(ctx) {
  const s = ctx.settings || {};

  if (!s.enabled) return { ok: false, reason: 'disabled', detail: 'Auto-buy is switched off' };

  const configErrors = validateSettings(s);
  if (configErrors.length) {
    return { ok: false, reason: 'unconfigured', detail: configErrors[0] };
  }

  const handle = String(ctx.sourceHandle || '').toLowerCase().replace(/^@/, '');
  const watched = (s.handles || []).map((h) => String(h).toLowerCase().replace(/^@/, ''));
  if (!watched.includes(handle)) {
    return { ok: false, reason: 'untrusted_source', detail: '@' + handle + ' is not a watched account' };
  }

  if (ctx.alreadyBought) {
    return { ok: false, reason: 'already_bought', detail: 'This contract was already bought' };
  }

  const spendWei = ethToWei(s.maxSpendEth);
  if (spendWei <= 0n) return { ok: false, reason: 'unconfigured', detail: 'Spend per buy is 0' };

  // Wallet balance is the only spend bound — always leave room for gas.
  const balance = ctx.walletBalanceWei ?? 0n;
  const gasReserve = ctx.gasReserveWei ?? 0n;
  if (balance < spendWei + gasReserve) {
    return {
      ok: false,
      reason: 'insufficient_balance',
      detail: 'Balance ' + weiToEthNum(balance).toFixed(5) + ' ETH cannot cover a ' +
        weiToEthNum(spendWei).toFixed(5) + ' ETH buy plus gas',
    };
  }

  const q = ctx.quote;
  if (!q || !q.amountOut || q.amountOut <= 0n) {
    return { ok: false, reason: 'no_route', detail: 'No Uniswap v4 pool found for this token' };
  }

  return { ok: true, spendWei };
}
