/**
 * chainscanner.js — Robinhood Chain block scanner for trusted launch activity.
 *
 * Head blocks are inspected immediately. Missed blocks fill in on a bounded
 * background catch-up so historical replay never blocks CLOCKIN launch latency.
 */
import { makeProvider, makeEventProvider } from './provider.js';
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
let _catchingUp = false;
let _catchUpTo = null;
let _catchUpPromise = null;
/** Blocks inspected out-of-order (above last contiguous). */
const _inspected = new Set();
/** In-flight inspect to prevent WSS+HTTP duplicate work. */
const _inflight = new Set();
let _pendingCandidatesPreserved = 0;

function catchUpBatch() {
  return Math.max(1, Math.min(32, Number(process.env.CHAIN_CATCHUP_BATCH) || 8));
}

/** Max historical hole-fill on connect. CLOCKIN is in the live head, not 100k blocks ago. */
function catchUpMax() {
  return Math.max(8, Number(process.env.CHAIN_CATCHUP_MAX) || 128);
}

function wssStaleMs() {
  const n = Number(process.env.CHAIN_WSS_STALE_MS);
  if (Number.isFinite(n) && n > 0) return Math.max(50, n);
  return 12000;
}

function log(msg) {
  if (_log) _log(msg);
  console.log('[chainscanner] ' + msg);
}

function httpProvider() {
  if (!_http) _http = makeProvider();
  return _http;
}

function lagBlocks() {
  const processed = _lastBlock ?? getLastProcessedBlock();
  if (_httpHead == null || processed == null) return null;
  return Math.max(0, _httpHead - processed);
}

function scannerMode() {
  if (_mode === 'http-fallback' || _mode === 'http-poll') return _mode;
  if (_catchingUp) return 'catchup';
  return _mode;
}

export function getChainScannerStatus() {
  const processed = _lastBlock ?? getLastProcessedBlock();
  const wssLag = (_httpHead != null && _lastWsBlockNumber != null)
    ? Math.max(0, _httpHead - _lastWsBlockNumber)
    : null;
  return {
    chainWatching: _running,
    chainMode: scannerMode(),
    scannerMode: scannerMode(),
    wsConnected: _wsConnected,
    lastProcessedBlock: processed,
    lastChainSignal: _lastSignal,
    httpHead: _httpHead,
    wssLastBlock: _lastWsBlockNumber,
    wssLastBlockAt: _lastWsBlockAt,
    lag: lagBlocks(),
    wssLag,
    catchingUp: _catchingUp,
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
  const settings = getSettings();
  if (!settings.chainEnabled) return;

  const watch = enabledWatchSet(settings);
  if (!watch.size) return;

  const provider = overrides.provider ?? httpProvider();
  const fetchStarted = Date.now();
  auditEvent('block_seen', { blockNumber, blockSeenAt: fetchStarted });

  let block;
  try {
    block = await provider.getBlock(blockNumber, true);
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
  const last = getLastProcessedBlock();
  if (last != null && n <= last) return;
  if (_inspected.has(n)) {
    noteInspected(n, { persist: overrides.persistCursor !== false });
    return;
  }
  if (_inflight.has(n)) return;
  _inflight.add(n);
  try {
    await processBlock(n, overrides);
  } finally {
    _inflight.delete(n);
  }
}

function yieldCatchUp() {
  return new Promise((r) => setImmediate(r));
}

async function runCatchUp() {
  if (_catchUpPromise) return _catchUpPromise;
  _catchUpPromise = (async () => {
    _catchingUp = true;
    try {
      while (_running) {
        const last = getLastProcessedBlock();
        const target = _catchUpTo;
        if (last == null || target == null || last >= target) break;
        const end = Math.min(last + catchUpBatch(), target);
        log('[CHAIN] catching up blocks ' + (last + 1) + ' → ' + end);
        for (let b = last + 1; b <= end; b++) {
          if (!_running) return;
          await inspectBlock(b, { persistCursor: b === end });
        }
        await yieldCatchUp();
      }
    } finally {
      _catchingUp = false;
      _catchUpPromise = null;
      const last = getLastProcessedBlock();
      if (last != null) setLastProcessedBlock(last);
      if (_running && last != null && _catchUpTo != null && last < _catchUpTo) {
        void runCatchUp();
      }
    }
  })();
  return _catchUpPromise;
}

/**
 * Fill holes up to `toBlock` in the background. Never awaited on the head path.
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

function logInstrument() {
  const st = getChainScannerStatus();
  log('[CHAIN] head=' + (st.httpHead ?? 'n/a')
    + ' processed=' + (st.lastProcessedBlock ?? 'n/a')
    + ' lag=' + (st.lag ?? 'n/a')
    + ' mode=' + st.scannerMode);
  log('[CHAIN] WSS ' + (st.wsConnected ? 'CONNECTED' : 'DOWN')
    + ' last=' + (st.wssLastBlock ?? 'n/a')
    + ' httpHead=' + (st.httpHead ?? 'n/a')
    + ' wssLag=' + (st.wssLag ?? 'n/a'));
}

/**
 * New WSS/HTTP head: inspect this block immediately, catch up holes later.
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
      auditEvent('ws_recovered', { mode: 'websocket' });
      log('[CHAIN] websocket recovered — HTTP fallback stopped');
    } else if (_mode !== 'catchup') {
      _mode = 'websocket';
    }
  }
  const last = getLastProcessedBlock();
  // Head first — do not await catch-up of last+1..n-1.
  await inspectBlock(n);
  if (last != null && n > last + 1) requestCatchUp(n);
  else if (last == null) requestCatchUp(n);
}

/**
 * HTTP head observation (health / fallback). Inspects new head immediately.
 * @param {number} head
 */
export async function handleHttpHead(head) {
  const n = Number(head);
  if (!Number.isFinite(n)) return;
  const prev = _httpHead;
  _httpHead = n;
  if (prev != null && n > prev) {
    await handleNewHead(n, { source: 'http' });
  } else if (prev == null) {
    await inspectBlock(n);
  }
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
  if (_onStaleReconnect) _onStaleReconnect();
  else scheduleReconnect(500);
}

function scheduleReconnect(delayMs = 3000) {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (_running) connectWebSocket();
  }, delayMs);
}

