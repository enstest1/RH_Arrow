/**
 * chainscanner.js — Robinhood Chain block scanner for trusted launch activity.
 *
 * Head blocks are inspected immediately. Missed blocks fill in on a bounded
 * background catch-up so historical replay never blocks CLOCKIN launch latency.
 */
import { makeProvider, makeEventProvider } from './provider.js';
import { onRpcPressure, rotateWssEndpoint, peekHttpPool } from './rpcpool.js';
import { enabledWatchSet, findWatchEntry } from './chainwatchlist.js';
import {
  extractCandidatesFromReceipt,
  txTouchesWatch,
  matchedWatchSide,
} from './candidateextract.js';
import {
  chainEventKey,
  seenChainEvent,
  markChainEvent,
  getLastProcessedBlock,
  setLastProcessedBlock,
} from './autostate.js';
import { auditEvent } from './auditlog.js';

/** @type {import('ethers').JsonRpcProvider | null} */
let _http = null;
/** @type {import('ethers').WebSocketProvider | null} */
let _ws = null;
let _running = false;
let _mode = 'off';
let _wsConnected = false;
let _lastBlock = null;
let _lastSignal = null;
let _reconnectTimer = null;
let _httpPollTimer = null;
let _healthTimer = null;
let _instrumentTimer = null;
/** @type {((msg: string) => void) | null} */
let _log = null;
/** @type {((c: object) => Promise<void>) | null} */
let _onCandidate = null;
/** @type {(() => object) | null} */
let _getSettings = null;
/** @type {(() => void) | null} */
let _onStaleReconnect = null;

let _httpHead = null;
let _lastWsBlockNumber = null;
let _lastWsBlockAt = null;
let _liveScanned = null;
let _liveBusy = 0;
let _liveStaleSince = null;
let _catchingUp = false;
let _catchUpTo = null;
let _catchUpPromise = null;
let _recentRunning = false;
/** P1 recent-live blocks waiting after the current head. */
const _recentQueue = [];
const _recentQueued = new Set();
/** Blocks inspected out-of-order (above last contiguous). */
const _inspected = new Set();
/** In-flight inspect to prevent WSS+HTTP duplicate work. */
const _inflight = new Set();
let _pendingCandidatesPreserved = 0;
let _highRpc = 0;
let _lowRpc = 0;
let _gen = 0;
let _wsGen = 0;
let _activeWssLabel = null;
let _keepaliveTimer = null;
let _rpcPressureUntil = 0;
let _lastPressureLog = 0;
let _lastWssEventLog = 0;
let _wssBackoffMs = 1500;

function catchUpBatch() {
  return Math.max(1, Math.min(32, Number(process.env.CHAIN_CATCHUP_BATCH) || 8));
}

/** Max historical hole-fill on connect. CLOCKIN is in the live head, not 100k blocks ago. */
function catchUpMax() {
  return Math.max(8, Number(process.env.CHAIN_CATCHUP_MAX) || 128);
}

/** P1 window: missed heads between last live scan and current head (not old history). */
function liveRecoveryWindow() {
  return Math.max(4, Math.min(64, Number(process.env.CHAIN_LIVE_RECOVERY_WINDOW) || 24));
}

function liveRecoveryBatch() {
  return Math.max(1, Math.min(8, Number(process.env.CHAIN_LIVE_RECOVERY_BATCH) || 4));
}

function liveStaleLag() {
  return Math.max(3, Number(process.env.CHAIN_LIVE_STALE_LAG) || 8);
}

function liveStaleGraceMs() {
  return Math.max(0, Number(process.env.CHAIN_LIVE_STALE_GRACE_MS) || 3000);
}

function wssStaleMs() {
  const n = Number(process.env.CHAIN_WSS_STALE_MS);
  if (Number.isFinite(n) && n > 0) return Math.max(50, n);
  return 12000;
}

function httpFallbackPollMs() {
  return Math.max(150, Number(process.env.CHAIN_HTTP_FALLBACK_POLL_MS) || 250);
}

function httpHealthPollMs() {
  return Math.max(500, Number(process.env.CHAIN_HTTP_POLL_MS) || 2000);
}

function maxHighRpc() {
  return Math.max(1, Math.min(8, Number(process.env.CHAIN_RPC_HIGH) || 4));
}

