/**
 * Restart / X+chain CA dedupe. No broadcasts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultChainWatchlist } from '../src/chainwatchlist.js';

const dir = path.join(os.tmpdir(), 'rh-safe-' + process.pid);
mkdirSync(dir, { recursive: true });
process.env.AUTOBUY_STATE_PATH = path.join(dir, 'state.json');
process.env.AUTOBUY_AUDIT_PATH = path.join(dir, 'audit.jsonl');

const { handleCandidate, saveSettings } = await import('../src/autobuy.js');
const { recordBuy, alreadyBought } = await import('../src/autostate.js');
const { makeDiscoveryProvider, STRIKE } = await import('./helpers/mockrpc.mjs');
const { initAggregator } = await import('../src/routes/aggregator.js');

const WATCH = '0x4Be25231574464E58c593BC3001b4BdEE37954A6';

saveSettings({
  enabled: true,
  maxSpendEth: '0.01',
  slippageTolerancePct: '15',
  targetSymbol: 'CLOCKIN',
  chainEnabled: true,
  xEnabled: true,
  handles: ['clockincoin'],
  chainWatchlist: defaultChainWatchlist(),
});

test('restart does not rebuy an already-purchased target', async () => {
  recordBuy(STRIKE, { txHash: '0xabc', symbol: 'CLOCKIN' });
  assert.equal(alreadyBought(STRIKE), true);
  let sends = 0;
  const provider = {
    getBlockNumber: async () => 1000,
    getBalance: async () => 10n ** 18n,
    sendTransaction: async () => { sends += 1; return { hash: '0xdead' }; },
  };
  const r = await handleCandidate({
    contract: STRIKE,
    source: { type: 'chain', address: WATCH, role: 'direct-deployer-eoa', blockNumber: 999, detectedAt: Date.now() },
    dryRun: false,
    provider,
    wallet: { address: '0x0000000000000000000000000000000000000001', provider },
  });
  assert.equal(r.reason, 'already_bought');
  assert.equal(sends, 0);
});

test('X + chain seeing the same CA is deduped', async () => {
  const token = '0x3333333333333333333333333333333333333333';
  const base = makeDiscoveryProvider({
    tokenMeta: { [token]: { symbol: 'CLOCKIN', name: 'CLOCKIN', decimals: 18 } },
  });
  const provider = { ...base, getBlockNumber: async () => 1000, getBalance: async () => 10n ** 18n };
  await initAggregator(provider);
  const chain = await handleCandidate({
    contract: token,
    source: { type: 'chain', address: WATCH, role: 'direct-deployer-eoa', blockNumber: 999, detectedAt: Date.now() },
    dryRun: true,
    provider,
    wallet: { address: '0x0000000000000000000000000000000000000001', provider },
  });
  const x = await handleCandidate({
    contract: token,
    source: { type: 'x', handle: 'clockincoin' },
    dryRun: true,
    provider,
    wallet: { address: '0x0000000000000000000000000000000000000001', provider },
  });
  assert.notEqual(chain.reason, 'duplicate_candidate');
  assert.equal(x.reason, 'duplicate_candidate');
});
