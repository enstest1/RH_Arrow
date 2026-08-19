/**
 * prearm.js — read-only launch readiness. Never ARM, never sendTransaction.
 *
 * Tests inject opts so this file never needs a live socket.
 */
import { ethers } from 'ethers';
import { makeProvider, makeEventProvider, wssUrlConfigured } from './provider.js';
import { getHttpPool, listHttpEndpoints, listWssEndpoints, peekWssEndpoint } from './rpcpool.js';
import { allowHttpOnlyLive } from './readiness.js';
import { getSettings } from './autostate.js';
import { normalizeSymbol, weiToEthNum } from './swaprules.js';
import { initAggregator, getAggregatorStatus } from './routes/aggregator.js';
import { V4_QUOTER, UNIVERSAL_ROUTER } from './swap.js';
import {
  AGGREGATOR_PROXY,
  AGGREGATOR_EXPECTED_IMPL,
  EIP1967_IMPL_SLOT,
} from './routes/constants.js';
import { fetchHandleTweets } from './xtimeline.js';
import { getChainScannerStatus } from './chainscanner.js';
import {
  buySizeMode,
  totalBudgetWei,
  estimateBudgetSnapshot,
  gasReserveMultiplier,
  MIN_BUY_WEI,
} from './buybudget.js';

const CHAIN_ID = 4663;

function yn(ok) {
  return ok ? 'PASS' : 'FAIL';
}

function pad(name) {
  return String(name).padEnd(17, ' ');
}

/**
 * @param {{
 *   provider?: import('ethers').Provider,
 *   wallet?: { address: string } | null,
 *   settings?: object,
 *   chainId?: number,
 *   httpLatencyMs?: Record<string, number>,
 *   wssObserve?: { primary?: { ok: boolean, blocks: number, label?: string }, secondary?: { ok: boolean, blocks: number, label?: string } },
 *   scanner?: { liveLag?: number|null, scannerHealth?: string, backgroundLag?: number|null },
 *   xPoll?: { ok: boolean, detail?: string },
 *   skipNetwork?: boolean,
 *   agg?: object,
 *   v4Ok?: boolean,
 *   balanceWei?: bigint,
 * }} [opts]
 */