function maxLowRpc() {
  return Math.max(1, Math.min(4, Number(process.env.CHAIN_RPC_LOW) || 2));
}

function log(msg) {
  // Autobuy injects _log which already console.logs — do not double-print.
  if (_log) _log(msg);
  else console.log('[chainscanner] ' + msg);
}

function wssKeepaliveMs() {
  return Math.max(5000, Number(process.env.CHAIN_WSS_KEEPALIVE_MS) || 20000);
}

/** Pause P2 historical catch-up so CLOCKIN live work keeps quota. */
export function notifyRpcPressure(ms = 15000) {
  _rpcPressureUntil = Date.now() + Math.max(1000, Number(ms) || 15000);
  if (Date.now() - _lastPressureLog > 5000) {
    _lastPressureLog = Date.now();
    log('[RPC] pressure — pausing historical catch-up');
  }
}

export function isRpcPressured() {
  return Date.now() < _rpcPressureUntil;
}

function httpProvider() {
  if (!_http) _http = makeProvider();
  return _http;
}

function yieldCatchUp() {
  return new Promise((r) => setImmediate(r));
}

async function withHighRpc(fn) {
  while (_highRpc >= maxHighRpc()) await yieldCatchUp();
  _highRpc += 1;
  try {
    return await fn();
  } finally {
    _highRpc -= 1;
  }
}

async function withLowRpc(fn) {
  while (_liveBusy > 0 || _highRpc > 0 || _lowRpc >= maxLowRpc()) {
    if (!_running) return null;
    await yieldCatchUp();
  }
  _lowRpc += 1;
  try {
    return await fn();
  } finally {
    _lowRpc -= 1;
  }
}

function contiguousBlock() {
  return _lastBlock ?? getLastProcessedBlock();
}

function liveLagBlocks() {
  if (_httpHead == null || _liveScanned == null) return null;
  return Math.max(0, _httpHead - _liveScanned);
}

function backgroundLagBlocks() {
  const processed = contiguousBlock();
  if (_httpHead == null || processed == null) return null;
  return Math.max(0, _httpHead - processed);
}

function classifyLiveHealth(lag) {
  if (lag == null) return 'UNKNOWN';
  if (lag <= 2) return 'CURRENT';
  if (lag <= liveStaleLag()) return 'DEGRADED';
  return 'STALE';
}

function refreshLiveHealthClock() {
  const health = classifyLiveHealth(liveLagBlocks());
  if (health === 'STALE') {
    if (_liveStaleSince == null) _liveStaleSince = Date.now();
  } else {
    _liveStaleSince = null;
  }
  return health;
}

/** True after STALE live lag persists past the grace window. New chain buys must fail closed. */
export function isChainBuyBlocked() {
  refreshLiveHealthClock();
  if (_liveStaleSince == null) return false;
  return Date.now() - _liveStaleSince >= liveStaleGraceMs();
}

function scannerMode() {
  if (_mode === 'http-fallback' || _mode === 'http-poll' || _mode === 'websocket' || _mode === 'off') {
    return _mode;
  }
  return _mode;
}

function markLiveScanned(n) {
  _liveScanned = _liveScanned == null ? n : Math.max(_liveScanned, n);
  refreshLiveHealthClock();
}

export function getChainScannerStatus() {
  const processed = contiguousBlock();
  const liveLag = liveLagBlocks();
  const wssLag = (_httpHead != null && _lastWsBlockNumber != null)
    ? Math.max(0, _httpHead - _lastWsBlockNumber)
    : null;
  const scannerHealth = refreshLiveHealthClock();
  const chainBuyBlocked = isChainBuyBlocked();
  return {
    chainWatching: _running,
    chainMode: scannerMode(),
    scannerMode: scannerMode(),
    wsConnected: _wsConnected,
    lastProcessedBlock: processed,
    contiguousHistoricalBlock: processed,
    latestLiveScannedBlock: _liveScanned,
    latestChainHead: _httpHead,
    lastChainSignal: _lastSignal,
    httpHead: _httpHead,
    wssLastBlock: _lastWsBlockNumber,
    wssLastBlockAt: _lastWsBlockAt,
    liveLag,
    lag: liveLag,
    backgroundLag: backgroundLagBlocks(),
    wssLag,
    catchingUp: _catchingUp,
    scannerHealth,
    liveStatus: scannerHealth === 'CURRENT' ? 'CURRENT' : scannerHealth,
    chainBuyBlocked,
    rpcPressured: isRpcPressured(),
    activeHttpProvider: peekHttpPool()?.activeLabel || null,
    activeWssProvider: _activeWssLabel,
    provider429: peekHttpPool()?.snapshot().provider429 || false,
    rateLimitCount: peekHttpPool()?.rateLimitCount || 0,
  };
}

