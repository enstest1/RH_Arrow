/**
 * Stale chain-candidate gate. No broadcasts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultChainWatchlist } from '../src/chainwatchlist.js';

const dir = path.join(os.tmpdir(), 'rh-fresh-' + process.pid);
mkdirSync(dir, { recursive: true });
process.env.AUTOBUY_STATE_PATH = path.join(dir, 'state.json');
process.env.AUTOBUY_AUDIT_PATH = path.join(dir, 'audit.jsonl');
process.env.MAX_CHAIN_CANDIDATE_AGE_BLOCKS = '32';

const { evaluateChainCandidateFreshness } = await import('../src/chainfreshness.js');
const { handleCandidate, saveSettings } = await import('../src/autobuy.js');
const { makeDiscoveryProvider, STRIKE } = await import('./helpers/mockrpc.mjs');
const { initAggregator } = await import('../src/routes/aggregator.js');

const WATCH = '0x4Be25231574464E58c593BC3001b4BdEE37954A6';

saveSettings({
  enabled: true,
  maxSpendEth: '0.01',
  slippageTolerancePct: '15',
  targetSymbol: 'CLOCKIN',
  chainEnabled: true,
  chainWatchlist: defaultChainWatchlist(),
});

test('evaluateChainCandidateFreshness rejects old source blocks', () => {
  const r = evaluateChainCandidateFreshness({
    source: { type: 'chain', blockNumber: 10, detectedAt: Date.now() },
    currentHead: 1000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stale_chain_candidate');
  assert.equal(r.ageBlocks, 990);
});

test('X candidates are not freshness-gated', () => {
  const r = evaluateChainCandidateFreshness({
    source: { type: 'x', handle: 'clockincoin' },
    currentHead: 1000,
  });
  assert.equal(r.ok, true);
});

test('stale chain candidate is terminal and never sends', async () => {
  let sends = 0;
  const provider = {
    getBlockNumber: async () => 1000,
    getBalance: async () => 10n ** 18n,
    sendTransaction: async () => { sends += 1; return { hash: '0xdead' }; },
  };
  const result = await handleCandidate({
    contract: '0x1111111111111111111111111111111111111111',
    source: {
      type: 'chain',
      address: WATCH,
      role: 'direct-deployer-eoa',
      blockNumber: 10,
      detectedAt: Date.now(),
    },
    dryRun: false,
    provider,
    wallet: { address: '0x0000000000000000000000000000000000000001', provider },
  });
  assert.equal(result.reason, 'stale_chain_candidate');
  assert.equal(result.status, 'terminal');
  assert.equal(sends, 0);
});

test('fresh chain candidate near head proceeds through dry-run routing', async () => {
  const base = makeDiscoveryProvider({
    tokenMeta: { [STRIKE]: { symbol: 'CLOCKIN', name: 'CLOCKIN', decimals: 18 } },
  });
  const provider = { ...base, getBlockNumber: async () => 1000 };
  await initAggregator(provider);
  const result = await handleCandidate({
    contract: STRIKE,
    source: {
      type: 'chain',
      address: WATCH,
      role: 'direct-deployer-eoa',
      blockNumber: 999,
      detectedAt: Date.now(),
    },
    dryRun: true,
    provider,
    wallet: { address: '0x0000000000000000000000000000000000000001', provider },
  });
  assert.notEqual(result.reason, 'stale_chain_candidate');
  assert.equal(result.dryRun, true);
  assert.equal(result.action, 'simulated');
});
