/**
 * swaprules.js — pure decision logic for auto-buy. No I/O, no chain, no keys.
 *
 * Every rule that can stop funds leaving the wallet lives here so it can be
 * unit-tested exhaustively. autobuy.js must contain no limit checks of its
 * own — it calls these.
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

/** Normalize ticker for comparison. */
export function normalizeSymbol(symbol) {
  return String(symbol ?? '').trim().toUpperCase();
}

/** Case-insensitive target symbol match. */
export function symbolMatchesTarget(symbol, targetSymbol) {
  const t = normalizeSymbol(targetSymbol);
  if (!t) return true; // no target configured → skip symbol gate
  return normalizeSymbol(symbol) === t;
}

/**
 * Normalize legacy sourceHandle into a source object.
 * @param {object} ctx
 * @returns {{ type: 'x'|'chain', handle?: string, tweetUrl?: string, address?: string, role?: string, txHash?: string, blockNumber?: number, logIndex?: number }}
 */
export function normalizeSource(ctx) {
  if (ctx.source?.type) return ctx.source;
  if (ctx.sourceHandle != null) {
    return { type: 'x', handle: String(ctx.sourceHandle) };
  }
  return { type: 'x', handle: '' };
}

/**
 * Is this detection source trusted per settings?
 * @param {object} settings
 * @param {{ type: string, handle?: string, address?: string, role?: string }} source
 */
export function isTrustedSource(settings, source) {
  if (source.type === 'x') {
    const handle = String(source.handle || '').toLowerCase().replace(/^@/, '');
    const watched = (settings.handles || []).map((h) => String(h).toLowerCase().replace(/^@/, ''));
    return watched.includes(handle);
  }
  if (source.type === 'chain') {
    const addr = String(source.address || '').toLowerCase();
    const list = settings.chainWatchlist || [];
    return list.some((e) => e.enabled && String(e.address || '').toLowerCase() === addr);
  }
  return false;
}

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
 * Settings validation — source-aware.
 * At least one detection source must be enabled and properly configured.
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

  const xEnabled = s?.xEnabled !== false;
  const chainEnabled = s?.chainEnabled !== false;
  if (!xEnabled && !chainEnabled) {
    errors.push('At least one detection source (on-chain or X) must be enabled');
  }

  if (xEnabled) {
    const handles = Array.isArray(s?.handles) ? s.handles.filter(Boolean) : [];
    if (!handles.length) {
      errors.push('At least one X handle required when X scraper is enabled');
    }
  }

  if (chainEnabled) {
    const sym = normalizeSymbol(s?.targetSymbol);
    if (!sym) {
      errors.push('Target ticker required when on-chain scanner is enabled');
    }
    const enabledWatch = (s?.chainWatchlist || []).filter((e) => e?.enabled && e?.address);
    if (!enabledWatch.length) {
      errors.push('At least one enabled watched launch address required for chain scanner');
    }
  }

  return errors;
}

/**
 * The gate. → { ok:true, spendWei } | { ok:false, reason, detail }
 *
 * ctx: { settings, alreadyBought, walletBalanceWei, gasReserveWei,
 *        quote, source | sourceHandle, symbol? }
 */
export function evaluateBuy(ctx) {
  const s = ctx.settings || {};

  if (!s.enabled) return { ok: false, reason: 'disabled', detail: 'Auto-buy is switched off' };

  const configErrors = validateSettings(s);
  if (configErrors.length) {
    return { ok: false, reason: 'unconfigured', detail: configErrors[0] };
  }

  const source = normalizeSource(ctx);
  if (!isTrustedSource(s, source)) {
    const detail = source.type === 'x'
      ? '@' + (source.handle || '?') + ' is not a watched account'
      : (source.address || '?') + ' is not an enabled watched chain address';
    return { ok: false, reason: 'untrusted_source', detail };
  }

  // When targetSymbol is set, require symbol match (chain + X).
  if (s.targetSymbol && ctx.symbol != null && !symbolMatchesTarget(ctx.symbol, s.targetSymbol)) {
    return {
      ok: false,
      reason: 'wrong_symbol',
      detail: 'Symbol ' + ctx.symbol + ' !== target ' + s.targetSymbol,
    };
  }

  if (ctx.alreadyBought) {
    return { ok: false, reason: 'already_bought', detail: 'This contract was already bought' };
  }

  const spendWei = ethToWei(s.maxSpendEth);
  if (spendWei <= 0n) return { ok: false, reason: 'unconfigured', detail: 'Spend per buy is 0' };

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
    return { ok: false, reason: 'no_route', detail: 'No executable buy route found for this token' };
  }

  return { ok: true, spendWei };
}

/**
 * Cheap pre-filter before metadata/quote (no quote required).
 * @param {object} settings
 * @param {{ type: string, handle?: string, address?: string }} source
 */
export function evaluateSourceTrust(settings, source) {
  if (!settings.enabled) return { ok: false, reason: 'disabled', detail: 'Auto-buy off' };
  if (!isTrustedSource(settings, source)) {
    return { ok: false, reason: 'untrusted_source', detail: 'Source not in watch list' };
  }
  return { ok: true };
}

/**
 * Symbol gate for chain candidates (after metadata fetch).
 */
export function evaluateTargetSymbol(settings, symbol) {
  if (!settings.targetSymbol) return { ok: true };
  if (!symbol) return { ok: false, reason: 'metadata_failed', detail: 'Could not read symbol()' };
  if (!symbolMatchesTarget(symbol, settings.targetSymbol)) {
    return { ok: false, reason: 'wrong_symbol', detail: normalizeSymbol(symbol) + ' !== ' + normalizeSymbol(settings.targetSymbol) };
  }
  return { ok: true };
}
