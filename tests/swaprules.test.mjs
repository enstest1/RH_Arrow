import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ethToWei, weiToEthNum, priceImpactPct, minOutWei, validateSettings, evaluateBuy, ETH,
} from '../src/swaprules.js';

const settings = (over = {}) => ({
  enabled: true,
  maxSpendEth: '0.01',
  slippageTolerancePct: '15',
  handles: ['kol'],
  ...over,
});

const ctx = (over = {}) => ({
  settings: settings(),
  alreadyBought: false,
  walletBalanceWei: ETH / 10n,          // 0.1 ETH
  gasReserveWei: ETH / 1000n,           // 0.001 ETH
  quote: { amountOut: 1_000_000n },
  sourceHandle: 'kol',
  ...over,
});

test('ethToWei is exact at 18 decimals', () => {
  assert.equal(ethToWei(1), ETH);
  assert.equal(ethToWei('0.01'), 10_000_000_000_000_000n);
  assert.equal(ethToWei('0.000000000000000001'), 1n);
  assert.equal(ethToWei(''), 0n);
  assert.equal(weiToEthNum(ETH), 1);
});

test('a clean signal from a watched handle passes', () => {
  const v = evaluateBuy(ctx());
  assert.equal(v.ok, true);
  assert.equal(v.spendWei, ethToWei('0.01'));
});

test('blank settings refuse to buy rather than assuming defaults', () => {
  const blank = { enabled: true, handles: [] };
  const v = evaluateBuy(ctx({ settings: blank }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'unconfigured');

  const errs = validateSettings(blank);
  assert.ok(errs.some((e) => /Spend per buy/.test(e)));
  assert.ok(errs.some((e) => /Slippage tolerance/.test(e)));
  assert.ok(errs.some((e) => /handle/.test(e)));
});

test('validateSettings accepts a fully-filled form', () => {
  assert.deepEqual(validateSettings(settings()), []);
});

test('the master switch blocks everything', () => {
  assert.equal(evaluateBuy(ctx({ settings: settings({ enabled: false }) })).reason, 'disabled');
});

test('a CA from an unwatched handle is refused', () => {
  assert.equal(evaluateBuy(ctx({ sourceHandle: 'scammer' })).reason, 'untrusted_source');
});

test('handle matching ignores @ and case', () => {
  const v = evaluateBuy(ctx({ settings: settings({ handles: ['@KOL'] }), sourceHandle: 'kol' }));
  assert.equal(v.ok, true);
});

test('the same contract is never bought twice', () => {
  assert.equal(evaluateBuy(ctx({ alreadyBought: true })).reason, 'already_bought');
});

test('wallet balance is the spend bound — gas reserve is respected', () => {
  const v = evaluateBuy(ctx({ walletBalanceWei: ethToWei('0.0105'), gasReserveWei: ethToWei('0.001') }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'insufficient_balance');

  const ok = evaluateBuy(ctx({ walletBalanceWei: ethToWei('0.012'), gasReserveWei: ethToWei('0.001') }));
  assert.equal(ok.ok, true);
});

test('spending is naturally bounded by a small wallet', () => {
  let balance = ethToWei('0.03');
  const gas = ethToWei('0.001');
  let buys = 0;
  for (let i = 0; i < 20; i++) {
    const v = evaluateBuy(ctx({ walletBalanceWei: balance, gasReserveWei: gas }));
    if (!v.ok) break;
    balance -= v.spendWei + gas;
    buys++;
  }
  assert.ok(buys <= 3 && buys >= 2, 'small wallet caps total exposure, got ' + buys);
});

test('no route is refused rather than guessed', () => {
  assert.equal(evaluateBuy(ctx({ quote: null })).reason, 'no_route');
  assert.equal(evaluateBuy(ctx({ quote: { amountOut: 0n } })).reason, 'no_route');
});

test('price impact and minOut maths', () => {
  assert.equal(priceImpactPct(950n, 1000n), 5);
  assert.equal(priceImpactPct(1000n, 1000n), 0);
  assert.equal(priceImpactPct(100n, 0n), 100);
  assert.equal(minOutWei(1000n, 10), 900n);
  assert.equal(minOutWei(1000n, 0), 1000n);
  assert.equal(minOutWei(1000n, 200), 0n);
});
