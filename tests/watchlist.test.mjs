/**
 * Seeded watchlist must wake each historical launch tx from at least one address.
 * 0x432d20… is the live AMMFactoryV2 for MANCER/WALL/YARD — not a secondary hint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultChainWatchlist,
  enabledWatchSet,
  findWatchEntry,
} from '../src/chainwatchlist.js';
import { txTouchesWatch, matchedWatchSide } from '../src/candidateextract.js';

const FACTORY_V2 = '0x432d20aae5605b1e94c914283d7155ebc6727351';
const SECONDARY_CREATOR = '0x662003bf6049e36b4e887d47b8df8718ffbbc6c2';

const HISTORICAL = {
  DERP: { from: '0x4Be25231574464E58c593BC3001b4BdEE37954A6', to: null },
  MANCER: { from: '0x0dc1dd32b1300818c977ce5a36a464a5c0c14550', to: FACTORY_V2 },
  WALL: { from: '0x6a912148ec4ce6dc99c396a3424a477568edb46e', to: FACTORY_V2 },
  STRIKE: { from: '0x3238d679b3d18c88039e786e2e4d5afb41735f6f', to: '0xc6cc8979e6e4f74d2da3ff2e514ff3f336cb1e73' },
  YARD: { from: '0x04d870ff10ccba4b7ee7387e8e3189adac79bf83', to: FACTORY_V2 },
};

const settings = { chainWatchlist: defaultChainWatchlist() };
const watch = enabledWatchSet(settings);

test('AMMFactoryV2 0x432d20… is seeded as the MANCER/WALL/YARD live factory', () => {
  const e = findWatchEntry(settings, FACTORY_V2);
  assert.ok(e);
  assert.equal(e.role, 'amm-factory-v2');
  assert.match(e.label, /MANCER\/WALL\/YARD/);
});

test('0x662003… is labeled secondary, not the MANCER/WALL live trigger', () => {
  const e = findWatchEntry(settings, SECONDARY_CREATOR);
  assert.ok(e);
  assert.match(e.label, /Secondary fingerprint/i);
});

for (const [name, tx] of Object.entries(HISTORICAL)) {
  test('historical ' + name + ' wakes from a seeded watched address', () => {
    assert.equal(txTouchesWatch(tx, watch), true, name + ' must match watchlist');
    const side = matchedWatchSide(tx, watch);
    assert.ok(side, name + ' matched side');
    const entry = findWatchEntry(settings, side.address);
    assert.ok(entry, name + ' watch entry');
    if (name === 'MANCER' || name === 'WALL') {
      assert.equal(side.address, FACTORY_V2);
    }
    if (name === 'YARD') {
      // from (launch caller) is also seeded, so matchedWatchSide prefers from.
      assert.ok(
        side.address === FACTORY_V2 || side.address === '0x04d870ff10ccba4b7ee7387e8e3189adac79bf83',
      );
    }
  });
}
