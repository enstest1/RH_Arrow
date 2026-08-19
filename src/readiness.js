/**
 * readiness.js — startup self-check before auto-buy ARMED.
 *
 * P0 failures prevent ARMED. Aggregator impl mismatch disables aggregator only.
 * Live ARM requires a healthy WSS unless ALLOW_HTTP_ONLY_LIVE=true.
 */
import { makeProvider, makeEventProvider, wssUrlConfigured } from './provider.js';
import { getSettings } from './autostate.js';
import { normalizeSymbol, weiToEthNum } from './swaprules.js';
import { initAggregator, getAggregatorStatus } from './routes/aggregator.js';
import { V4_QUOTER } from './swap.js';
import { auditEvent } from './auditlog.js';

const CHAIN_ID = 4663;

function row(name, ok, detail) {
  return { name, ok, detail: detail || (ok ? 'PASS' : 'FAIL') };
}

/** Explicit override to arm production without WSS (default false). */
export function allowHttpOnlyLive() {
  return String(process.env.ALLOW_HTTP_ONLY_LIVE || '').toLowerCase() === 'true';
}

export { wssUrlConfigured };

/**
 * Probe WSS: URL present and (unless skipped) a live ping succeeds.
 * Tests inject opts.wssOk to avoid opening a real socket.
 * @param {{ wssOk?: boolean }} [opts]
 */
export async function probeWss(opts = {}) {
  if (typeof opts.wssOk === 'boolean') return opts.wssOk;
  if (!wssUrlConfigured()) return false;
  let ws = null;
  try {
    ws = makeEventProvider();
    if (!ws) return false;
    const ping = ws.getBlockNumber();
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('wss_ping_timeout')), 4000));
    await Promise.race([ping, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    try { ws?.destroy?.(); } catch { /* ignore */ }
  }
}

/**
 * @param {{ provider?: import('ethers').Provider, wallet?: import('ethers').Wallet | null, settings?: object, wssOk?: boolean }} [opts]
 */
export async function runStartupSelfCheck(opts = {}) {
  const settings = opts.settings || getSettings();
  const provider = opts.provider || makeProvider();
  const lines = [];
  const failures = [];

  let httpOk = false;
  let chainId = null;
  try {
    chainId = Number((await provider.getNetwork()).chainId);
    await provider.getBlockNumber();
    httpOk = true;
    lines.push(row('RPC HTTP', true));
  } catch (e) {
    lines.push(row('RPC HTTP', false, e.message));
    failures.push('RPC HTTP');
  }

  const wssOk = await probeWss(opts);
  const httpOnlyOk = allowHttpOnlyLive();
  const chainOn = settings.chainEnabled !== false && process.env.CHAIN_SCAN_ENABLED !== 'false';

  if (wssOk) {
    lines.push(row('WSS', true, 'PASS'));
  } else {
    lines.push(row('WSS', false, 'FAIL'));
    lines.push(row('HTTP FALLBACK', true, 'AVAILABLE'));
  }

  if (!wssOk && !httpOnlyOk) {
    failures.push('WSS');
  }

  const chainOk = chainId === CHAIN_ID;
  lines.push(row('CHAIN ID', chainOk, String(chainId ?? 'unknown')));
  if (httpOk && !chainOk) failures.push('CHAIN ID');

  const watch = (settings.chainWatchlist || []).filter((e) => e?.enabled && e?.address);
  const watchOk = !chainOn || watch.length > 0;
  lines.push(row('WATCHLIST', watchOk, 'PASS (' + watch.length + ')'));
  if (!watchOk) failures.push('WATCHLIST');

  const target = normalizeSymbol(settings.targetSymbol || process.env.TARGET_SYMBOL || '');
  const targetOk = target === 'CLOCKIN';
  lines.push(row('TARGET', targetOk, target || '(empty)'));
  if (!targetOk) failures.push('TARGET');

  let walletOk = false;
  let walletAddr = null;
  const w = opts.wallet;
  if (w) {
    walletAddr = w.address;
    try {
      const bal = await provider.getBalance(w.address);
      walletOk = bal > 0n;
      lines.push(row('WALLET', walletOk, w.address + ' ' + weiToEthNum(bal).toFixed(5) + ' ETH'));
      if (!walletOk) failures.push('WALLET');
    } catch (e) {
      lines.push(row('WALLET', false, e.message));
      failures.push('WALLET');
    }
  } else {
    lines.push(row('WALLET', false, 'NO PRIVATE_KEY'));
    failures.push('WALLET');
  }

  if (httpOk) {
    await initAggregator(provider);
  }
  const agg = getAggregatorStatus();
  const proxyCode = httpOk ? await provider.getCode(agg.proxy).catch(() => '0x') : '0x';
  const proxyOk = proxyCode && proxyCode !== '0x';
  lines.push(row('AGG PROXY', proxyOk, agg.proxy));
  lines.push(row('AGG IMPL', agg.validated, agg.implementation || 'unread'));
  lines.push(row('AGG ENCODER', agg.enabled, agg.enabled ? 'PASS' : 'disabled'));

  let v4Ok = Boolean(V4_QUOTER);
  if (v4Ok && httpOk) {
    const code = await provider.getCode(V4_QUOTER).catch(() => '0x');
    v4Ok = code && code !== '0x';
  }
  lines.push(row('V4', v4Ok, V4_QUOTER || 'V4_QUOTER unset'));

  if (httpOk && !agg.enabled && !v4Ok) {
    lines.push(row('BUY ROUTE', false, 'aggregator disabled and V4 unavailable'));
    failures.push('BUY ROUTE');
  }

  const p0 = new Set(['RPC HTTP', 'CHAIN ID', 'WATCHLIST', 'TARGET', 'WALLET', 'BUY ROUTE', 'WSS']);
  const p0Fail = failures.filter((f) => p0.has(f));
  const canArm = p0Fail.length === 0;
  const wssReason = !wssOk && !httpOnlyOk ? 'live_wss_required' : null;

  const summary = [
    '[READY]',
    'RPC HTTP       ' + (httpOk ? 'PASS' : 'FAIL'),
    'WSS             ' + (wssOk ? 'PASS' : 'FAIL'),
    'HTTP FALLBACK   ' + (wssOk ? 'STANDBY' : 'AVAILABLE'),
    'CHAIN ID       ' + (chainId ?? 'FAIL'),
    'WATCHLIST      ' + (watchOk ? 'PASS (' + watch.length + ')' : 'FAIL'),
    'AGG PROXY      ' + (proxyOk ? 'PASS' : 'FAIL'),
    'AGG IMPL       ' + (agg.validated ? 'PASS (' + agg.implementation + ')' : 'FAIL (' + (agg.implementation || 'n/a') + ')'),
    'AGG ENCODER    ' + (agg.enabled ? 'PASS' : 'DISABLED'),
    'V4             ' + (v4Ok ? 'PASS' : 'FAIL'),
    'TARGET         ' + (target || 'FAIL'),
    'WALLET         ' + (walletOk ? 'PASS' : 'FAIL'),
    'AUTO BUY        ' + (canArm ? 'ARMED' : 'DISARMED'),
    ...(wssReason ? ['REASON          ' + wssReason] : []),
  ].join('\n');

  auditEvent('startup_self_check', { canArm, failures: p0Fail, wallet: walletAddr, wssOk, wssReason });
  return {
    canArm,
    failures: p0Fail,
    reason: wssReason,
    lines,
    summary,
    httpOk,
    wssOk,
    chainId,
    watchCount: watch.length,
    target,
    walletOk,
    aggregator: agg,
    v4Ok,
  };
}

export { CHAIN_ID };