/**
 * Ethers v6: getBlock(n, true) puts hashes in block.transactions and objects
 * in block.prefetchedTransactions. Never skip the block because hashes are strings.
 * @param {import('ethers').Provider} provider
 * @param {import('ethers').Block} block
 */
export async function resolveBlockTransactions(provider, block) {
  if (!block) return [];
  if (Array.isArray(block.prefetchedTransactions) && block.prefetchedTransactions.length) {
    return block.prefetchedTransactions.filter(Boolean);
  }
  const raw = block.transactions || [];
  if (!raw.length) return [];
  if (typeof raw[0] === 'object' && raw[0]?.hash) {
    return raw.filter(Boolean);
  }
  const hashes = raw.map((tx) => (typeof tx === 'string' ? tx : tx?.hash)).filter(Boolean);
  const txs = await Promise.all(hashes.map((h) => provider.getTransaction(h)));
  return txs.filter(Boolean);
}

/**
 * Advance lastProcessed only through a hole-free prefix so inspecting a new
 * head never marks older missed blocks as done.
 * @param {number} n
 * @param {{ persist?: boolean }} [opts]
 */
function noteInspected(n, opts = {}) {
  const last = getLastProcessedBlock();
  if (last == null) {
    _lastBlock = n;
    setLastProcessedBlock(n, opts);
    return;
  }
  if (n <= last) return;
  _inspected.add(n);
  let c = last;
  while (_inspected.has(c + 1)) {
    c += 1;
    _inspected.delete(c);
  }
  if (c !== last) {
    _lastBlock = c;
    setLastProcessedBlock(c, opts);
  }
}

/**
 * Process one block: scan txs touching watched addresses, extract candidates.
 * @param {number} blockNumber
 * @param {{ running?: boolean, onCandidate?: Function, getSettings?: Function, provider?: import('ethers').Provider }} [overrides]
 */
