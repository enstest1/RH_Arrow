/**
 * autobuy.js — dual-source launch detector: chain scanner (primary) + X (backup).
 *
 * DESIGN RULE: no limit logic here. swaprules.js gates spending.
 * routes/index.js discovers/executes. chainscanner.js owns block intake.
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { makeProvider } from './provider.js';
import {
  evaluateBuy,
  evaluateSourceTrust,
  evaluateTargetSymbol,
  ethToWei,
  weiToEthNum,
  normalizeSymbol,
} from './swaprules.js';
import { tokenMeta, V4_QUOTER } from './swap.js';
import {
  getSettings,
  saveSettings,
  alreadyBought,
  recordBuy,
  seenTweet,
  markTweet,
  listBuys,
  totalSpentEth,
  seenCandidate,
  markCandidate,
  getPendingCandidate,
  setPendingCandidate,
  clearPendingCandidate,
} from './autostate.js';
import { fetchHandleTweets, resetXTimelineCache } from './xtimeline.js';
import { startChainScanner, stopChainScanner, getChainScannerStatus } from './chainscanner.js';
import { auditEvent } from './auditlog.js';
import { normAddr } from './chainwatchlist.js';
import {
  discoverBestBuyRoute,
  executeRoute,
  routeAsQuote,
  initAggregator,
  getAggregatorStatus,
  detectLauncherContext,
} from './routes/index.js';

const CA_RE = /\b0x[a-fA-F0-9]{40}\b/;

function pollSec() {
  return Math.max(15, Number(process.env.AUTO_POLL_SEC) || 30);
}

function routeRetryMs() {
  return Math.max(50, Number(process.env.CHAIN_ROUTE_RETRY_MS) || 100);
}

function routeRetryWindowMs() {
  return Math.max(1000, Number(process.env.CHAIN_ROUTE_RETRY_WINDOW_MS) || 120000);
}

export const state = {
  running: false,
  watching: false,
  log: [],
  lastPollAt: null,
  lastError: null,
  pendingTarget: null,
  lastRouteStatus: null,
};

export function log(msg) {
  state.log.push('[' + new Date().toLocaleTimeString() + '] ' + msg);
  if (state.log.length > 300) state.log.shift();
  console.log('[autobuy] ' + msg);
}

export function extractCA(text) {
  const m = String(text || '').match(CA_RE);
  return m ? m[0] : null;
}

let _provider = null;
let _wallet = null;
let _timer = null;
/** Only true during executeRoute broadcast — NOT during route retries. */
let _buying = false;
let _xclient = null;
/** @type {Map<string, ReturnType<typeof setInterval>>} */
const _routeRetryTimers = new Map();
/** Bound concurrent candidate pipelines (symbol check + route discovery). */
const MAX_CANDIDATE_PIPELINES = Math.max(1, Number(process.env.MAX_CANDIDATE_PIPELINES) || 8);
let _candidateInFlight = 0;

function walletOrNull() {
  const k = process.env.PRIVATE_KEY;
  if (!k || k.includes('YOUR')) return null;
  if (!_provider) _provider = makeProvider();
  if (!_wallet) _wallet = new ethers.Wallet(k, _provider);
  return _wallet;
}

async function getXClient() {
  if (_xclient) return _xclient;
  const mod = await import('goat-x-pro');
  const XProClient = mod.XProClient || mod.default?.XProClient;
  if (!XProClient) throw new Error('goat-x-pro: XProClient export not found');
  const opts = {};
  if (process.env.X_COOKIES_JSON?.trim()) opts.cookies = JSON.parse(process.env.X_COOKIES_JSON);
  else opts.cookiesPath = process.env.X_COOKIES_PATH || './cookies.json';
  _xclient = new XProClient(opts);
  await _xclient.login();
  log('[X] client logged in');
  return _xclient;
}

function sourceLabel(source) {
  if (source.type === 'x') return '@' + String(source.handle || '').replace(/^@/, '');
  return (source.label || source.role || source.address || 'chain').slice(0, 24);
}

function stopRouteRetry(contract) {
  const k = String(contract).toLowerCase();
  const t = _routeRetryTimers.get(k);
  if (t) clearInterval(t);
  _routeRetryTimers.delete(k);
}

/**
 * Shared buy pipeline — chain and X both enter here.
 * @param {{ contract: string, source: object, timings?: object }} args
 */
export async function handleCandidate({ contract, source, timings = {} }) {
  if (_candidateInFlight >= MAX_CANDIDATE_PIPELINES) {
    auditEvent('candidate_deferred', { candidateContract: contract, reason: 'pipeline_full' });
    return { action: 'deferred', reason: 'pipeline_full' };
  }
  _candidateInFlight++;
  try {
    return await _handleCandidateInner({ contract, source, timings });
  } finally {
    _candidateInFlight--;
  }
}

