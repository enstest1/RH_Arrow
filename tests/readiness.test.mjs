/**
 * Live ARM requires healthy WSS unless ALLOW_HTTP_ONLY_LIVE=true.
 * HTTP-only remains valid for tests / dry-run / replay (this file never opens a socket).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeDiscoveryProvider } from './helpers/mockrpc.mjs';

const dir = path.join(os.tmpdir(), 'rh-ready-' + process.pid);
mkdirSync(dir, { recursive: true });
process.env.AUTOBUY_STATE_PATH = path.join(dir, 'state.json');
process.env.AUTOBUY_AUDIT_PATH = path.join(dir, 'audit.jsonl');

const { runStartupSelfCheck, allowHttpOnlyLive } = await import('../src/readiness.js');

const WALLET = { address: '0x1111111111111111111111111111111111111111' };
const settings = {
  chainEnabled: true,
  targetSymbol: 'CLOCKIN',
  chainWatchlist: [{
    address: '0x4Be25231574464E58c593BC3001b4BdEE37954A6',
    role: 'direct-deployer-eoa',
    label: 'test',
    enabled: true,
  }],
};

function provider() {
  return makeDiscoveryProvider();
}

test('allowHttpOnlyLive defaults false', () => {
  const prev = process.env.ALLOW_HTTP_ONLY_LIVE;
  delete process.env.ALLOW_HTTP_ONLY_LIVE;
  assert.equal(allowHttpOnlyLive(), false);
  if (prev != null) process.env.ALLOW_HTTP_ONLY_LIVE = prev;
});

test('missing WSS without override DISARMS with live_wss_required', async () => {
  const prev = process.env.ALLOW_HTTP_ONLY_LIVE;
  delete process.env.ALLOW_HTTP_ONLY_LIVE;
  const ready = await runStartupSelfCheck({
    provider: provider(),
    wallet: WALLET,
    settings,
    wssOk: false,
  });
  if (prev != null) process.env.ALLOW_HTTP_ONLY_LIVE = prev;
  else delete process.env.ALLOW_HTTP_ONLY_LIVE;
  assert.equal(ready.canArm, false);
  assert.equal(ready.reason, 'live_wss_required');
  assert.match(ready.summary, /WSS\s+FAIL/);
  assert.match(ready.summary, /HTTP FALLBACK\s+AVAILABLE/);
  assert.match(ready.summary, /AUTO BUY\s+DISARMED/);
  assert.match(ready.summary, /REASON\s+live_wss_required/);
});

test('missing WSS with ALLOW_HTTP_ONLY_LIVE=true may ARM', async () => {
  const prev = process.env.ALLOW_HTTP_ONLY_LIVE;
  process.env.ALLOW_HTTP_ONLY_LIVE = 'true';
  const ready = await runStartupSelfCheck({
    provider: provider(),
    wallet: WALLET,
    settings,
    wssOk: false,
  });
  if (prev != null) process.env.ALLOW_HTTP_ONLY_LIVE = prev;
  else delete process.env.ALLOW_HTTP_ONLY_LIVE;
  assert.equal(ready.canArm, true);
  assert.equal(ready.reason, null);
  assert.match(ready.summary, /AUTO BUY\s+ARMED/);
});

test('healthy WSS allows ARM without HTTP-only override', async () => {
  const prev = process.env.ALLOW_HTTP_ONLY_LIVE;
  delete process.env.ALLOW_HTTP_ONLY_LIVE;
  const ready = await runStartupSelfCheck({
    provider: provider(),
    wallet: WALLET,
    settings,
    wssOk: true,
  });
  if (prev != null) process.env.ALLOW_HTTP_ONLY_LIVE = prev;
  else delete process.env.ALLOW_HTTP_ONLY_LIVE;
  assert.equal(ready.canArm, true);
  assert.match(ready.summary, /WSS\s+PASS/);
  assert.match(ready.summary, /AUTO BUY\s+ARMED/);
});
