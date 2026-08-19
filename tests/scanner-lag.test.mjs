/**
 * Scanner runtime: head-first catch-up, WSS stale, dedupe. No broadcasts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultChainWatchlist } from '../src/chainwatchlist.js';

const dir = path.join(os.tmpdir(), 'rh-lag-' + process.pid);
mkdirSync(dir, { recursive: true });
process.env.AUTOBUY_STATE_PATH = path.join(dir, 'state.json');
process.env.AUTOBUY_AUDIT_PATH = path.join(dir, 'audit.jsonl');
process.env.CHAIN_CATCHUP_BATCH = '8';
process.env.CHAIN_WSS_STALE_MS = '50';
process.env.CHAIN_LIVE_RECOVERY_WINDOW = '24';
process.env.CHAIN_LIVE_RECOVERY_BATCH = '4';

const { setLastProcessedBlock } = await import('../src/autostate.js');
const {
  startChainScanner,
  resetScannerForTest,
  handleNewHead,
  handleHttpHead,
  inspectBlock,
  requestCatchUp,
  evaluateWsHealth,
  getChainScannerStatus,
  pendingCandidateDispatchCount,
  emulateWsDisconnectForTest,
  backdateLastWsBlockForTest,
  emulateWsReconnectForTest,
} = await import('../src/chainscanner.js');

function settings() {
  return { chainEnabled: true, chainWatchlist: defaultChainWatchlist() };
}

function emptyProvider(order, delays = {}) {
  return {
    getBlock: async (n) => {
      const delay = delays[n] || delays.default || 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      order.push(n);
      return { number: n, transactions: [], prefetchedTransactions: [] };
    },
    getTransaction: async () => null,
    getTransactionReceipt: async () => ({ logs: [] }),
    getBlockNumber: async () => order[order.length - 1] || 0,
  };
}

function boot(provider) {
  resetScannerForTest();
  startChainScanner({
    disableNetwork: true,
    provider,
    onCandidate: async () => {},
    getSettings: settings,
    log: () => {},
  });
}

test.after(() => {
  resetScannerForTest();
});

test('WSS connected and continuous blocks do not start catch-up', async () => {
  const order = [];
  const provider = emptyProvider(order);
  boot(provider);
  setLastProcessedBlock(100);
  await handleNewHead(101, { source: 'wss' });
  await handleNewHead(102, { source: 'wss' });
  await handleNewHead(103, { source: 'wss' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, [101, 102, 103]);
  const st = getChainScannerStatus();
  assert.equal(st.lastProcessedBlock, 103);
  assert.equal(st.wsConnected, true);
});

test('missing several WSS blocks are recovered by catch-up', async () => {
  const order = [];
  boot(emptyProvider(order));
  setLastProcessedBlock(10);
  await handleNewHead(14, { source: 'wss' });
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(order.includes(14), 'head inspected');
  assert.ok(order.indexOf(14) === 0, 'head before holes');
  for (const n of [11, 12, 13, 14]) assert.ok(order.includes(n), 'recovered ' + n);
});

test('new WSS head is inspected immediately while 1000-block catch-up runs', async () => {
  const order = [];
  const delays = { default: 2 };
  boot(emptyProvider(order, delays));
  setLastProcessedBlock(0);
  try {
    requestCatchUp(1000);
    await new Promise((r) => setTimeout(r, 20));
    await handleNewHead(2000, { source: 'wss' });
    const headAt = order.indexOf(2000);
    assert.ok(headAt >= 0, 'head inspected');
    const processedBeforeHead = order.slice(0, headAt).length;
    assert.ok(processedBeforeHead < 1000, 'must not finish 1000 old blocks before the new head');
  } finally {
    resetScannerForTest();
  }
});

test('same block via WSS and HTTP catch-up is processed once', async () => {
  const order = [];
  boot(emptyProvider(order));
  setLastProcessedBlock(50);
  await Promise.all([
    handleNewHead(51, { source: 'wss' }),
    handleHttpHead(51),
    inspectBlock(51),
  ]);
  assert.equal(order.filter((n) => n === 51).length, 1);
});

test('silent WSS while HTTP head advances is stale and reconnects', async () => {
  let reconnects = 0;
  const order = [];
  resetScannerForTest();
  startChainScanner({
    disableNetwork: true,
    provider: emptyProvider(order),
    onCandidate: async () => {},
    getSettings: settings,
    log: () => {},
    onStaleReconnect: () => { reconnects += 1; },
  });
  setLastProcessedBlock(70);
  await handleNewHead(71, { source: 'wss' });
  const health = evaluateWsHealth({
    now: Date.now() + 1000,
    httpHead: 80,
    lastWsAt: Date.now() - 1000,
    lastWsBlock: 71,
    wsConnected: true,
  });
  assert.equal(health.stale, true);
  assert.equal(health.reason, 'silent_wss');
  assert.equal(evaluateWsHealth({
    now: Date.now(),
    httpHead: 71,
    lastWsAt: Date.now() - 1000,
    lastWsBlock: 71,
    wsConnected: true,
  }).stale, false, 'idle chain must not force reconnect');
  backdateLastWsBlockForTest(1000);
  await handleHttpHead(80);
  assert.ok(reconnects >= 1, 'stale WSS must reconnect');
  assert.ok(order.includes(80), 'HTTP head inspected while WSS silent');
});

test('reconnect/catch-up does not destroy pending candidate callback', async () => {
  const seen = [];
  const order = [];
  resetScannerForTest();
  startChainScanner({
    disableNetwork: true,
    provider: emptyProvider(order),
    onCandidate: async (c) => { seen.push(c); },
    getSettings: settings,
    log: () => {},
  });
  setLastProcessedBlock(1);
  try {
    await handleNewHead(2, { source: 'wss' });
    const before = pendingCandidateDispatchCount();
    emulateWsDisconnectForTest();
    requestCatchUp(2);
    await handleNewHead(3, { source: 'wss' });
    assert.equal(getChainScannerStatus().scannerMode === 'off', false);
    assert.ok(pendingCandidateDispatchCount() >= before);
  } finally {
    resetScannerForTest();
  }
});

test('HTTP fallback scans current head before historical 101–999', async () => {
  const order = [];
  boot(emptyProvider(order, { default: 2 }));
  setLastProcessedBlock(100);
  await handleHttpHead(1000);
  assert.equal(order[0], 1000, 'current HTTP head first');
  const st = getChainScannerStatus();
  assert.equal(st.latestLiveScannedBlock, 1000);
  assert.equal(st.liveLag, 0);
  assert.ok((st.contiguousHistoricalBlock || 0) < 1000);
});

test('recent live window inspects 101–105 after jump 100 → 105', async () => {
  const order = [];
  boot(emptyProvider(order));
  setLastProcessedBlock(100);
  await handleHttpHead(105);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(order[0], 105);
  for (const n of [101, 102, 103, 104, 105]) {
    assert.ok(order.includes(n), 'recent live missing ' + n);
  }
});

test('WSS drop keeps HTTP liveLag small while background lag may be huge', async () => {
  const order = [];
  boot(emptyProvider(order));
  setLastProcessedBlock(100);
  await handleNewHead(100, { source: 'wss' });
  emulateWsDisconnectForTest();
  await handleHttpHead(1000);
  const st = getChainScannerStatus();
  assert.equal(st.scannerMode, 'http-fallback');
  assert.equal(st.wsConnected, false);
  assert.ok(st.liveLag != null && st.liveLag <= 2, 'liveLag=' + st.liveLag);
  assert.ok(st.backgroundLag == null || st.backgroundLag > 2);
});

test('WSS reconnect restores websocket mode without duplicate scan', async () => {
  const order = [];
  boot(emptyProvider(order));
  setLastProcessedBlock(50);
  await handleNewHead(51, { source: 'wss' });
  emulateWsDisconnectForTest();
  await handleHttpHead(52);
  emulateWsReconnectForTest();
  await handleNewHead(52, { source: 'wss' });
  assert.equal(getChainScannerStatus().scannerMode, 'websocket');
  assert.equal(order.filter((n) => n === 52).length, 1);
});

test('historical catch-up is paused under RPC pressure', async () => {
  const order = [];
  const { notifyRpcPressure } = await import('../src/chainscanner.js');
  boot(emptyProvider(order, { default: 2 }));
  setLastProcessedBlock(100);
  notifyRpcPressure(2000);
  requestCatchUp(180);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(order.includes(101), false, 'P2 must yield under pressure');
  await handleHttpHead(200);
  assert.equal(order[0], 200, 'P0 head still scanned under pressure');
});
