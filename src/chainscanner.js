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
    wsConnected: _wsConnected,
    lastProcessedBlock: _lastBlock ?? getLastProcessedBlock(),
    lastChainSignal: _lastSignal,
  };
}

/**
 * Process one block: scan txs touching watched addresses, extract candidates.
 * @param {number} blockNumber
 */
export async function processBlock(blockNumber) {
  if (!_running || !_onCandidate || !_getSettings) return;
  const settings = _getSettings();
  if (!settings.chainEnabled) return;

  const watch = enabledWatchSet(settings);
  if (!watch.size) return;

  const provider = httpProvider();
  auditEvent('block_seen', { blockNumber, blockSeenAt: Date.now() });

  let block;
  try {
    block = await provider.getBlock(blockNumber, true);
  } catch (e) {
    log('[CHAIN] block fetch failed ' + blockNumber + ': ' + e.message);
    return;
  }
  if (!block?.transactions?.length) {
    _lastBlock = blockNumber;
    setLastProcessedBlock(blockNumber);
    return;
  }

  for (const tx of block.transactions) {
    if (typeof tx === 'string') continue;
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
      auditEvent('candidate_extracted', {
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
      void _onCandidate({
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
      log('[CHAIN] no WSS URL — falling back to HTTP polling');
      startHttpPoll();
      return;
    }
    _ws = ws;
    _mode = 'websocket';

    ws.on('block', (blockNumber) => {
      _wsConnected = true;
      onNewBlock(blockNumber).catch((e) => log('[CHAIN] block error: ' + e.message));
    });

    const onDisconnect = () => {
      _wsConnected = false;
      auditEvent('ws_disconnected');
      log('[CHAIN] websocket disconnected — reconnecting');
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
    startHttpPoll();
  }
}

function startHttpPoll() {
  stopHttpPoll();
  _mode = 'http-poll';
  _wsConnected = false;
  const ms = Math.max(500, Number(process.env.CHAIN_HTTP_POLL_MS) || 2000);
  log('CHAIN: DEGRADED — HTTP polling every ' + ms + 'ms');

  let lastHead = getLastProcessedBlock();
  _httpPollTimer = setInterval(async () => {
    if (!_running) return;
    try {
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
    } catch (e) {
      log('[CHAIN] HTTP poll error: ' + e.message);
    }
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