export async function runPrearm(opts = {}) {
  const settings = opts.settings || getSettings();
  const provider = opts.provider || (opts.skipNetwork ? null : makeProvider());
  const rows = [];
  const fail = [];

  const push = (name, ok, detail) => {
    rows.push({ name, ok, detail: detail || '' });
    if (!ok) fail.push(name);
  };

  let chainId = opts.chainId;
  if (chainId == null && provider) {
    try { chainId = Number((await provider.getNetwork()).chainId); } catch { chainId = null; }
  }
  push('CHAIN', chainId === CHAIN_ID, String(chainId ?? 'unknown'));

  const httpSnap = opts.httpLatencyMs || null;
  let activeHttp = opts.activeHttp || '';
  if (httpSnap) {
    const keys = Object.keys(httpSnap);
    push('HTTP PRIMARY', Number.isFinite(httpSnap[keys[0]]) && httpSnap[keys[0]] >= 0, 'latency=' + httpSnap[keys[0]] + 'ms');
    if (keys[1]) {
      push('HTTP SECONDARY', Number.isFinite(httpSnap[keys[1]]) && httpSnap[keys[1]] >= 0, 'latency=' + httpSnap[keys[1]] + 'ms');
    } else {
      rows.push({ name: 'HTTP SECONDARY', ok: true, detail: 'NOT CONFIGURED' });
    }
    activeHttp = opts.activeHttp || String(keys[0] || '').toLowerCase();
  } else if (provider && !opts.skipNetwork) {
    const pool = getHttpPool();
    try { await provider.getBlockNumber(); } catch { /* endpoint health recorded on the pool */ }
    const snap = pool.snapshot();
    activeHttp = snap.activeHttpProvider || pool.activeLabel;
    const eps = snap.endpoints || [];
    const primary = eps[0];
    const secondary = eps[1];
    const tertiary = eps[2];
    if (primary) {
      rows.push({
        name: 'HTTP PRIMARY',
        ok: primary.healthy && !primary.rateLimited,
        detail: primary.label + (primary.rateLimited ? ' 429' : '') + (primary.latencyMs != null ? ' latency=' + primary.latencyMs + 'ms' : ''),
      });
    } else {
      push('HTTP PRIMARY', false, 'not configured');
    }
    if (secondary) {
      rows.push({
        name: 'HTTP SECONDARY',
        ok: secondary.healthy || Boolean(activeHttp),
        detail: secondary.label + (secondary.healthy ? ' healthy' : (secondary.rateLimited ? ' 429' : ' standby')),
      });
    } else {
      rows.push({ name: 'HTTP SECONDARY', ok: true, detail: 'NOT CONFIGURED' });
    }
    if (tertiary) {
      rows.push({
        name: 'HTTP TERTIARY',
        ok: true,
        detail: tertiary.label,
      });
    }
    const anyHttp = eps.some((e) => e.healthy && !e.rateLimited) || Boolean(activeHttp);
    if (!anyHttp) fail.push('HTTP PRIMARY');
  } else {
    push('HTTP PRIMARY', false, 'no provider');
  }
  rows.push({ name: 'ACTIVE HTTP', ok: Boolean(activeHttp), detail: activeHttp || 'n/a' });

  const httpOnly = allowHttpOnlyLive();
  let wssPrimary = opts.wssObserve?.primary;
  let wssSecondary = opts.wssObserve?.secondary;
  if (!opts.wssObserve && !opts.skipNetwork) {
    try {
      wssPrimary = await observeWssBlocks(makeEventProvider(), peekWssEndpoint()?.label || 'wss-primary');
    } catch (e) {
      wssPrimary = { ok: false, blocks: 0, label: 'wss-primary', detail: e.shortMessage || e.message };
    }
    const list = listWssEndpoints();
    wssSecondary = list[1]
      ? { ok: true, blocks: 0, label: list[1].label, standby: true }
      : { ok: true, blocks: 0, label: 'NOT CONFIGURED', notConfigured: true };
  }
  const wssBlocksOk = Boolean(wssPrimary?.ok && (wssPrimary.blocks > 0 || wssPrimary.pingOnly));
  const activeWss = wssBlocksOk ? (wssPrimary?.label || '') : '';
  if (wssPrimary) {
    push(
      'WSS PRIMARY',
      wssBlocksOk,
      wssPrimary.standby ? 'STANDBY' : (wssBlocksOk ? 'blocks advancing (' + wssPrimary.blocks + ')' : (wssPrimary.detail || 'no block events')),
    );
  } else {
    push('WSS PRIMARY', false, wssUrlConfigured() ? 'no observe result' : 'not configured');
  }
  if (wssSecondary?.notConfigured || wssSecondary?.label === 'none') {
    rows.push({ name: 'WSS SECONDARY', ok: true, detail: 'NOT CONFIGURED' });
  } else if (wssSecondary?.standby) {
    rows.push({ name: 'WSS SECONDARY', ok: true, detail: 'STANDBY ' + (wssSecondary.label || '') });
  } else if (wssSecondary) {
    push('WSS SECONDARY', wssSecondary.ok, wssSecondary.detail || (wssSecondary.ok ? 'PASS' : 'FAIL'));
  }
  rows.push({ name: 'ACTIVE WSS', ok: Boolean(activeWss) || httpOnly, detail: activeWss || (httpOnly ? 'http-fallback' : 'none') });

  const scanner = opts.scanner || getChainScannerStatus();
  const liveLag = scanner.liveLag;
  const liveOk = liveLag != null && liveLag <= 2 && (scanner.scannerHealth === 'CURRENT' || scanner.scannerHealth == null);
  rows.push({
    name: 'SCANNER HEALTH',
    ok: !opts.scanner && !scanner.chainWatching ? true : liveOk,
    detail: (opts.scanner || scanner.chainWatching)
      ? (scanner.scannerHealth || 'n/a')
      : 'not running (prearm does not ARM)',
  });
  if (opts.scanner || scanner.chainWatching) {
    push('LIVE SCANNER', liveOk, (scanner.scannerHealth || '') + ' liveLag=' + (liveLag ?? 'n/a'));
  } else {
    rows.push({ name: 'LIVE SCANNER', ok: true, detail: 'not running (prearm does not ARM)' });
  }
  rows.push({
    name: 'LIVE LAG',
    ok: liveLag == null || liveLag <= 2,
    detail: String(liveLag ?? 'n/a'),
  });
  if (liveLag != null && liveLag > 2) fail.push('LIVE SCANNER');
  rows.push({
    name: 'BACKGROUND LAG',
    ok: true,
    detail: String(scanner.backgroundLag ?? 'n/a') + ' (ignored for readiness)',
  });

  let xPoll = opts.xPoll;
  if (!xPoll && !opts.skipNetwork) {
    try {
      const tweets = await Promise.race([
        fetchHandleTweets('clockincoin', 5),
        new Promise((_, rej) => setTimeout(() => rej(new Error('x_poll_timeout')), 15000)),
      ]);
      xPoll = { ok: true, detail: (tweets?.length || 0) + ' tweets' };
    } catch (e) {
      const msg = e.message || String(e);
      xPoll = { ok: !/Bun is not defined/i.test(msg), detail: msg };
      if (/Bun is not defined/i.test(msg)) xPoll.ok = false;
    }
  }
  if (xPoll) push('X POLL', xPoll.ok, xPoll.detail || '');

  let agg = opts.agg;
  if (!agg && provider && !opts.skipNetwork) {
    await initAggregator(provider);
    agg = getAggregatorStatus();
    const proxyCode = await provider.getCode(AGGREGATOR_PROXY).catch(() => '0x');
    agg = { ...agg, proxyCodeOk: Boolean(proxyCode && proxyCode !== '0x') };
  }
  agg = agg || getAggregatorStatus();
  push('AGG PROXY', agg.proxyCodeOk !== false && Boolean(agg.proxy), agg.proxy || AGGREGATOR_PROXY);
  push('AGG IMPL', Boolean(agg.validated), agg.implementation || 'unread');
  push('AGG ENCODER', Boolean(agg.enabled), agg.enabled ? 'PASS' : 'disabled');
  rows.push({ name: 'AGG FEE RAW', ok: true, detail: String(agg.feeRateRaw ?? 'n/a') });
  if (agg.implementation && agg.validated === false) {
    /* encoder fail is not a P0 if V4 works — handled below */
  }

  let v4Ok = opts.v4Ok;
  if (v4Ok == null) {
    v4Ok = Boolean(V4_QUOTER);
    if (v4Ok && provider && !opts.skipNetwork) {
      const q = await provider.getCode(V4_QUOTER).catch(() => '0x');
      const r = await provider.getCode(UNIVERSAL_ROUTER).catch(() => '0x');
      v4Ok = Boolean(q && q !== '0x' && r && r !== '0x');
    }
  }
  push('V4', v4Ok, V4_QUOTER || 'V4_QUOTER unset');

  if (!agg.enabled && !v4Ok) push('BUY ROUTE', false, 'aggregator disabled and V4 unavailable');

  const target = normalizeSymbol(settings.targetSymbol || process.env.TARGET_SYMBOL || '');
  push('TARGET', target === 'CLOCKIN', target || '(empty)');

  const w = opts.wallet;
  let balWei = opts.balanceWei;
  if (w && provider && balWei == null && !opts.skipNetwork) {
    try { balWei = await provider.getBalance(w.address); } catch { balWei = 0n; }
  }
  const mode = buySizeMode(settings);
  const budgetWei = totalBudgetWei(settings);
  const budgetEth = Number(ethers.formatEther(budgetWei));
  const slip = Number(settings.slippageTolerancePct || process.env.PREARM_SLIPPAGE || '0');
  let budgetSnap = opts.budget || null;
  if (!budgetSnap && provider && w?.address && !opts.skipNetwork) {
    try {
      const aggEst = await estimateBudgetSnapshot(provider, w.address, settings, 'aggregator');
      const v4Est = await estimateBudgetSnapshot(provider, w.address, settings, 'v4');
      budgetSnap = {
        ...aggEst.snapshot,
        v4GasReserveEth: v4Est.snapshot.gasReserveEth,
        v4SafeTokenInputEth: v4Est.snapshot.safeTokenInputEth,
        multiplier: gasReserveMultiplier(settings),
        ok: aggEst.ok,
      };
      if (balWei == null) balWei = aggEst.walletBalanceWei;
    } catch { /* representative estimate unavailable */ }
  }
  const walletOk = Boolean(w?.address) && balWei != null && balWei >= MIN_BUY_WEI;
  if (!w?.address) push('WALLET', false, 'NO PRIVATE_KEY');
  else push('WALLET', walletOk, w.address.slice(0, 6) + '…' + w.address.slice(-4));
  rows.push({ name: 'BALANCE', ok: walletOk, detail: balWei != null ? (weiToEthNum(balWei).toFixed(5) + ' ETH') : 'n/a' });
  rows.push({ name: 'BUY MODE', ok: mode === 'auto-safe' || mode === 'fixed', detail: mode.toUpperCase() });
  rows.push({ name: 'TOTAL BUDGET', ok: budgetEth > 0, detail: budgetEth.toFixed(3) + ' ETH' });
  rows.push({
    name: 'EST GAS RESERVE',
    ok: true,
    detail: budgetSnap?.gasReserveEth
      ? budgetSnap.gasReserveEth + ' ETH (×' + (budgetSnap.multiplier || gasReserveMultiplier(settings)) + ', venue fallback until CLOCKIN route exists)'
      : 'computed at send',
  });
  rows.push({
    name: 'SAFE BUY ESTIMATE',
    ok: budgetSnap?.ok !== false,
    detail: budgetSnap?.safeTokenInputEth
      ? budgetSnap.safeTokenInputEth + ' ETH (recalculated immediately before send)'
      : 'pending live route',
  });
  push('SLIPPAGE', slip > 0 && slip <= 50, slip + '%');
  rows.push({ name: 'REAL SENDS', ok: true, detail: '0' });

  const watch = (settings.chainWatchlist || []).filter((e) => e?.enabled && e?.address);
  push('WATCHLIST', watch.length > 0, String(watch.length));

  if (!httpOnly && !wssBlocksOk && !opts.skipNetwork) {
    if (!fail.includes('WSS PRIMARY')) fail.push('WSS PRIMARY');
  }

  const ready = fail.length === 0;
  const text = formatPrearm({
    rows,
    ready,
    liveLag,
    backgroundLag: scanner.backgroundLag,
    target,
    slip,
    balWei,
    agg,
  });
  return { ok: ready, ready, fail, rows, text, summary: text };
}