async function _handleCandidateInner({ contract, source, timings = {} }) {
  const settings = getSettings();
  const w = walletOrNull();
  const addr = normAddr(contract);
  if (!addr) {
    auditEvent('target_rejected', { reason: 'invalid_contract', contract });
    return { action: 'skipped', reason: 'invalid_contract' };
  }

  auditEvent('candidate_detected', {
    sourceType: source.type,
    sourceAddress: source.address,
    sourceRole: source.role,
    handle: source.handle,
    candidateContract: addr,
    blockNumber: source.blockNumber,
    sourceTxHash: source.txHash,
  });

  if (alreadyBought(addr)) {
    log('⏭️  already bought ' + addr);
    auditEvent('duplicate_candidate', { candidateContract: addr, reason: 'already_bought' });
    return { action: 'skipped', reason: 'already_bought' };
  }

  const trust = evaluateSourceTrust(settings, source);
  if (!trust.ok) {
    log('⏭️  ' + trust.detail);
    auditEvent('target_rejected', { candidateContract: addr, reason: trust.reason });
    return { action: 'skipped', reason: trust.reason };
  }

  if (seenCandidate(addr) && source.type === 'chain') {
    const pending = getPendingCandidate(addr);
    if (!pending) {
      auditEvent('duplicate_candidate', { candidateContract: addr, reason: 'seen_candidate' });
      return { action: 'skipped', reason: 'duplicate_candidate' };
    }
  }

  if (!w) {
    log('❌ no PRIVATE_KEY loaded');
    return { action: 'skipped', reason: 'no_key' };
  }

  const provider = w.provider;
  const t0 = timings.candidateExtractedAt || Date.now();
  let meta;
  try {
    meta = await tokenMeta(provider, addr);
    timings.metadataCompletedAt = Date.now();
    auditEvent('candidate_metadata', {
      candidateContract: addr,
      symbol: meta.symbol,
      ms: timings.metadataCompletedAt - t0,
    });
  } catch (e) {
    log('⏭️  metadata failed: ' + e.message);
    auditEvent('target_rejected', { candidateContract: addr, reason: 'metadata_failed' });
    return { action: 'skipped', reason: 'metadata_failed' };
  }

  const symGate = evaluateTargetSymbol(settings, meta.symbol);
  if (!symGate.ok) {
    log('⏭️  ' + symGate.detail);
    auditEvent('target_rejected', {
      candidateContract: addr,
      symbol: meta.symbol,
      reason: symGate.reason,
    });
    return { action: 'skipped', reason: symGate.reason };
  }

  markCandidate(addr);
  const launcherCtx = detectLauncherContext(source);
  state.pendingTarget = {
    contract: addr,
    symbol: meta.symbol,
    source,
    launcher: launcherCtx,
    at: Date.now(),
  };

  auditEvent('target_match', {
    candidateContract: addr,
    symbol: meta.symbol,
    targetSymbol: settings.targetSymbol,
    sourceType: source.type,
  });

  const label = meta.symbol || addr.slice(0, 10) + '…';
  log('[' + source.type.toUpperCase() + '] ' + label + ' ' + addr + ' ← ' + sourceLabel(source));

  return attemptBuyWithRouteRetry({
    contract: addr,
    source,
    meta,
    settings,
    wallet: w,
    provider,
    timings,
    label,
  });
}

/** Backward-compatible X wrapper. */
export async function handleCA({ contract, handle, tweetUrl }) {
  auditEvent('x_candidate', { contract, handle, tweetUrl });
  return handleCandidate({
    contract,
    source: { type: 'x', handle, tweetUrl },
    timings: { candidateExtractedAt: Date.now() },
  });
}

