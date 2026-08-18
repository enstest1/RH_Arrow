/**
 * chainscanner.js — Robinhood Chain block scanner for trusted launch activity.
 *
 * Owns: WebSocket/HTTP block intake, watched-tx matching, candidate extraction,
 * event dedupe, reconnect + catch-up. Does NOT own spend rules or swaps.
 */
import { makeProvider, makeEventProvider } from './provider.js';
import { enabledWatchSet, findWatchEntry, normAddr } from './chainwatchlist.js';
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
let _processing = false;
/** @type {((msg: string) => void) | null} */
let _log = null;
/** @type {((c: object) => Promise<void>) | null} */
let _onCandidate = null;
/** @type {(() => object) | null} */
let _getSettings = null;

function log(msg) {
  if (_log) _log(msg);
  console.log('[chainscanner] ' + msg);
}

function httpProvider() {
  if (!_http) _http = makeProvider();
  return _http;
}

export function getChainScannerStatus() {
  return {
    chainWatching: _running,
    chainMode: _mode,
    scannerMode: _mode,
    wsConnected: _wsConnected,
    lastProcessedBlock: _lastBlock ?? getLastProcessedBlock(),
    lastChainSignal: _lastSignal,
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
  auditEvent('block_seen', { blockNumber, blockSeenAt: Date.now() });

  let block;
  try {
    block = await provider.getBlock(blockNumber, true);
  } catch (e) {
    log('[CHAIN] block fetch failed ' + blockNumber + ': ' + e.message);
    return;
  }
  const txs = await resolveBlockTransactions(provider, block);
  if (!txs.length) {
    _lastBlock = blockNumber;
    setLastProcessedBlock(blockNumber);
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

  _lastBlock = blockNumber;
  setLastProcessedBlock(blockNumber);
}

async function catchUp(fromBlock, toBlock) {
  if (fromBlock == null || toBlock == null || toBlock < fromBlock) return;
  auditEvent('scanner_catchup', { fromBlock, toBlock });
  log('[CHAIN] catching up blocks ' + fromBlock + ' → ' + toBlock);
  for (let b = fromBlock; b <= toBlock; b++) {
    await processBlock(b);
  }
  log('[CHAIN] live at block ' + toBlock);
}

async function onNewBlock(blockNumber) {
  if (_processing) return;
  _processing = true;
  try {
    const last = getLastProcessedBlock();
    if (last != null && blockNumber > last + 1) {
      await catchUp(last + 1, blockNumber - 1);
    }
    await processBlock(blockNumber);
  } finally {
    _processing = false;
  }
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
      try { _ws.destroy(); } catch {}
      _ws = null;
    }
    const ws = makeEventProvider();
    if (!ws) {
      log('[CHAIN] no WSS URL — HTTP polling (live ARM should have been blocked without ALLOW_HTTP_ONLY_LIVE)');
      startHttpPoll('http-poll');
      return;
    }
    _ws = ws;
    // Keep HTTP fallback running until the first live WSS block proves the socket is healthy.
    if (_mode !== 'http-fallback' && _mode !== 'http-poll') {
      _mode = 'websocket';
    }

    ws.on('block', (blockNumber) => {
      _wsConnected = true;
      if (_mode !== 'websocket') {
        stopHttpPoll();
        _mode = 'websocket';
        auditEvent('ws_recovered', { mode: 'websocket' });
        log('[CHAIN] websocket recovered — HTTP fallback stopped');
      }
      onNewBlock(blockNumber).catch((e) => log('[CHAIN] block error: ' + e.message));
    });

    const onDisconnect = () => {
      _wsConnected = false;
      // Keep scanning: HTTP immediately, WSS reconnect in parallel. Do not drop candidates.
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

    // Catch up from persisted block
    httpProvider().getBlockNumber().then(async (head) => {
      const last = getLastProcessedBlock();
      if (last != null && head > last) await catchUp(last + 1, head);
      _lastBlock = head;
    }).catch(() => {});
  } catch (e) {
    log('[CHAIN] websocket setup failed: ' + e.message);
    startHttpPoll('http-poll');
  }
}

function startHttpPoll(mode = 'http-poll') {
  _mode = mode;
  _wsConnected = false;
  if (_httpPollTimer) return;
  const ms = Math.max(500, Number(process.env.CHAIN_HTTP_POLL_MS) || 2000);
  log('CHAIN: DEGRADED — HTTP polling every ' + ms + 'ms (' + mode + ')');
  auditEvent('scanner_degraded', { mode });

  let lastHead = getLastProcessedBlock();
  let pollInFlight = false;
  _httpPollTimer = setInterval(() => {
    if (!_running || pollInFlight) return;
    pollInFlight = true;
    (async () => {
      const head = await httpProvider().getBlockNumber();
      if (lastHead == null) {
        lastHead = head;
        setLastProcessedBlock(head);
        return;
      }
      if (head > lastHead) {
        for (let b = lastHead + 1; b <= head; b++) await onNewBlock(b);
        lastHead = head;
      }
    })().catch((e) => log('[CHAIN] HTTP poll error: ' + e.message))
      .finally(() => { pollInFlight = false; });
  }, ms);
}

function stopHttpPoll() {
  if (_httpPollTimer) clearInterval(_httpPollTimer);
  _httpPollTimer = null;
}

/**
 * @param {{ onCandidate: (c: object) => Promise<void>, log: (m: string) => void, getSettings: () => object }} opts
 */
export function startChainScanner(opts) {
  if (_running) return { ok: true, already: true };
  _onCandidate = opts.onCandidate;
  _log = opts.log;
  _getSettings = opts.getSettings;
  _running = true;
  _lastBlock = getLastProcessedBlock();
  auditEvent('scanner_started', { mode: 'chain' });
  connectWebSocket();
  return { ok: true };
}

/**
 * Test helper: WSS drop after ARM must expose http-fallback without dropping work.
 * Does not start a poll interval (avoids leaking timers in unit tests).
 */
export function emulateWsDisconnectForTest() {
  _wsConnected = false;
  _mode = 'http-fallback';
}

export function stopChainScanner() {
  _running = false;
  stopHttpPoll();
  if (_reconnectTimer) clearTimeout(_reconnectTimer);
  _reconnectTimer = null;
  if (_ws) {
    try { _ws.destroy(); } catch {}
    _ws = null;
  }
  _wsConnected = false;
  _mode = 'off';
  _onCandidate = null;
  auditEvent('scanner_stopped');
  log('[CHAIN] scanner stopped');
  return { ok: true };
}