export async function processBlock(blockNumber, overrides = {}) {
  const running = overrides.running ?? _running;
  const onCandidate = overrides.onCandidate ?? _onCandidate;
  const getSettings = overrides.getSettings ?? _getSettings;
  if (!running || !onCandidate || !getSettings) return;
  if (overrides.gen != null && overrides.gen !== _gen) return;
  const settings = getSettings();
  if (!settings.chainEnabled) return;

  const watch = enabledWatchSet(settings);
  if (!watch.size) return;

  const provider = overrides.provider ?? httpProvider();
  const fetchStarted = Date.now();
  auditEvent('block_seen', { blockNumber, blockSeenAt: fetchStarted });

  const fetchFn = () => provider.getBlock(blockNumber, true);
  const priority = overrides.priority || 'p0';
  let block;
  try {
    block = priority === 'p2' ? await withLowRpc(fetchFn) : await withHighRpc(fetchFn);
    if (!block) return;
  } catch (e) {
    log('[CHAIN] block fetch failed ' + blockNumber + ': ' + e.message);
    return;
  }
  const fetchMs = Date.now() - fetchStarted;
  const scanStarted = Date.now();
  const txs = await resolveBlockTransactions(provider, block);
  if (!txs.length) {
    noteInspected(blockNumber, { persist: overrides.persistCursor !== false });
    log('[CHAIN] block=' + blockNumber + ' fetchMs=' + fetchMs + ' scanMs=' + (Date.now() - scanStarted));
    return;
  }

  for (const tx of txs) {
    if (!txTouchesWatch(tx, watch)) continue;

    const match = matchedWatchSide(tx, watch);
    if (!match) continue;

    const entry = findWatchEntry(settings, match.address);
    if (!entry) continue;

    const evtKey = chainEventKey(tx.hash, -1);
    if (seenChainEvent(evtKey)) continue;
    markChainEvent(evtKey);

    auditEvent('watched_tx_seen', {
      blockNumber,
      txHash: tx.hash,
      watchAddress: entry.address,
      watchRole: entry.role,
      watchSide: match.side,
    });
    _lastSignal = { at: Date.now(), blockNumber, txHash: tx.hash, role: entry.role };

    let receipt;
    try {
      receipt = await provider.getTransactionReceipt(tx.hash);
    } catch (e) {
      log('[CHAIN] receipt failed ' + tx.hash + ': ' + e.message);
      continue;
    }
    if (!receipt) continue;

    const weth = (process.env.WETH_ADDRESS || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73').toLowerCase();
    const exclude = new Set([weth]);

    const candidates = extractCandidatesFromReceipt(receipt, { excludeAddresses: exclude });
    const blockSeenAt = Date.now();
    for (const c of candidates) {
      const cKey = chainEventKey(tx.hash, c.logIndex ?? -1);
      if (seenChainEvent(cKey)) continue;
      markChainEvent(cKey);
      _pendingCandidatesPreserved += 1;

      const candidateExtractedAt = Date.now();
      const blockTs = block.timestamp ? Number(block.timestamp) * 1000 : null;
      auditEvent('candidate_detected', {
        blockNumber,
        sourceTxHash: tx.hash,
        candidateContract: c.contract,
        extractionMethod: c.method,
        logIndex: c.logIndex,
        watchAddress: entry.address,
        watchRole: entry.role,
        candidateExtractedAt,
      });

      // Fire-and-forget: route retries must NOT block subsequent candidates or blocks.
      void onCandidate({
        contract: c.contract,
        source: {
          type: 'chain',
          address: entry.address,
          role: entry.role,
          label: entry.label,
          txHash: tx.hash,
          blockNumber,
          blockTimestamp: blockTs,
          detectedAt: candidateExtractedAt,
          logIndex: c.logIndex,
          extractionMethod: c.method,
          watchSide: match.side,
        },
        timings: { blockSeenAt, candidateExtractedAt },
      }).catch((e) => log('[CHAIN] candidate pipeline error: ' + e.message));
    }
  }

  noteInspected(blockNumber, { persist: overrides.persistCursor !== false });
  log('[CHAIN] block=' + blockNumber + ' fetchMs=' + fetchMs + ' scanMs=' + (Date.now() - scanStarted));
}

/**
 * Inspect one block unless already in-flight or done. Safe for WSS+HTTP overlap.
 * @param {number} blockNumber
 * @param {object} [overrides]
 */
export async function inspectBlock(blockNumber, overrides = {}) {
  const n = Number(blockNumber);
  if (!Number.isFinite(n)) return;
  if (overrides.gen != null && overrides.gen !== _gen) return;
  const gen = overrides.gen ?? _gen;
  const last = getLastProcessedBlock();
  if (last != null && n <= last) return;
  if (_inspected.has(n)) {
    noteInspected(n, { persist: overrides.persistCursor !== false });
    return;
  }
  if (_inflight.has(n)) return;
  _inflight.add(n);
  try {
    await processBlock(n, { ...overrides, gen });
    if (_gen !== gen) return;
    if (overrides.priority === 'p0' || overrides.priority === 'p1') markLiveScanned(n);
  } finally {
    _inflight.delete(n);
  }
}

function p2Cap() {
  const live = _liveScanned ?? _httpHead;
  if (live == null) return _catchUpTo;
  const cap = live - liveRecoveryWindow();
  if (_catchUpTo == null) return cap;
  return Math.min(_catchUpTo, cap);
}

async function runCatchUp() {
  if (_catchUpPromise) return _catchUpPromise;
  const gen = _gen;
  _catchUpPromise = (async () => {
    _catchingUp = true;
    try {
      while (_running && _gen === gen) {
        if (_liveBusy > 0 || _recentQueue.length || isRpcPressured()) {
          await yieldCatchUp();
          continue;
        }
        const last = getLastProcessedBlock();
        const target = p2Cap();
        if (last == null || target == null || last >= target) break;
        const end = Math.min(last + catchUpBatch(), target);
        log('[CHAIN] catching up blocks ' + (last + 1) + ' → ' + end);
        for (let b = last + 1; b <= end; b++) {
          if (!_running) return;
          if (_liveBusy > 0 || _recentQueue.length || isRpcPressured()) break;
          await inspectBlock(b, { persistCursor: b === end, priority: 'p2', gen });
        }
        await yieldCatchUp();
      }
    } finally {
      _catchingUp = false;
      _catchUpPromise = null;
      const last = getLastProcessedBlock();
      if (last != null) setLastProcessedBlock(last);
      if (_running && _gen === gen && last != null && p2Cap() != null && last < p2Cap()) {
        void runCatchUp();
      }
    }
  })();
  return _catchUpPromise;
}

/**
 * Fill old historical holes in the background. Never awaited on the live-head path.
 * @param {number} toBlock
 */
export function requestCatchUp(toBlock) {
  const n = Number(toBlock);
  if (!Number.isFinite(n)) return;
  _catchUpTo = _catchUpTo == null ? n : Math.max(_catchUpTo, n);
  const last = getLastProcessedBlock();
  if (last != null && n <= last) return;
  void runCatchUp();
}

function enqueueRecentBelow(head) {
  const last = getLastProcessedBlock() ?? -1;
  const from = Math.max(last + 1, head - liveRecoveryWindow() + 1);
  for (let b = from; b < head; b++) {
    if (_inspected.has(b) || _inflight.has(b) || _recentQueued.has(b)) continue;
    if (last != null && b <= last) continue;
    _recentQueued.add(b);
    _recentQueue.push(b);
  }
  _recentQueue.sort((a, b) => a - b);
  void runRecentRecovery();
}

async function runRecentRecovery() {
  if (_recentRunning) return;
  const gen = _gen;
  _recentRunning = true;
  try {
    while (_running && _recentQueue.length && _gen === gen) {
      if (_liveBusy > 0) {
        await yieldCatchUp();
        continue;
      }
      const batch = Math.min(liveRecoveryBatch(), _recentQueue.length);
      for (let i = 0; i < batch; i++) {
        if (!_running || _liveBusy > 0 || _gen !== gen) break;
        const b = _recentQueue.shift();
        if (b == null) break;
        _recentQueued.delete(b);
        await inspectBlock(b, { priority: 'p1', gen });
        if (_gen === gen) markLiveScanned(b);
      }
      await yieldCatchUp();
    }
  } finally {
    _recentRunning = false;
    if (_running && _gen === gen && _recentQueue.length) void runRecentRecovery();
  }
}

function logInstrument() {
  const st = getChainScannerStatus();
  log('[CHAIN] head=' + (st.httpHead ?? 'n/a')
    + ' live=' + (st.latestLiveScannedBlock ?? 'n/a')
    + ' liveLag=' + (st.liveLag ?? 'n/a')
    + ' bg=' + (st.contiguousHistoricalBlock ?? 'n/a')
    + ' bgLag=' + (st.backgroundLag ?? 'n/a')
    + ' health=' + st.scannerHealth
    + ' mode=' + st.scannerMode);
  log('[CHAIN] WSS ' + (st.wsConnected ? 'CONNECTED' : 'DOWN')
    + ' last=' + (st.wssLastBlock ?? 'n/a')
    + ' httpHead=' + (st.httpHead ?? 'n/a')
    + ' wssLag=' + (st.wssLag ?? 'n/a'));
}

/**
 * New WSS/HTTP head: inspect this block immediately (P0), then recent holes (P1).
 * @param {number} blockNumber
 * @param {{ source?: 'wss'|'http' }} [meta]
 */
export async function handleNewHead(blockNumber, meta = {}) {
  const n = Number(blockNumber);
  if (!Number.isFinite(n)) return;
  _httpHead = _httpHead == null ? n : Math.max(_httpHead, n);
  if (meta.source === 'wss') {
    _wsConnected = true;
    _lastWsBlockNumber = n;
    _lastWsBlockAt = Date.now();
    if (_mode === 'http-fallback' || _mode === 'http-poll') {
      stopHttpPoll();
      _mode = 'websocket';
      _wssBackoffMs = 1500;
      auditEvent('ws_recovered', { mode: 'websocket' });
      log('[CHAIN] WSS reconnected');
    } else {
      _mode = 'websocket';
    }
  }
  _liveBusy += 1;
  try {
    await inspectBlock(n, { priority: 'p0' });
    markLiveScanned(n);
  } finally {
    _liveBusy -= 1;
  }
  enqueueRecentBelow(n);
  requestCatchUp(n);
}

/**
 * HTTP head observation (health / fallback). Always jumps to the newest head.
 * @param {number} head
 */
export async function handleHttpHead(head) {
  const n = Number(head);
  if (!Number.isFinite(n)) return;
  if (_httpHead !== n) log('[CHAIN] HTTP live head=' + n);
  const last = getLastProcessedBlock();
  if (last != null && n - last > Math.max(catchUpMax() * 8, 2048)) {
    const snap = Math.max(0, n - catchUpMax());
    log('[CHAIN] startup catch-up bounded to last ' + catchUpMax()
      + ' blocks (cursor ' + last + ' → ' + snap + ')');
    setLastProcessedBlock(snap);
    _lastBlock = snap;
    _inspected.clear();
  }
  if (_liveScanned != null && n <= _liveScanned && _httpHead != null && n <= _httpHead) {
    _httpHead = Math.max(_httpHead, n);
    maybeReconnectStaleWs();
    return;
  }
  await handleNewHead(n, { source: 'http' });
  maybeReconnectStaleWs();
}

/**
 * WSS is stale if the socket is up, HTTP head advanced, and no WSS block arrived.
 * @param {{ now?: number, httpHead?: number, lastWsAt?: number, lastWsBlock?: number, wsConnected?: boolean }} [s]
 */
export function evaluateWsHealth(s = {}) {
  const now = s.now ?? Date.now();
  const httpHead = s.httpHead ?? _httpHead;
  const lastWsAt = s.lastWsAt ?? _lastWsBlockAt;
  const lastWsBlock = s.lastWsBlock ?? _lastWsBlockNumber;
  const wsConnected = s.wsConnected ?? _wsConnected;
  if (!wsConnected) return { stale: false, reason: 'disconnected' };
  if (httpHead == null || lastWsBlock == null || lastWsAt == null) {
    return { stale: false, reason: 'uninitialized' };
  }
  if (httpHead <= lastWsBlock) return { stale: false, reason: 'chain_idle' };
  if (now - lastWsAt < wssStaleMs()) return { stale: false, reason: 'fresh' };
  return { stale: true, reason: 'silent_wss', wssLag: httpHead - lastWsBlock };
}

function maybeReconnectStaleWs() {
  const health = evaluateWsHealth();
  if (!health.stale || !_running) return;
  log('[CHAIN] WSS stale — HTTP head advanced without WSS blocks, reconnecting');
  auditEvent('scanner_degraded', { mode: 'http-fallback', reason: 'wss_stale' });
  startHttpPoll('http-fallback');
  rotateWssEndpoint();
  if (_onStaleReconnect) _onStaleReconnect();
  else scheduleReconnect(500);
}

function scheduleReconnect(delayMs = 3000) {
  if (_reconnectTimer) return;
  const wait = Math.max(delayMs, _wssBackoffMs);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (_running) connectWebSocket();
  }, wait);
}