async function attemptBuyWithRouteRetry(ctx) {
  const { contract, source, meta, settings, wallet, provider, timings, label } = ctx;
  const spendWei = ethToWei(settings.maxSpendEth);
  const slippagePct = Number(settings.slippageTolerancePct);

  const tryOnce = async (attempt) => {
    if (alreadyBought(contract)) {
      stopRouteRetry(contract);
      clearPendingCandidate(contract);
      return { action: 'skipped', reason: 'already_bought' };
    }

    timings.routeDiscoveryStartedAt = Date.now();
    auditEvent('route_retry', { candidateContract: contract, attempt });
    auditEvent('route_attempt', { candidateContract: contract, attempt });

    const route = spendWei > 0n
      ? await discoverBestBuyRoute({
        provider,
        token: contract,
        amountIn: spendWei,
        slippagePct,
        source,
      })
      : null;

    timings.routeFoundAt = route ? Date.now() : null;

    if (!route?.expectedOut) {
      auditEvent('route_missing', { candidateContract: contract, attempt });
      log('[ROUTE] no executable route yet (attempt ' + attempt + ')');
      setPendingCandidate(contract, { source, symbol: meta.symbol, attempts: attempt });
      state.lastRouteStatus = { contract, attempt, venues: getRouteCapabilityHints() };
      return null;
    }

    log('[ROUTE] ' + route.venue + ' expectedOut ' + route.expectedOut.toString() + ' — attempt ' + attempt);
    stopRouteRetry(contract);

    if (_buying) {
      log('⏳ buy in flight — deferring ' + contract);
      auditEvent('buy_gate_reject', { candidateContract: contract, reason: 'busy' });
      return { action: 'skipped', reason: 'busy' };
    }

    const balance = await provider.getBalance(wallet.address);
    const quote = routeAsQuote(route);
    const verdict = evaluateBuy({
      settings,
      alreadyBought: alreadyBought(contract),
      walletBalanceWei: balance,
      gasReserveWei: ethToWei('0.001'),
      quote,
      source,
      symbol: meta.symbol,
    });

    if (!verdict.ok) {
      log('⏭️  skipped: ' + verdict.detail);
      auditEvent('buy_gate_reject', { candidateContract: contract, reason: verdict.reason, detail: verdict.detail });
      return { action: 'skipped', reason: verdict.reason };
    }

    auditEvent('buy_gate_pass', { candidateContract: contract, spendWei: String(verdict.spendWei), venue: route.venue });

    _buying = true;
    timings.sendStartedAt = Date.now();
    auditEvent('buy_send_start', { candidateContract: contract, venue: route.venue });
    log('[BUY] sending ' + weiToEthNum(verdict.spendWei).toFixed(5) + ' ETH via ' + route.venue + ' of ' + label + '…');

    try {
      const result = await executeRoute({
        route: { ...route, amountIn: verdict.spendWei },
        wallet,
        provider,
        settings,
      });

      timings.txSubmittedAt = Date.now();

      if (!result.sent) {
        log('❌ buy failed: ' + result.error);
        auditEvent('pipeline_error', { candidateContract: contract, error: result.error, venue: route.venue });
        return { action: 'failed', reason: result.error };
      }

      clearPendingCandidate(contract);
      recordBuy(contract, {
        txHash: result.txHash,
        spendWei: String(verdict.spendWei),
        symbol: meta.symbol,
        sourceType: source.type,
        handle: source.handle,
        tweetUrl: source.tweetUrl,
        chainTx: source.txHash,
        venue: route.venue,
      });

      auditEvent('buy_submitted', { candidateContract: contract, txHash: result.txHash, venue: route.venue });
      log('🚀 BOUGHT ' + label + ' via ' + route.venue + ' — tx ' + result.txHash);

      const candMs = timings.candidateExtractedAt
        ? timings.txSubmittedAt - timings.candidateExtractedAt
        : null;
      if (candMs != null) log('[LATENCY] candidate→submission: ' + candMs + 'ms');

      void result.tx?.wait?.().then((r) => {
        timings.confirmationAt = Date.now();
        auditEvent(r?.status === 1 ? 'buy_confirmed' : 'buy_reverted', {
          candidateContract: contract,
          txHash: result.txHash,
          blockNumber: r?.blockNumber,
        });
        log(r?.status === 1 ? '✅ CONFIRMED block ' + r.blockNumber : '❌ REVERTED block ' + r.blockNumber);
      }).catch((e) => log('⚠️ confirmation wait failed: ' + e.message));

      state.pendingTarget = null;
      return { action: 'bought', txHash: result.txHash, venue: route.venue };
    } finally {
      _buying = false;
    }
  };

  const first = await tryOnce(1);
  if (first) return first;

  const key = contract.toLowerCase();
  if (_routeRetryTimers.has(key)) return { action: 'pending', reason: 'no_route_yet' };

  const started = Date.now();
  let attempt = 1;
  const interval = routeRetryMs();
  const window = routeRetryWindowMs();

  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      if (Date.now() - started > window) {
        stopRouteRetry(contract);
        clearPendingCandidate(contract);
        log('[ROUTE] timeout — no executable route for ' + contract);
        auditEvent('route_timeout', { candidateContract: contract });
        resolve({ action: 'skipped', reason: 'route_timeout' });
        return;
      }
      attempt++;
      try {
        const r = await tryOnce(attempt);
        if (r) {
          stopRouteRetry(contract);
          resolve(r);
        }
      } catch (e) {
        log('[ROUTE] retry error: ' + e.message);
      }
    }, interval);
    _routeRetryTimers.set(key, timer);
  });
}

