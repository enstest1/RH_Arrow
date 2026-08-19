/**
 * Pre-arm refusals. Injected providers only — no ARM, no send.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultChainWatchlist } from '../src/chainwatchlist.js';

const dir = path.join(os.tmpdir(), 'rh-prearm-' + process.pid);
mkdirSync(dir, { recursive: true });
process.env.AUTOBUY_STATE_PATH = path.join(dir, 'state.json');
process.env.AUTOBUY_AUDIT_PATH = path.join(dir, 'audit.jsonl');

const { runPrearm } = await import('../src/prearm.js');

const WALLET = { address: '0x1111111111111111111111111111111111111111' };
const settings = {
  targetSymbol: 'CLOCKIN',
  maxSpendEth: '0.01',
  slippageTolerancePct: '15',
  chainWatchlist: defaultChainWatchlist(),
};

const base = {
  skipNetwork: true,
  settings,
  wallet: WALLET,
  chainId: 4663,
  httpLatencyMs: { PRIMARY: 12, SECONDARY: 40 },
  wssObserve: {
    primary: { ok: true, blocks: 3, label: 'alchemy-wss-primary' },
    secondary: { ok: true, blocks: 0, label: 'none', standby: true },
  },
  scanner: { liveLag: 0, scannerHealth: 'CURRENT', backgroundLag: 140, chainWatching: true },
  xPoll: { ok: true, detail: '3 tweets' },
  agg: {
    proxy: '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc',
    implementation: '0xb70da7425bc26a6afd60d080148248389a9073bf',
    validated: true,
    enabled: true,
    feeRateRaw: 100,
    proxyCodeOk: true,
  },
  v4Ok: true,
  balanceWei: 10n ** 18n,
};

test('prearm refuses stale scanner', async () => {
  const r = await runPrearm({
    ...base,
    scanner: { liveLag: 12, scannerHealth: 'STALE', backgroundLag: 200, chainWatching: true },
  });
  assert.equal(r.ok, false);
  assert.ok(r.fail.includes('LIVE SCANNER'));
  assert.match(r.text, /AUTO BUY\s+DISARMED/);
});

test('prearm refuses wrong chain', async () => {
  const r = await runPrearm({ ...base, chainId: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.fail.includes('CHAIN'));
});

test('prearm refuses empty wallet', async () => {
  const r = await runPrearm({ ...base, balanceWei: 0n });
  assert.equal(r.ok, false);
  assert.ok(r.fail.includes('WALLET'));
});

test('prearm refuses no execution route', async () => {
  const r = await runPrearm({
    ...base,
    agg: { ...base.agg, validated: false, enabled: false },
    v4Ok: false,
  });
  assert.equal(r.ok, false);
  assert.ok(r.fail.includes('BUY ROUTE') || r.fail.includes('V4'));
});

test('healthy injected prearm is READY TO ARM and stays DISARMED', async () => {
  const r = await runPrearm(base);
  assert.equal(r.ok, true);
  assert.match(r.text, /READY TO ARM/);
  assert.match(r.text, /AUTO BUY\s+DISARMED/);
});