function stopWssKeepalive() {
  if (_keepaliveTimer) clearInterval(_keepaliveTimer);
  _keepaliveTimer = null;
}

function startWssKeepalive(ws) {
  stopWssKeepalive();
  if (!ws) return;
  // Periodic JSON-RPC on the socket. Alchemy documents eth_subscribe over WSS
  // and idle drops were observed; a light getBlockNumber is evidence-based keepalive.
  _keepaliveTimer = setInterval(() => {
    if (!_running || !_ws || _ws !== ws) return;
    ws.getBlockNumber().catch(() => {});
  }, wssKeepaliveMs());
}

function connectWebSocket() {
  if (!_running) return;
  _wsGen += 1;
  const myGen = _wsGen;
  try {
    const old = _ws;
    _ws = null;
    stopWssKeepalive();
    if (old) {
      try { old.removeAllListeners?.(); } catch { /* ignore */ }
      try { old.destroy(); } catch { /* ignore */ }
    }
    const ws = makeEventProvider();
    if (!ws) {
      log('[CHAIN] no WSS URL — HTTP polling (live ARM should have been blocked without ALLOW_HTTP_ONLY_LIVE)');
      _activeWssLabel = null;
      startHttpPoll('http-poll');
      return;
    }
    _ws = ws;
    _activeWssLabel = ws._rhLabel || null;
    if (_mode !== 'http-fallback' && _mode !== 'http-poll') {
      _mode = 'websocket';
    }

    ws.on('block', (blockNumber) => {
      if (myGen !== _wsGen) return;
      handleNewHead(blockNumber, { source: 'wss' }).catch((e) => log('[CHAIN] block error: ' + e.message));
    });

    const onDisconnect = () => {
      if (!_running || myGen !== _wsGen) return;
      _wsConnected = false;
      auditEvent('wss_disconnect', { mode: 'http-fallback', label: _activeWssLabel });
      if (Date.now() - _lastWssEventLog > 2000) {
        _lastWssEventLog = Date.now();
        log('[CHAIN] WSS disconnected — HTTP live fallback active');
      }
      startHttpPoll('http-fallback');
      const next = rotateWssEndpoint();
      if (next && next.label !== _activeWssLabel) {
        log('[RPC] switching WSS to ' + next.label);
      }
      _wssBackoffMs = Math.min(60_000, Math.max(1500, _wssBackoffMs) * 2);
      scheduleReconnect(_wssBackoffMs);
    };

    ws.websocket?.on?.('close', onDisconnect);
    ws.websocket?.on?.('error', onDisconnect);
    ws.on('error', onDisconnect);
    startWssKeepalive(ws);

    auditEvent('wss_reconnect', { label: _activeWssLabel });
    log('[CHAIN] websocket connected' + (_activeWssLabel ? ' (' + _activeWssLabel + ')' : ''));

    httpProvider().getBlockNumber().then(async (head) => {
      if (myGen !== _wsGen || !_running) return;
      _httpHead = head;
      const last = getLastProcessedBlock();
      if (last == null) {
        setLastProcessedBlock(head - 1);
        _lastBlock = head - 1;
      } else if (head - last > catchUpMax()) {
        const snap = Math.max(0, head - catchUpMax());
        log('[CHAIN] startup catch-up bounded to last ' + catchUpMax()
          + ' blocks (cursor ' + last + ' → ' + snap + ')');
        setLastProcessedBlock(snap);
        _lastBlock = snap;
        _inspected.clear();
      }
      await handleNewHead(head, { source: _wsConnected ? 'wss' : 'http' });
    }).catch(() => {});
  } catch (e) {
    log('[CHAIN] websocket setup failed: ' + e.message);
    startHttpPoll('http-poll');
    rotateWssEndpoint();
    scheduleReconnect(5000);
  }
}