function getRouteCapabilityHints() {
  const agg = getAggregatorStatus();
  return {
    launcher: 'unverified',
    aggregator: agg.enabled ? 'available' : 'disabled',
    v4: Boolean(V4_QUOTER),
  };
}

async function pollOnce() {
  const settings = getSettings();
  if (!settings.xEnabled || !settings.handles?.length) return;

  await getXClient();
  for (const raw of settings.handles) {
    const handle = String(raw).replace(/^@/, '').trim();
    if (!handle) continue;
    try {
      const tweets = await fetchHandleTweets(handle, 10);
      let newCount = 0;
      let caFound = 0;

      for (const t of tweets || []) {
        if (!t?.id || seenTweet(t.id)) continue;
        markTweet(t.id);
        newCount++;
        const ca = extractCA(t.text);
        if (!ca) continue;
        caFound++;
        void handleCA({
          contract: ca,
          handle,
          tweetUrl: 'https://x.com/' + handle + '/status/' + t.id,
        }).catch((e) => log('[X] handleCA: ' + e.message));
      }
      log('[X] polled @' + handle + ' — ' + (tweets?.length || 0) + ' tweets' +
          (newCount ? ', ' + newCount + ' new' : '') +
          (caFound ? ', ' + caFound + ' with CA' : ', no CA'));
    } catch (e) {
      if (/401|403|authenticate/i.test(String(e.message))) {
        _xclient = null;
        resetXTimelineCache();
      }
      log('[X] poll @' + handle + ': ' + e.message);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  state.lastPollAt = Date.now();
}

export async function startWatching() {
  if (state.watching) return { ok: true, already: true };
  const settings = getSettings();
  state.watching = true;

  log('[LIVE] target ' + normalizeSymbol(settings.targetSymbol || process.env.TARGET_SYMBOL || 'CLOCKIN'));

  const w = walletOrNull();
  if (w) {
    try {
      const bal = await w.provider.getBalance(w.address);
      log('[WALLET] ' + w.address + ' balance ' + weiToEthNum(bal).toFixed(5) + ' ETH');
    } catch {}
    await initAggregator(w.provider);
  } else {
    log('⚠️  no wallet — detection only');
  }

  if (settings.chainEnabled !== false && process.env.CHAIN_SCAN_ENABLED !== 'false') {
    const n = (settings.chainWatchlist || []).filter((e) => e.enabled).length;
    log('[CHAIN] ' + n + ' watched addresses loaded');
    startChainScanner({
      onCandidate: handleCandidate,
      log,
      getSettings,
    });
  }

  if (settings.xEnabled !== false) {
    const handles = (settings.handles || []).map((h) => '@' + String(h).replace(/^@/, ''));
    const pollMs = pollSec() * 1000;
    _timer = setInterval(() => {
      pollOnce().catch((e) => log('[X] poll cycle: ' + e.message));
    }, pollMs);
    log('[X] watching ' + handles.join(', ') + ' every ' + pollSec() + 's');
    pollOnce().catch(() => {});
  }

  auditEvent('live_armed', { targetSymbol: settings.targetSymbol });
  log('[LIVE] auto-buy armed');
  return { ok: true };
}

export function stopWatching() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  stopChainScanner();
  for (const k of [..._routeRetryTimers.keys()]) stopRouteRetry(k);
  state.watching = false;
  saveSettings({ enabled: false });
  log('⏹️ stopped watching');
  return { ok: true };
}

export async function readAutoStatus() {
  const settings = getSettings();
  const w = walletOrNull();
  const chain = getChainScannerStatus();
  const agg = getAggregatorStatus();
  const out = {
    settings,
    watching: state.watching,
    log: state.log,
    lastPollAt: state.lastPollAt,
    quoterSet: Boolean(V4_QUOTER),
    wallet: null,
    balanceEth: null,
    buys: listBuys(10),
    totalSpentEth: totalSpentEth(),
    pendingTarget: state.pendingTarget,
    targetSymbol: settings.targetSymbol,
    watchAddressCount: (settings.chainWatchlist || []).filter((e) => e.enabled).length,
    chainWatching: chain.chainWatching,
    chainMode: chain.chainMode,
    wsConnected: chain.wsConnected,
    lastProcessedBlock: chain.lastProcessedBlock,
    lastChainSignal: chain.lastChainSignal,
    aggregator: agg,
    routes: getRouteCapabilityHints(),
    candidatePipelinesInFlight: _candidateInFlight,
  };
  if (w) {
    out.wallet = w.address;
    try { out.balanceEth = Number(ethers.formatEther(await w.provider.getBalance(w.address))); } catch {}
  }
  return out;
}

export { saveSettings, getSettings } from './autostate.js';
