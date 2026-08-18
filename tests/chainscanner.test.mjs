/**
 * Ethers v6 block handling: hashes live in block.transactions;
 * prefetched objects live in block.prefetchedTransactions.
 * This fails against `for (const tx of block.transactions) if (typeof tx === 'string') continue`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { defaultChainWatchlist } from '../src/chainwatchlist.js';

const dir = path.join(os.tmpdir(), 'rh-scan-' + process.pid);
mkdirSync(dir, { recursive: true });
process.env.AUTOBUY_STATE_PATH = path.join(dir, 'state.json');
process.env.AUTOBUY_AUDIT_PATH = path.join(dir, 'audit.jsonl');

const { processBlock, resolveBlockTransactions, emulateWsDisconnectForTest, getChainScannerStatus } = await import('../src/chainscanner.js');

const WATCHED = '0x4Be25231574464E58c593BC3001b4BdEE37954A6';
const TOKEN = '0x6543b7746Ca744C4bb2198191E71F40fF04C41B9';
const HASH1 = '0x' + '11'.repeat(32);
const HASH2 = '0x' + '22'.repeat(32);

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

function mintReceipt(hash) {
  return {
    hash,
    from: WATCHED,
    to: '0x1111111111111111111111111111111111111111',
    contractAddress: null,
    logs: [{
      address: TOKEN,
      topics: [
        ethers.id('Transfer(address,address,uint256)'),
        ethers.zeroPadValue('0x00', 32),
        ethers.zeroPadValue(WATCHED, 32),
      ],
      index: 0,
    }],
  };
}

function settings() {
  return { chainEnabled: true, chainWatchlist: defaultChainWatchlist() };
}

test('resolveBlockTransactions uses prefetchedTransactions without getTransaction', async () => {
  let fetched = 0;
  const provider = {
    getTransaction: async () => {
      fetched += 1;
      return null;
    },
  };
  const block = {
    transactions: [HASH1, HASH2],
    prefetchedTransactions: [watchedTx(HASH1), noiseTx(HASH2)],
  };
  const txs = await resolveBlockTransactions(provider, block);
  assert.equal(txs.length, 2);
  assert.equal(txs[0].hash, HASH1);
  assert.equal(fetched, 0, 'must not refetch when prefetchedTransactions exist');
});

test('resolveBlockTransactions falls back to getTransaction for hash-only blocks', async () => {
  const byHash = { [HASH1]: watchedTx(HASH1), [HASH2]: noiseTx(HASH2) };
  let fetched = 0;
  const provider = {
    getTransaction: async (h) => {
      fetched += 1;
      return byHash[h];
    },
  };
  const block = { transactions: [HASH1, HASH2] };
  const txs = await resolveBlockTransactions(provider, block);
  assert.equal(txs.length, 2);
  assert.equal(fetched, 2);
  assert.equal(txs[0].from, WATCHED);
});

test('prefetched Ethers v6 block dispatches a watched candidate', async () => {
  const seen = [];
  const provider = {
    getBlock: async () => ({
      number: 99,
      transactions: [HASH1, HASH2],
      prefetchedTransactions: [watchedTx(HASH1), noiseTx(HASH2)],
    }),
    getTransaction: async () => {
      throw new Error('getTransaction should not run when prefetched');
    },
    getTransactionReceipt: async (h) => (h === HASH1 ? mintReceipt(HASH1) : { hash: h, logs: [] }),
  };
  await processBlock(99, {
    running: true,
    onCandidate: async (c) => { seen.push(c); },
    getSettings: settings,
    provider,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].contract.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(seen[0].source.txHash, HASH1);
  await processBlock(99, {
    running: true,
    onCandidate: async (c) => { seen.push(c); },
    getSettings: settings,
    provider,
  });
  assert.equal(seen.length, 1, 'duplicate block/tx must not re-dispatch');
});

test('hash-only fallback still matches watched from-address and dispatches', async () => {
  const hash = '0x' + '33'.repeat(32);
  const seen = [];
  const provider = {
    getBlock: async () => ({ number: 100, transactions: [hash] }),
    getTransaction: async (h) => (h === hash ? watchedTx(hash) : null),
    getTransactionReceipt: async () => mintReceipt(hash),
  };
  await processBlock(100, {
    running: true,
    onCandidate: async (c) => { seen.push(c); },
    getSettings: settings,
    provider,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].source.address.toLowerCase(), WATCHED.toLowerCase());
});

test('WSS disconnect exposes scannerMode http-fallback without dropping scanner state', () => {
  emulateWsDisconnectForTest();
  const st = getChainScannerStatus();
  assert.equal(st.scannerMode, 'http-fallback');
  assert.equal(st.wsConnected, false);
});