function startHealthTimer() {
  if (_healthTimer) return;
  _healthTimer = setInterval(() => {
    if (!_running) return;
    if (_mode === 'http-fallback' || _mode === 'http-poll') return;
    httpProvider().getBlockNumber().then((head) => {
      _httpHead = _httpHead == null ? head : Math.max(_httpHead, head);
      const wssLagging = !_wsConnected
        || _lastWsBlockNumber == null
        || head > _lastWsBlockNumber;
      if (wssLagging) {
        handleHttpHead(head).catch((e) => log('[CHAIN] HTTP poll error: ' + e.message));
      } else {
        maybeReconnectStaleWs();
        requestCatchUp(head);
      }
    }).catch((e) => log('[CHAIN] head probe error: ' + e.message));
  }, httpHealthPollMs());
  _instrumentTimer = setInterval(() => {
    if (_running) logInstrument();
  }, Math.max(2000, Number(process.env.CHAIN_INSTRUMENT_MS) || 5000));
}

function startHttpPoll(mode = 'http-poll') {
  _mode = mode;
  _wsConnected = false;
  auditEvent('scanner_degraded', { mode });
  if (_httpPollTimer) return;
  const ms = httpFallbackPollMs();
  log('CHAIN: DEGRADED — HTTP live polling every ' + ms + 'ms (' + mode + ')');
  const tick = () => {
    if (!_running || (_mode !== 'http-fallback' && _mode !== 'http-poll')) return;
    httpProvider().getBlockNumber().then((head) => {
      handleHttpHead(head).catch((e) => log('[CHAIN] HTTP live error: ' + e.message));
    }).catch((e) => log('[CHAIN] HTTP live head probe error: ' + e.message));
  };
  _httpPollTimer = setInterval(tick, ms);
  tick();
}

