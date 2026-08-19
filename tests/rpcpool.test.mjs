/**
 * HTTP/WSS provider failover. No live network, no broadcasts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpRpcPool,
  sanitizeRpcUrl,
  rotateWssEndpoint,
  peekWssEndpoint,
  resetWssIndexForTest,
  listHttpEndpoints,
  listWssEndpoints,
} from '../src/rpcpool.js';

function err429() {
  const e = new Error('429 monthly capacity limit');
  e.shortMessage = '429 monthly capacity limit';
  return e;
}

test('sanitizeRpcUrl strips Alchemy keys', () => {
  const s = sanitizeRpcUrl('https://robinhood-mainnet.g.alchemy.com/v2/supersecretkeyvalue');
  assert.equal(s.includes('supersecretkeyvalue'), false);
  assert.match(s, /v2\/\*\*\*/);
});

test('primary HTTP 429 fails over to secondary', async () => {
  const hits = [];
  const pool = new HttpRpcPool([
    { url: 'http://127.0.0.1:1/primary', label: 'alchemy-http-primary' },
    { url: 'http://127.0.0.1:1/secondary', label: 'public-rpc-secondary' },
  ], {
    sendImpl: async (ep) => {
      hits.push(ep.label);
      if (ep.label.includes('primary')) throw err429();
      return 99;
    },
  });
  const n = await pool.send('eth_blockNumber', []);
  assert.equal(n, 99);
  assert.equal(hits[0], 'alchemy-http-primary');
  assert.equal(pool.activeLabel, 'public-rpc-secondary');
  assert.ok(pool.rateLimitCount >= 1);
  assert.equal(pool.snapshot().provider429, true);
});

test('primary HTTP timeout fails over to secondary', async () => {
  process.env.RPC_TIMEOUT_MS = '40';
  const hits = [];
  const pool = new HttpRpcPool([
    { url: 'http://127.0.0.1:1/primary', label: 'http-primary' },
    { url: 'http://127.0.0.1:1/secondary', label: 'http-secondary' },
  ], {
    sendImpl: async (ep) => {
      hits.push(ep.label);
      if (ep.label.includes('primary')) {
        await new Promise((r) => setTimeout(r, 200));
        return 1;
      }
      return 7;
    },
  });
  const n = await pool.send('eth_blockNumber', []);
  assert.equal(n, 7);
  assert.ok(hits.includes('http-secondary'));
  delete process.env.RPC_TIMEOUT_MS;
});

test('rate-limited primary stays on cooldown and is skipped', async () => {
  let now = 1_000;
  const hits = [];
  const pool = new HttpRpcPool([
    { url: 'http://127.0.0.1:1/primary', label: 'http-primary' },
    { url: 'http://127.0.0.1:1/secondary', label: 'http-secondary' },
  ], {
    now: () => now,
    sendImpl: async (ep) => {
      hits.push(ep.label + '@' + now);
      if (ep.label.includes('primary')) throw err429();
      return 3;
    },
  });
  await pool.send('eth_blockNumber', []);
  const afterFirst = hits.filter((h) => h.startsWith('http-primary')).length;
  now += 10;
  await pool.send('eth_blockNumber', []);
  const afterSecond = hits.filter((h) => h.startsWith('http-primary')).length;
  assert.equal(afterSecond, afterFirst, 'cooldown must skip primary');
  assert.equal(pool.activeLabel, 'http-secondary');
});

test('public HTTP is always listed as a fallback endpoint', () => {
  const list = listHttpEndpoints();
  assert.ok(list.some((e) => e.url.includes('rpc.mainnet.chain.robinhood.com')));
});

test('WSS rotate advances to secondary when configured', () => {
  const prevP = process.env.RPC_WSS_PRIMARY;
  const prevS = process.env.RPC_WSS_SECONDARY;
  const prevT = process.env.RPC_WSS_TERTIARY;
  const prevA = process.env.ALCHEMY_WSS_URL;
  const prevK = process.env.ALCHEMY_KEY;
  process.env.RPC_WSS_PRIMARY = 'wss://example-primary.example/ws';
  process.env.RPC_WSS_SECONDARY = 'wss://example-secondary.example/ws';
  process.env.RPC_WSS_TERTIARY = 'wss://example-tertiary.example/ws';
  delete process.env.ALCHEMY_WSS_URL;
  delete process.env.ALCHEMY_KEY;
  resetWssIndexForTest();
  const list = listWssEndpoints();
  assert.equal(list.length, 3);
  const a = peekWssEndpoint();
  const b = rotateWssEndpoint();
  const c = rotateWssEndpoint();
  assert.ok(a && b && c);
  assert.notEqual(a.label, b.label);
  assert.notEqual(b.label, c.label);
  resetWssIndexForTest();
  if (prevP != null) process.env.RPC_WSS_PRIMARY = prevP; else delete process.env.RPC_WSS_PRIMARY;
  if (prevS != null) process.env.RPC_WSS_SECONDARY = prevS; else delete process.env.RPC_WSS_SECONDARY;
  if (prevT != null) process.env.RPC_WSS_TERTIARY = prevT; else delete process.env.RPC_WSS_TERTIARY;
  if (prevA != null) process.env.ALCHEMY_WSS_URL = prevA; else delete process.env.ALCHEMY_WSS_URL;
  if (prevK != null) process.env.ALCHEMY_KEY = prevK; else delete process.env.ALCHEMY_KEY;
});
