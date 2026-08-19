import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ethToWei, weiToEthNum, priceImpactPct, minOutWei, validateSettings, evaluateBuy, evaluateSourceTrust,
  evaluateTargetSymbol, symbolMatchesTarget, isTrustedSource, ETH,
} from '../src/swaprules.js';
import { defaultChainWatchlist } from '../src/chainwatchlist.js';

const settings = (over = {}) => ({
  enabled: true,
  maxSpendEth: '0.01',
  slippageTolerancePct: '15',
  xEnabled: true,
  handles: ['kol'],
  chainEnabled: false,
  targetSymbol: 'CLOCKIN',
  chainWatchlist: defaultChainWatchlist(),
  ...over,
});

const ctx = (over = {}) => ({
  settings: settings(),
  alreadyBought: false,
  walletBalanceWei: ETH / 10n,
  gasReserveWei: ETH / 1000n,
  quote: { amountOut: 1_000_000n },
  source: { type: 'x', handle: 'kol' },
  symbol: 'CLOCKIN',
  ...over,
});

test('ethToWei is exact at 18 decimals', () => {
  assert.equal(ethToWei(1), ETH);
  assert.equal(ethToWei('0.01'), 10_000_000_000_000_000n);
});

test('symbol matching is case-insensitive', () => {
  assert.equal(symbolMatchesTarget('clockin', 'CLOCKIN'), true);
  assert.equal(symbolMatchesTarget('CLOCKIN2', 'CLOCKIN'), false);
  assert.equal(symbolMatchesTarget('FAKECLOCKIN', 'CLOCKIN'), false);
});

test('watched X handle is trusted', () => {
  const s = settings();
  assert.equal(isTrustedSource(s, { type: 'x', handle: 'kol' }), true);
  assert.equal(isTrustedSource(s, { type: 'x', handle: 'scammer' }), false);
});

test('watched chain address is trusted', () => {
  const s = settings({ chainEnabled: true, xEnabled: false, handles: [] });
  const w = s.chainWatchlist[0];
  assert.equal(isTrustedSource(s, { type: 'chain', address: w.address }), true);
  assert.equal(isTrustedSource(s, { type: 'chain', address: '0x0000000000000000000000000000000000000001' }), false);
});

test('a clean X signal passes', () => {
  const v = evaluateBuy(ctx());
  assert.equal(v.ok, true);
});

test('blank settings refuse to buy', () => {
  const blank = { enabled: true, xEnabled: false, chainEnabled: false, handles: [] };
  const v = evaluateBuy(ctx({ settings: blank }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'unconfigured');
});

test('validateSettings requires at least one source', () => {
  const errs = validateSettings(settings({ xEnabled: false, chainEnabled: false }));
  assert.ok(errs.some((e) => /detection source/.test(e)));
});

test('validateSettings chain mode requires target + watchlist', () => {
  const errs = validateSettings(settings({
    xEnabled: false,
    handles: [],
    chainEnabled: true,
    targetSymbol: '',
    chainWatchlist: [],
  }));
  assert.ok(errs.some((e) => /Target ticker/.test(e)));
  assert.ok(errs.some((e) => /watched launch/.test(e)));
});

test('validateSettings accepts dual-source form', () => {
  assert.deepEqual(validateSettings(settings({ chainEnabled: true })), []);
});

test('master switch blocks everything', () => {
  assert.equal(evaluateBuy(ctx({ settings: settings({ enabled: false }) })).reason, 'disabled');
});

test('untrusted X handle refused', () => {
  assert.equal(evaluateBuy(ctx({ source: { type: 'x', handle: 'scammer' } })).reason, 'untrusted_source');
});

test('wrong symbol refused when target set', () => {
  assert.equal(evaluateBuy(ctx({ symbol: 'OTHER' })).reason, 'wrong_symbol');
});

test('evaluateTargetSymbol rejects wrong ticker', () => {
  const r = evaluateTargetSymbol(settings(), 'DERP');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_symbol');
});

test('already bought never twice', () => {
  assert.equal(evaluateBuy(ctx({ alreadyBought: true })).reason, 'already_bought');
});

test('insufficient balance respected', () => {
  const v = evaluateBuy(ctx({ walletBalanceWei: ethToWei('0.0105'), gasReserveWei: ethToWei('0.001') }));
  assert.equal(v.reason, 'insufficient_balance');
});

test('evaluateBuy uses injected spendWei for AUTO-SAFE sized input', () => {
  const v = evaluateBuy(ctx({
    spendWei: ethToWei('0.0095'),
    gasReserveWei: ethToWei('0.0015'),
    walletBalanceWei: ethToWei('0.011'),
  }));
  assert.equal(v.ok, true);
  assert.equal(v.spendWei, ethToWei('0.0095'));
});

test('no route refused', () => {
  assert.equal(evaluateBuy(ctx({ quote: null })).reason, 'no_route');
});

test('evaluateSourceTrust cheap gate', () => {
  assert.equal(evaluateSourceTrust(settings(), { type: 'x', handle: 'kol' }).ok, true);
  assert.equal(evaluateSourceTrust(settings(), { type: 'chain', address: '0x1' }).ok, false);
});

test('legacy sourceHandle still works via normalizeSource path', () => {
  const v = evaluateBuy(ctx({ source: undefined, sourceHandle: 'kol' }));
  assert.equal(v.ok, true);
});

test('price impact and minOut maths', () => {
  assert.equal(priceImpactPct(950n, 1000n), 5);
  assert.equal(minOutWei(1000n, 10), 900n);
});

test('unmeasured launch tax is not treated as 0% protection', () => {
  const v = evaluateBuy(ctx({
    settings: settings({ maxLaunchTaxPct: '5' }),
    launchTaxPct: null,
  }));
  assert.equal(v.ok, true);
});

test('measured launch tax above max is rejected', () => {
  const v = evaluateBuy(ctx({
    settings: settings({ maxLaunchTaxPct: '5' }),
    launchTaxPct: 12,
  }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'launch_tax_too_high');
});
