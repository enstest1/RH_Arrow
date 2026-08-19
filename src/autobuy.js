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
import { startChainScanner, stopChainScanner, getChainScannerStatus, isChainBuyBlocked } from './chainscanner.js';
import { evaluateChainCandidateFreshness } from './chainfreshness.js';
import { auditEvent } from './auditlog.js';
import { normAddr } from './chainwatchlist.js';
import {
  discoverBestBuyRoute,
  executeRoute,
  routeAsQuote,
  getAggregatorStatus,
  detectLauncherContext,
  sizeRouteForWallet,
} from './routes/index.js';
import { runStartupSelfCheck } from './readiness.js';
import { classifyCandidateResult, startRetryLoop } from './candidateretry.js';
import {
  estimateTxGasCost,
  computeSafeBuy,
  totalBudgetWei,
  buySizeMode,
  snapshotBudget,
  estimateBudgetSnapshot,
} from './buybudget.js';

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
  /** True only after startWatching P0 self-check. Detection-only never sets this. */
  armed: false,
  log: [],
  lastPollAt: null,
  lastError: null,
  pendingTarget: null,
  lastRouteStatus: null,
  lastReadiness: null,
  xPoll: { healthy: null, lastAt: null, error: null },
  lastBudget: null,
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
/** @type {Map<string, { stop: Function, getAttempt?: Function, startedAt?: number }>} */
const _routeRetryTimers = new Map();
/** Bound concurrent candidate pipelines (symbol check + route discovery). */
const MAX_CANDIDATE_PIPELINES = Math.max(1, Number(process.env.MAX_CANDIDATE_PIPELINES) || 8);
let _candidateInFlight = 0;
/** Same CA from chain + X must not run two pipelines. */
const _activeCandidates = new Set();

function walletOrNull() {
  const k = process.env.PRIVATE_KEY;
  if (!k || k.includes('YOUR')) return null;
  if (!_provider) _provider = makeProvider();
  if (!_wallet) _wallet = new ethers.Wallet(k, _provider);
  return _wallet;
}

/**
 * Optional XProClient for non-poll helpers. Cookies are loaded with Node fs
 * so goat-x-pro's Bun.file() path is never used.
 */
async function getXClient() {
  if (_xclient) return _xclient;
  const { loadXCookies } = await import('./xcookies.js');
  const mod = await import('goat-x-pro');
  const XProClient = mod.XProClient || mod.default?.XProClient;
  if (!XProClient) throw new Error('goat-x-pro: XProClient export not found');
  const cookies = await loadXCookies(process.env.X_COOKIES_PATH || './cookies.json');
  _xclient = new XProClient({ cookies });
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
  const h = _routeRetryTimers.get(k);
  if (h?.stop) h.stop();
  _routeRetryTimers.delete(k);
  _activeCandidates.delete(k);
}

/**
 * Shared buy pipeline — chain and X both enter here.
 * @param {{ contract: string, source: object, timings?: object, dryRun?: boolean, provider?: import('ethers').Provider, wallet?: { address: string, provider?: import('ethers').Provider } }} args
 */
export async function handleCandidate({ contract, source, timings = {}, dryRun = false, provider: injectedProvider, wallet: injectedWallet }) {
  const windowMs = routeRetryWindowMs();
  const started = timings.candidateExtractedAt || Date.now();
  if (Date.now() - started > windowMs) {
    auditEvent('candidate_expired', { candidateContract: contract });
    return { action: 'skipped', reason: 'route_timeout', status: 'terminal' };
  }
  if (_candidateInFlight >= MAX_CANDIDATE_PIPELINES) {
    auditEvent('candidate_deferred', { candidateContract: contract, reason: 'pipeline_full' });
    setTimeout(() => {
      handleCandidate({
        contract,
        source,
        timings: { ...timings, candidateExtractedAt: started },
        dryRun,
        provider: injectedProvider,
        wallet: injectedWallet,
      }).catch((e) => log('[CHAIN] deferred candidate: ' + e.message));
    }, routeRetryMs());
    return { action: 'deferred', reason: 'pipeline_full', status: 'retry' };
  }
  _candidateInFlight++;
  try {
    return await _handleCandidateInner({
      contract,
      source,
      timings: { ...timings, candidateExtractedAt: started },
      dryRun,
      injectedProvider,
      injectedWallet,
    });
  } finally {
    _candidateInFlight--;
  }
}