function stopHttpPoll() {
  if (_httpPollTimer) clearInterval(_httpPollTimer);
  _httpPollTimer = null;
}

/**
 * @param {{ onCandidate: (c: object) => Promise<void>, log: (m: string) => void, getSettings: () => object, provider?: import('ethers').Provider, disableNetwork?: boolean, onStaleReconnect?: () => void }} opts
 */
export function startChainScanner(opts) {
  if (_running) return { ok: true, already: true };
  _onCandidate = opts.onCandidate;
  _log = opts.log;
  _getSettings = opts.getSettings;
  _onStaleReconnect = opts.onStaleReconnect || null;
  if (opts.provider) _http = opts.provider;
  onRpcPressure(() => notifyRpcPressure(15000));
  _running = true;
  _lastBlock = getLastProcessedBlock();
  _pendingCandidatesPreserved = 0;
  auditEvent('scanner_started', { mode: 'chain' });
  if (opts.disableNetwork) {
    _mode = 'websocket';
    return { ok: true };
  }
  startHealthTimer();
  connectWebSocket();
  return { ok: true };
}

/**
 * Test helper: WSS drop after ARM must expose http-fallback without dropping work.
 */
export function emulateWsDisconnectForTest() {
  _wsConnected = false;
  _mode = 'http-fallback';
}