function connectWebSocket() {
  if (!_running) return;
  try {
    if (_ws) {
      try { _ws.destroy(); } catch { /* ignore */ }
      _ws = null;
    }
    const ws = makeEventProvider();
    if (!ws) {
      log('[CHAIN] no WSS URL — HTTP polling (live ARM should have been blocked without ALLOW_HTTP_ONLY_LIVE)');
      startHttpPoll('http-poll');
      return;
    }
    _ws = ws;
    if (_mode !== 'http-fallback' && _mode !== 'http-poll') {
      _mode = 'websocket';
    }

    ws.on('block', (blockNumber) => {
      handleNewHead(blockNumber, { source: 'wss' }).catch((e) => log('[CHAIN] block error: ' + e.message));
    });

    const onDisconnect = () => {
      if (!_running) return;
      _wsConnected = false;
      auditEvent('scanner_degraded', { mode: 'http-fallback', reason: 'ws_disconnected' });
      log('[CHAIN] websocket disconnected — HTTP fallback + reconnect');
      startHttpPoll('http-fallback');
      scheduleReconnect(5000);
    };

    ws.websocket?.on?.('close', onDisconnect);
    ws.websocket?.on?.('error', onDisconnect);
    ws.on('error', onDisconnect);

    auditEvent('ws_connected');
    log('[CHAIN] websocket connected');

    httpProvider().getBlockNumber().then(async (head) => {
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
      await inspectBlock(head);
      requestCatchUp(head);
    }).catch(() => {});
  } catch (e) {
    log('[CHAIN] websocket setup failed: ' + e.message);
    startHttpPoll('http-poll');
  }
}

function startHealthTimer() {
  if (_healthTimer) return;
  const ms = Math.max(500, Number(process.env.CHAIN_HTTP_POLL_MS) || 2000);
  _healthTimer = setInterval(() => {
    if (!_running) return;
    httpProvider().getBlockNumber().then((head) => {
      const wssLagging = !_wsConnected
        || _mode === 'http-fallback'
        || _mode === 'http-poll'
        || _lastWsBlockNumber == null
        || head > _lastWsBlockNumber;
      if (wssLagging) {
        handleHttpHead(head).catch((e) => log('[CHAIN] HTTP poll error: ' + e.message));
      } else {
        _httpHead = head;
        maybeReconnectStaleWs();
        const last = getLastProcessedBlock();
        if (last != null && head > last + 1) requestCatchUp(head);
      }
    }).catch((e) => log('[CHAIN] head probe error: ' + e.message));
  }, ms);
  _instrumentTimer = setInterval(() => {
    if (_running) logInstrument();
  }, Math.max(2000, Number(process.env.CHAIN_INSTRUMENT_MS) || 5000));
}

function startHttpPoll(mode = 'http-poll') {
  _mode = mode;
  _wsConnected = false;
  if (_httpPollTimer) return;
  const ms = Math.max(500, Number(process.env.CHAIN_HTTP_POLL_MS) || 2000);
  log('CHAIN: DEGRADED — HTTP polling every ' + ms + 'ms (' + mode + ')');
  auditEvent('scanner_degraded', { mode });
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
  if (_ws) {
    try { _ws.destroy(); } catch { /* ignore */ }
    _ws = null;
  }
  _wsConnected = false;
  _mode = 'off';
  _onCandidate = null;
  _catchingUp = false;
  _catchUpTo = null;
  auditEvent('scanner_stopped');
  log('[CHAIN] scanner stopped');
  return { ok: true };
}

/** Reset singleton scanner state between unit tests. Does not clear persisted lastProcessed. */
export function resetScannerForTest() {
  stopChainScanner();
  _http = null;
  _inspected.clear();
  _inflight.clear();
  _httpHead = null;
  _lastWsBlockNumber = null;
  _lastWsBlockAt = null;
  _lastBlock = getLastProcessedBlock();
  _pendingCandidatesPreserved = 0;
  _onStaleReconnect = null;
}

export function pendingCandidateDispatchCount() {
  return _pendingCandidatesPreserved;
}