/**
 * Observe that WSS actually delivers block subscriptions — open is not enough.
 * @param {import('ethers').WebSocketProvider | null} ws
 * @param {string} label
 * @param {number} [ms]
 */
export async function observeWssBlocks(ws, label, ms = 6000) {
  if (!ws) return { ok: false, blocks: 0, label, detail: 'no provider' };
  let blocks = 0;
  const onBlock = () => { blocks += 1; };
  const onErr = () => {};
  try {
    ws.on('error', onErr);
    try { ws.websocket?.on?.('error', onErr); } catch { /* ignore */ }
    ws.on('block', onBlock);
    const ping = ws.getBlockNumber().catch(() => null);
    await Promise.race([
      ping,
      new Promise((_, rej) => setTimeout(() => rej(new Error('wss_ping_timeout')), 4000)),
    ]).catch(() => null);
    const deadline = Date.now() + Math.min(ms, 4000);
    while (Date.now() < deadline && blocks < 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return {
      ok: blocks > 0,
      blocks,
      label,
      detail: blocks > 0 ? 'blocks advancing' : 'opened but no block events',
    };
  } catch (e) {
    return { ok: false, blocks, label, detail: e.shortMessage || e.message };
  } finally {
    try { ws.off?.('block', onBlock); } catch { /* ignore */ }
    try { ws.destroy?.(); } catch { /* ignore */ }
  }
}

function formatPrearm({ rows, ready, liveLag, backgroundLag, target, slip, balWei, agg }) {
  const map = Object.fromEntries(rows.map((r) => [r.name, r]));
  const line = (key, fallback = '') => {
    const r = map[key];
    if (!r) return pad(key) + ' ' + fallback;
    return pad(key) + ' ' + yn(r.ok) + (r.detail ? ' ' + r.detail : '');
  };
  const info = (key, extra = '') => {
    const r = map[key];
    if (!r) return pad(key) + ' ' + extra;
    return pad(key) + ' ' + (r.detail || extra);
  };
  const lines = [
    '[PREARM]',
    '',
    line('CHAIN'),
    '',
    line('HTTP PRIMARY'),
    line('HTTP SECONDARY'),
    info('ACTIVE HTTP'),
    '',
    line('WSS PRIMARY'),
    info('WSS SECONDARY'),
    info('ACTIVE WSS'),
    '',
    info('SCANNER HEALTH'),
    pad('LIVE LAG') + ' ' + String(liveLag ?? map['LIVE LAG']?.detail ?? 'n/a'),
    pad('BACKGROUND LAG') + ' ' + String(backgroundLag ?? 'n/a') + ' (ignored for readiness)',
    '',
    line('X POLL'),
    '',
    line('AGG PROXY'),
    line('AGG IMPL'),
    line('AGG ENCODER'),
    pad('AGG FEE') + ' ' + String(agg?.feeRateRaw ?? map['AGG FEE RAW']?.detail ?? 'n/a'),
    '',
    line('V4'),
    '',
    pad('TARGET') + ' ' + (target || 'FAIL'),
    '',
    line('WALLET'),
    pad('BALANCE') + ' ' + (balWei != null ? weiToEthNum(balWei).toFixed(5) + ' ETH' : 'n/a'),
    info('BUY MODE'),
    info('TOTAL BUDGET'),
    info('EST GAS RESERVE'),
    info('SAFE BUY ESTIMATE'),
    pad('SLIPPAGE') + ' ' + slip + '%',
    '',
    pad('REAL SENDS') + ' 0',
    pad('AUTO BUY') + ' DISARMED',
    '',
    pad('FINAL') + ' ' + (ready ? 'READY TO ARM' : 'NOT READY'),
  ];
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

export { EIP1967_IMPL_SLOT, AGGREGATOR_PROXY, AGGREGATOR_EXPECTED_IMPL };
