/**
 * Full scanner entry path: Ethers v6 block → watch match → extract → handleCandidate DRY RUN.
 * Proves the original `typeof tx === 'string' continue` skip cannot return.
 * Never broadcasts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { defaultChainWatchlist } from '../src/chainwatchlist.js';
import { makeDiscoveryProvider, STRIKE, MANCER } from './helpers/mockrpc.mjs';

const dir = path.join(os.tmpdir(), 'rh-pipe-' + process.pid);
mkdirSync(dir, { recursive: true });
process.env.AUTOBUY_STATE_PATH = path.join(dir, 'state.json');
process.env.AUTOBUY_AUDIT_PATH = path.join(dir, 'audit.jsonl');

const { processBlock } = await import('../src/chainscanner.js');
const { handleCandidate, saveSettings } = await import('../src/autobuy.js');
const { initAggregator } = await import('../src/routes/aggregator.js');

const WATCHED = '0x4Be25231574464E58c593BC3001b4BdEE37954A6';
const HASH_PRE = '0x' + 'aa'.repeat(32);
const HASH_PRE_NOISE = '0x' + 'ab'.repeat(32);
const HASH_FALLBACK = '0x' + 'cc'.repeat(32);

saveSettings({
  enabled: true,
  maxSpendEth: '0.01',
  slippageTolerancePct: '15',
  targetSymbol: 'CLOCKIN',
  chainEnabled: true,
  xEnabled: false,
  chainWatchlist: defaultChainWatchlist(),
});

function watchedTx(hash) {
  return {
    hash,
    from: WATCHED,
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    value: 0n,
  };
}

function noiseTx(hash) {
  return {
    hash,
    from: '0x2222222222222222222222222222222222222222',
    to: '0x3333333333333333333333333333333333333333',
    data: '0x',
    value: 0n,
  };
}

function mintReceipt(hash, token) {
  return {
    hash,
    from: WATCHED,
    to: '0x1111111111111111111111111111111111111111',
    contractAddress: null,
    logs: [{
      address: token,
      topics: [
        ethers.id('Transfer(address,address,uint256)'),
        ethers.zeroPadValue('0x00', 32),
        ethers.zeroPadValue(WATCHED, 32),
      ],
      index: 0,
    }],
  };
}

function pipelineProvider(blockShape, receipts) {
  const base = makeDiscoveryProvider({
    tokenMeta: {
      [STRIKE]: { symbol: 'CLOCKIN', name: 'CLOCKIN', decimals: 18 },
      [MANCER]: { symbol: 'CLOCKIN', name: 'CLOCKIN', decimals: 18 },
    },
  });
  return {
    ...base,
    getBlock: async () => blockShape,
    getTransaction: async (h) => {
      const txs = blockShape.prefetchedTransactions || blockShape._resolved || [];
      return txs.find((t) => t.hash === h) || null;
    },
    getTransactionReceipt: async (h) => receipts[h] || { hash: h, logs: [] },
  };
}

async function runToDryHandle(provider, blockNumber) {
  const seen = [];
  await initAggregator(provider);
  await processBlock(blockNumber, {
    running: true,
    getSettings: () => ({
      chainEnabled: true,
      chainWatchlist: defaultChainWatchlist(),
    }),
    provider,
    onCandidate: async (c) => { seen.push(c); },
  });
  assert.equal(seen.length, 1, 'watched tx must extract exactly one candidate');
  return handleCandidate({
    ...seen[0],
    dryRun: true,
    provider,
    wallet: { address: '0x0000000000000000000000000000000000000001', provider },
  });
}

test('prefetchedTransactions path reaches handleCandidate dry-run simulation', async () => {
  const provider = pipelineProvider({
    number: 101,
    transactions: [HASH_PRE, HASH_PRE_NOISE],
    prefetchedTransactions: [watchedTx(HASH_PRE), noiseTx(HASH_PRE_NOISE)],
  }, { [HASH_PRE]: mintReceipt(HASH_PRE, STRIKE) });
  const result = await runToDryHandle(provider, 101);
  assert.ok(result, 'candidate must reach handleCandidate');
  assert.equal(result.dryRun, true);
  assert.equal(result.action, 'simulated');
  assert.equal(result.venue, 'aggregator');
  assert.equal(result.simulation?.ok, true);
  assert.equal(result.sent, undefined);
});

test('hash-only fallback still reaches handleCandidate dry-run simulation', async () => {
  const txs = [watchedTx(HASH_FALLBACK)];
  const provider = pipelineProvider({
    number: 102,
    transactions: [HASH_FALLBACK],
    _resolved: txs,
  }, { [HASH_FALLBACK]: mintReceipt(HASH_FALLBACK, MANCER) });
  const result = await runToDryHandle(provider, 102);
  assert.ok(result, 'hash fallback must dispatch a candidate');
  assert.equal(result.dryRun, true);
  assert.equal(result.action, 'simulated');
  assert.equal(result.venue, 'aggregator');
  assert.notEqual(result.action, 'bought');
});