export function emulateWsReconnectForTest() {
  _wsConnected = true;
  _mode = 'websocket';
  stopHttpPoll();
}

/** Detection-only observe: drop the socket so HTTP live fallback can be measured. */
export function forceWsDropForObserve() {
  if (_ws) {
    try { _ws.destroy(); } catch { /* ignore */ }
  }
}

/** Test helper: pretend WSS has been silent for `msAgo` milliseconds. */
export function backdateLastWsBlockForTest(msAgo) {
  _lastWsBlockAt = Date.now() - Math.max(0, Number(msAgo) || 0);
}

export function stopChainScanner() {
  _running = false;
  stopHttpPoll();
  if (_healthTimer) clearInterval(_healthTimer);
  _healthTimer = null;
  if (_instrumentTimer) clearInterval(_instrumentTimer);
  _instrumentTimer = null;
  if (_reconnectTimer) clearTimeout(_reconnectTimer);
  _reconnectTimer = null;
  stopWssKeepalive();
  _wsGen += 1;
  if (_ws) {
    try { _ws.destroy(); } catch { /* ignore */ }
    _ws = null;
  }
  _wsConnected = false;
  _activeWssLabel = null;
  _mode = 'off';
  _onCandidate = null;
  _catchingUp = false;
  _catchUpTo = null;
  _liveBusy = 0;
  _recentQueue.length = 0;
  _recentQueued.clear();
  _recentRunning = false;
  auditEvent('scanner_stopped');
  log('[CHAIN] scanner stopped');
  return { ok: true };
}

/** Reset singleton scanner state between unit tests. Does not clear persisted lastProcessed. */
export function resetScannerForTest() {
  _gen += 1;
  stopChainScanner();
  _http = null;
  _inspected.clear();
  _inflight.clear();
  _httpHead = null;
  _lastWsBlockNumber = null;
  _lastWsBlockAt = null;
  _liveScanned = null;
  _liveStaleSince = null;
  _lastBlock = getLastProcessedBlock();
  _pendingCandidatesPreserved = 0;
  _onStaleReconnect = null;
  _highRpc = 0;
  _lowRpc = 0;
  _rpcPressureUntil = 0;
  _activeWssLabel = null;
  _wssBackoffMs = 1500;
}

export function wssListenerCountForTest() {
  return _ws?.listenerCount?.('block') ?? 0;
}

export function pendingCandidateDispatchCount() {
  return _pendingCandidatesPreserved;
}