async function _handleCandidateInner({ contract, source, timings = {}, dryRun = false, injectedProvider, injectedWallet }) {
  // Detection-only / DISARMED: simulate the pipeline but never broadcast.
  if (!dryRun && !state.armed) dryRun = true;
  const settings = getSettings();
  const w = injectedWallet || walletOrNull();
  const addr = normAddr(contract);
  if (!addr) {
    auditEvent('candidate_rejected', { reason: 'invalid_contract', contract });
    return { action: 'skipped', reason: 'invalid_contract', status: 'terminal' };
  }
  const lockKey = addr.toLowerCase();
  if (_activeCandidates.has(lockKey) || _routeRetryTimers.has(lockKey)) {
    auditEvent('candidate_deduped', { candidateContract: addr, reason: 'in_flight' });
    return { action: 'skipped', reason: 'duplicate_candidate' };
  }
  _activeCandidates.add(lockKey);
  try {
    return await _handleCandidateLocked({
      addr, source, timings, dryRun, injectedProvider, injectedWallet, settings, w,
    });
  } finally {
    if (!_routeRetryTimers.has(lockKey)) _activeCandidates.delete(lockKey);
  }
}

async function _handleCandidateLocked({ addr, source, timings = {}, dryRun = false, injectedProvider, injectedWallet, settings, w }) {
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
    auditEvent('candidate_rejected', { candidateContract: addr, reason: 'already_bought' });
    return { action: 'skipped', reason: 'already_bought', status: 'terminal' };
  }

  const trust = evaluateSourceTrust(settings, source);
  if (!trust.ok) {
    log('⏭️  ' + trust.detail);
    auditEvent('candidate_rejected', { candidateContract: addr, reason: trust.reason });
    return { action: 'skipped', reason: trust.reason, status: 'terminal' };
  }

  if (_routeRetryTimers.has(addr.toLowerCase()) || seenCandidate(addr) || getPendingCandidate(addr)) {
    auditEvent('candidate_deduped', { candidateContract: addr, reason: 'seen_candidate' });
    return { action: 'skipped', reason: 'duplicate_candidate', status: 'terminal' };
  }

  if (!w && !dryRun) {
    log('❌ no PRIVATE_KEY loaded');
    auditEvent('candidate_rejected', { candidateContract: addr, reason: 'no_key' });
    return { action: 'skipped', reason: 'no_key', status: 'terminal' };
  }

  const provider = injectedProvider || w?.provider;
  if (!provider) {
    auditEvent('candidate_rejected', { candidateContract: addr, reason: 'no_provider' });
    return { action: 'skipped', reason: 'no_provider', status: 'terminal' };
  }

  if (source.type === 'chain') {
    let currentHead = getChainScannerStatus().httpHead;
    try {
      const h = await provider.getBlockNumber();
      if (Number.isFinite(Number(h))) {
        currentHead = currentHead == null ? Number(h) : Math.max(currentHead, Number(h));
      }
    } catch { /* scanner head still used */ }
    const fresh = evaluateChainCandidateFreshness({
      source: { ...source, detectedAt: source.detectedAt || timings.candidateExtractedAt },
      currentHead,
      liveHealth: getChainScannerStatus().scannerHealth,
      chainBuyBlocked: isChainBuyBlocked(),
      dryRun,
    });
    if (!fresh.ok) {
      log('[CANDIDATE] stale chain launch ignored token=' + addr
        + ' sourceBlock=' + (fresh.sourceBlock ?? source.blockNumber)
        + ' currentHead=' + (fresh.currentHead ?? currentHead)
        + ' ageBlocks=' + (fresh.ageBlocks ?? 'n/a'));
      auditEvent('candidate_rejected', {
        candidateContract: addr,
        reason: fresh.reason,
        sourceBlock: fresh.sourceBlock,
        currentHead: fresh.currentHead,
        ageBlocks: fresh.ageBlocks,
      });
      return { action: 'skipped', reason: fresh.reason, status: 'terminal' };
    }
  }

  const wallet = w || { address: '0x0000000000000000000000000000000000000001', provider };
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
    auditEvent('candidate_rejected', { candidateContract: addr, reason: 'metadata_failed' });
    return { action: 'skipped', reason: 'metadata_failed', status: 'terminal' };
  }

  const symGate = evaluateTargetSymbol(settings, meta.symbol);
  if (!symGate.ok) {
    log('⏭️  ' + symGate.detail);
    auditEvent('candidate_rejected', {
      candidateContract: addr,
      symbol: meta.symbol,
      reason: symGate.reason,
    });
    return { action: 'skipped', reason: symGate.reason, status: 'terminal' };
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
    wallet,
    provider,
    timings,
    label,
    dryRun,
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

/**
 * Discover + simulate + execute with a self-scheduling retry worker.
 * Busy wallets and failed sends stay in the retry window; they are not dropped.
 * @param {{ contract: string, source: object, meta: object, settings: object, wallet: { address: string }, provider: import('ethers').Provider, timings: object, label: string, dryRun?: boolean }} ctx
 */
async function attemptBuyWithRouteRetry(ctx) {
  const { contract, source, meta, settings, wallet, provider, timings, label, dryRun } = ctx;
  const slippagePct = Number(settings.slippageTolerancePct);
  const started = Date.now();
  log('[TAX] launch tax check unavailable for this route');

  /**
   * Probe amount for discovery only. Final token input is sized after the route
   * is known so aggregator vs V4 gas can differ.
   * @returns {Promise<bigint>}
   */
  async function probeAmountWei() {
    const walletBalanceWei = await provider.getBalance(wallet.address).catch(() => 0n);
    const budgetWei = totalBudgetWei(settings);
    const gas = await estimateTxGasCost(provider, null, { venue: 'aggregator', skipEstimate: true });
    const probe = computeSafeBuy({
      walletBalanceWei,
      totalBudgetWei: budgetWei,
      gasReserveWei: gas.reserve,
    });
    return probe.ok ? probe.buyWei : (budgetWei > 0n ? budgetWei / 2n : ethToWei('0.001'));
  }

  async function recheckFreshness() {
    if (source.type !== 'chain') return { ok: true };
    let currentHead = getChainScannerStatus().httpHead;
    try {
      const h = await provider.getBlockNumber();
      if (Number.isFinite(Number(h))) {
        currentHead = currentHead == null ? Number(h) : Math.max(currentHead, Number(h));
      }
    } catch { /* scanner head */ }
    return evaluateChainCandidateFreshness({
      source: { ...source, detectedAt: source.detectedAt || timings.candidateExtractedAt },
      currentHead,
      liveHealth: getChainScannerStatus().scannerHealth,
      chainBuyBlocked: isChainBuyBlocked(),
      dryRun,
    });
  }

  async function sizeKnownRoute(route) {
    const sized = await sizeRouteForWallet({
      provider,
      route,
      settings,
      from: wallet.address,
    });
    state.lastBudget = sized.snapshot || snapshotBudget(sized, { venue: route?.venue, mode: buySizeMode(settings) });
    return sized;
  }

  const tryOnce = async (attempt) => {
    if (alreadyBought(contract)) {
      clearPendingCandidate(contract);
      return { action: 'skipped', reason: 'already_bought', status: 'terminal' };
    }

    const fresh = await recheckFreshness();
    if (!fresh.ok) {
      log('[CANDIDATE] ' + fresh.reason + ' token=' + contract);
      auditEvent('candidate_rejected', { candidateContract: contract, reason: fresh.reason });
      return { action: 'skipped', reason: fresh.reason, status: 'terminal' };
    }

    timings.routeDiscoveryStartedAt = Date.now();
    const spendWei = await probeAmountWei();
    const route = spendWei > 0n
      ? await discoverBestBuyRoute({
        provider,
        token: contract,
        amountIn: spendWei,
        slippagePct,
        source,
        from: wallet.address,
      })
      : null;

    timings.routeFoundAt = route ? Date.now() : null;

    if (!route?.expectedOut || !route.minOut || route.minOut <= 0n) {
      auditEvent('route_not_found', { candidateContract: contract, attempt });
      log('[ROUTE] no executable route yet (attempt ' + attempt + ')');
      setPendingCandidate(contract, { source, symbol: meta.symbol, attempts: attempt });
      state.lastRouteStatus = { contract, attempt, venue: null, venues: getRouteCapabilityHints() };
      return { action: 'skipped', reason: 'no_route', status: 'retry' };
    }

    log('[ROUTE] ' + route.venue + ' expectedOut ' + route.expectedOut.toString() + ' — attempt ' + attempt);
    state.lastRouteStatus = { contract, attempt, venue: route.venue, venues: getRouteCapabilityHints() };

    let sized = await sizeKnownRoute(route);
    if (!sized.ok) {
      log('[BUDGET] ' + (sized.reason || 'insufficient_safe_budget') + ' venue=' + route.venue);
      auditEvent('buy_gate_reject', { candidateContract: contract, reason: sized.reason || 'insufficient_safe_budget' });
      return {
        action: 'skipped',
        reason: sized.reason || 'insufficient_safe_budget',
        status: 'terminal',
        budget: sized.snapshot,
      };
    }

    const sizedRoute = sized.route || route;
    log('[BUDGET] venue=' + sizedRoute.venue
      + ' buy=' + weiToEthNum(sized.buyWei).toFixed(6)
      + ' gasReserve=' + weiToEthNum(sized.gasReserveWei).toFixed(6)
      + ' worstCase=' + weiToEthNum(sized.worstCaseWei).toFixed(6));

    // Dry-run / tests / replay / DISARMED: simulate only. Never sendTransaction or recordBuy.
    if (dryRun || !state.armed) {
      if (!dryRun) log('[LIVE] DISARMED — simulation only, sendTransaction=0');
      auditEvent('buy_dry_run', { candidateContract: contract, venue: sizedRoute.venue, budget: sized.snapshot });
      return {
        action: 'simulated',
        dryRun: true,
        venue: sizedRoute.venue,
        simulation: sizedRoute.simulation || route.simulation,
        hops: sizedRoute.metadata?.hops || route.metadata?.hops,
        swapTypes: sizedRoute.metadata?.swapTypes || route.metadata?.swapTypes,
        budget: sized.snapshot,
        status: 'terminal',
      };
    }

    if (_buying) {
      log('⏳ buy in flight — keeping ' + contract + ' in retry');
      auditEvent('buy_busy', { candidateContract: contract });
      setPendingCandidate(contract, { source, symbol: meta.symbol, attempts: attempt, busy: true });
      return { action: 'skipped', reason: 'busy', status: 'retry' };
    }

    // Immediate pre-send recheck: balance, head, freshness, gas, safe amount.
    const fresh2 = await recheckFreshness();
    if (!fresh2.ok) {
      return { action: 'skipped', reason: fresh2.reason, status: 'terminal' };
    }
    sized = await sizeKnownRoute(sizedRoute);
    if (!sized.ok) {
      return {
        action: 'skipped',
        reason: sized.reason || 'insufficient_safe_budget',
        status: 'terminal',
        budget: sized.snapshot,
      };
    }
    const sendRoute = sized.route || sizedRoute;

    const balance = await provider.getBalance(wallet.address);
    const quote = routeAsQuote(sendRoute);
    const verdict = evaluateBuy({
      settings,
      alreadyBought: alreadyBought(contract),
      walletBalanceWei: balance,
      gasReserveWei: sized.gasReserveWei,
      spendWei: sized.buyWei,
      quote,
      source,
      symbol: meta.symbol,
      launchTaxPct: sendRoute.launchTaxPct,
    });

    if (!verdict.ok) {
      log('⏭️  skipped: ' + verdict.detail);
      auditEvent('buy_gate_reject', { candidateContract: contract, reason: verdict.reason, detail: verdict.detail });
      const status = classifyCandidateResult({ action: 'skipped', reason: verdict.reason });
      return { action: 'skipped', reason: verdict.reason, status };
    }

    auditEvent('buy_gate_pass', { candidateContract: contract, spendWei: String(verdict.spendWei), venue: sendRoute.venue });

    _buying = true;
    timings.sendStartedAt = Date.now();
    auditEvent('buy_send_started', { candidateContract: contract, venue: sendRoute.venue });
    log('[BUY] sending ' + weiToEthNum(verdict.spendWei).toFixed(5) + ' ETH via ' + sendRoute.venue + ' of ' + label + '…');

    try {
      const result = await executeRoute({
        route: { ...sendRoute, amountIn: verdict.spendWei },
        wallet,
        provider,
        settings,
      });

      timings.txSubmittedAt = Date.now();

      if (!result.sent) {
        log('❌ buy failed (will retry): ' + result.error);
        auditEvent('buy_failed', { candidateContract: contract, error: result.error, venue: sendRoute.venue });
        if (result.status === 'terminal' || result.reason === 'unsupported_swap_type') {
          return { action: 'failed', reason: result.reason || 'buy_failed', status: 'terminal' };
        }
        return { action: 'failed', reason: result.error, status: 'retry' };
      }

      stopRouteRetry(contract);
      clearPendingCandidate(contract);
      recordBuy(contract, {
        txHash: result.txHash,
        spendWei: String(verdict.spendWei),
        symbol: meta.symbol,
        sourceType: source.type,
        handle: source.handle,
        tweetUrl: source.tweetUrl,
        chainTx: source.txHash,
        venue: sendRoute.venue,
      });

      auditEvent('buy_sent', { candidateContract: contract, txHash: result.txHash, venue: sendRoute.venue });
      log('🚀 BOUGHT ' + label + ' via ' + sendRoute.venue + ' — tx ' + result.txHash);

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
      return { action: 'bought', txHash: result.txHash, venue: sendRoute.venue, status: 'sent' };
    } finally {
      _buying = false;
    }
  };

  const first = await tryOnce(1);
  const firstCls = classifyCandidateResult(first);
  if (dryRun || firstCls === 'sent' || firstCls === 'terminal') return first;

  const key = contract.toLowerCase();
  if (_routeRetryTimers.has(key)) return { action: 'pending', reason: 'retry_in_flight' };

  return new Promise((resolve) => {
    const handle = startRetryLoop({
      key,
      tryOnce,
      delayMs: routeRetryMs(),
      windowMs: routeRetryWindowMs(),
      startedAt: started,
      onDone: (r) => {
        _routeRetryTimers.delete(key);
        if (r?.reason === 'route_timeout') {
          clearPendingCandidate(contract);
          log('[ROUTE] timeout — no executable route for ' + contract);
        }
        resolve(r);
      },
    });
    _routeRetryTimers.set(key, handle);
  });
}

function getRouteCapabilityHints() {
  const agg = getAggregatorStatus();
  return {
    launcher: 'detect-only',
    aggregator: agg.enabled ? 'available' : 'disabled',
    v4: Boolean(V4_QUOTER) ? 'available' : 'disabled',
  };
}

async function pollOnce() {
  const settings = getSettings();
  if (!settings.xEnabled || !settings.handles?.length) return;

  // fetchHandleTweets loads cookies via Node fs — do not call XProClient here
  // (goat-x-pro login used Bun.file when given cookiesPath).
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
      state.xPoll = { healthy: true, lastAt: Date.now(), error: null, handle };
    } catch (e) {
      if (/401|403|authenticate/i.test(String(e.message))) {
        _xclient = null;
        resetXTimelineCache();
      }
      state.xPoll = { healthy: false, lastAt: Date.now(), error: e.message, handle };
      log('[X] poll @' + handle + ': ' + e.message);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  state.lastPollAt = Date.now();
}

export async function startWatching() {
  if (state.watching) return { ok: true, already: true };
  const settings = getSettings();
  const w = walletOrNull();
  const provider = w?.provider || makeProvider();
  if (!_provider) _provider = provider;

  const ready = await runStartupSelfCheck({ provider, wallet: w, settings });
  state.lastReadiness = ready;
  for (const line of ready.summary.split('\n')) log(line);

  if (!ready.canArm) {
    saveSettings({ enabled: false });
    state.armed = false;
    auditEvent('live_disarmed', { failures: ready.failures });
    log('[LIVE] auto-buy DISARMED — P0 self-check failed: ' + ready.failures.join(', '));
    return { ok: false, errors: ready.failures, readiness: ready };
  }

  state.watching = true;
  state.armed = true;
  log('[LIVE] target ' + normalizeSymbol(settings.targetSymbol || process.env.TARGET_SYMBOL || 'CLOCKIN'));

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
  return { ok: true, readiness: ready };
}

/**
 * Detection-only: scanner + X poll, AUTO BUY remains DISARMED, sendTransaction=0.
 * Used by prearm soak. Does not require WSS ARM checks.
 */
export async function startDetectionOnly() {
  if (state.watching) return { ok: true, already: true };
  const settings = getSettings();
  saveSettings({ enabled: false });
  state.armed = false;
  state.watching = true;
  log('[LIVE] DETECTION ONLY — AUTO BUY DISARMED');
  if (settings.chainEnabled !== false && process.env.CHAIN_SCAN_ENABLED !== 'false') {
    startChainScanner({
      onCandidate: (c) => handleCandidate({ ...c, dryRun: true }),
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
  return { ok: true, armed: false };
}

export function stopWatching() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  stopChainScanner();
  for (const k of [..._routeRetryTimers.keys()]) stopRouteRetry(k);
  state.watching = false;
  state.armed = false;
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
    armed: state.armed,
    autoBuyState: state.armed ? 'ARMED' : 'DISARMED',
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
    scannerMode: chain.scannerMode || chain.chainMode,
    wsConnected: chain.wsConnected,
    lastProcessedBlock: chain.lastProcessedBlock,
    contiguousHistoricalBlock: chain.contiguousHistoricalBlock,
    latestLiveScannedBlock: chain.latestLiveScannedBlock,
    httpHead: chain.httpHead,
    wssLastBlock: chain.wssLastBlock,
    liveLag: chain.liveLag,
    lag: chain.liveLag,
    backgroundLag: chain.backgroundLag,
    wssLag: chain.wssLag,
    scannerHealth: chain.scannerHealth,
    liveStatus: chain.liveStatus,
    chainBuyBlocked: chain.chainBuyBlocked,
    lastChainSignal: chain.lastChainSignal,
    aggregator: agg,
    routes: getRouteCapabilityHints(),
    candidatePipelinesInFlight: _candidateInFlight,
    pendingRetries: [..._routeRetryTimers.keys()],
    lastRouteStatus: state.lastRouteStatus,
    lastReadiness: state.lastReadiness,
    launchTaxProtection: 'unavailable',
    sellabilityGate: 'optional-not-launch-gate',
    httpRpc: state.lastReadiness?.httpOk ?? null,
    wssConfigured: state.lastReadiness?.wssOk ?? null,
    activeHttpProvider: chain.activeHttpProvider || null,
    activeWssProvider: chain.activeWssProvider || null,
    rpcRateLimited: Boolean(chain.provider429),
    provider429: Boolean(chain.provider429),
    rateLimitCount: chain.rateLimitCount || 0,
    xPoll: state.xPoll,
    spendEth: settings.totalBuyBudgetEth || settings.maxSpendEth,
    buySizeMode: buySizeMode(settings),
    totalBuyBudgetEth: ethers.formatEther(totalBudgetWei(settings)),
    budget: state.lastBudget,
    slippageTolerancePct: settings.slippageTolerancePct,
  };
  if (w) {
    out.wallet = w.address;
    try {
      const snap = await estimateBudgetSnapshot(w.provider, w.address, settings, state.lastRouteStatus?.venue || 'aggregator');
      out.balanceEth = Number(ethers.formatEther(snap.walletBalanceWei));
      out.budget = snap.snapshot;
      out.gasReserveEth = snap.snapshot.gasReserveEth;
      out.safeTokenInputEth = snap.snapshot.safeTokenInputEth;
      out.worstCaseTotalEth = snap.snapshot.worstCaseTotalEth;
      out.budgetHeadroomEth = snap.snapshot.headroomEth;
    } catch {
      try { out.balanceEth = Number(ethers.formatEther(await w.provider.getBalance(w.address))); } catch {}
    }
  }
  return out;
}

export { saveSettings, getSettings } from './autostate.js';
