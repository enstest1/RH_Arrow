/**
 * tests/historical-detector.test.mjs — exact-tx replay regression (read-only fixtures).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  extractCandidatesFromReceipt,
  txTouchesWatch,
  matchedWatchSide,
} from '../src/candidateextract.js';
import { defaultChainWatchlist, enabledWatchSet, normAddr } from '../src/chainwatchlist.js';

/** @type {Record<string, { ca: string, tx: string, from: string, to: string | null }>} */
const FIXTURES = {
  DERP: {
    ca: '0x6543b7746Ca744C4bb2198191E71F40fF04C41B9',
    tx: '0x64fdf1925d0a6ab50df04052fdadb00e5f96e63bd39f558e2cf37b4f74a67cd4',
    from: '0x4Be25231574464E58c593BC3001b4BdEE37954A6',
    to: null,
  },
  MANCER: {
    ca: '0xc72F232a6869e6CF34dC06129AfFD07F8a2a246A',
    tx: '0x9a6d78c155fc550083f11b7e5368a6afbf7d62deb0ab012d4980bbe31b2eb340',
    from: '0x0dc1dd32b1300818c977ce5a36a464a5c0c14550',
    to: '0x432d20aae5605b1e94c914283d7155ebc6727351',
  },
  WALL: {
    ca: '0xB03058B8A39f3967DF08d833682C1c99b29821B1',
    tx: '0xee790e8e1c934dc927a53225854c1fba78a0e7c11a0743f3e9a1ff4b272ed845',
    from: '0x6a912148ec4ce6dc99c396a3424a477568edb46e',
    to: '0x432d20aae5605b1e94c914283d7155ebc6727351',
  },
  STRIKE: {
    ca: '0x5aeD379A72BD2533371d153135c47d5EB61BaBc8',
    tx: '0x722ff11632f289f94b6add4e36151650ea2ea493307ef99efc31352d768e37b0',
    from: '0x3238d679b3d18c88039e786e2e4d5afb41735f6f',
    to: '0xc6cc8979e6e4f74d2da3ff2e514ff3f336cb1e73',
  },
  YARD: {
    ca: '0xE3FA12dA7fa026B21817f16622E8AE48fA785166',
    tx: '0x97866b98485b94528bbe3752dc3e986af14f1d1c69386a4345d0fae3dcd46985',
    from: '0x04d870ff10ccba4b7ee7387e8e3189adac79bf83',
    to: '0x432d20aae5605b1e94c914283d7155ebc6727351',
  },
};

function mockProvider(receipt) {
  return {
    getTransaction: async () => ({
      hash: receipt.hash,
      from: receipt.from,
      to: receipt.to,
      data: '0x',
      value: 0n,
    }),
    getTransactionReceipt: async () => receipt,
  };
}

function makeReceipt(name, fixture) {
  const ca = normAddr(fixture.ca);
  if (name === 'DERP') {
    return {
      hash: fixture.tx,
      from: fixture.from,
      to: fixture.to,
      contractAddress: ca,
      logs: [{
        address: ca,
        topics: [
          ethers.id('Transfer(address,address,uint256)'),
          ethers.zeroPadValue('0x00', 32),
          ethers.zeroPadValue(fixture.from, 32),
        ],
        index: 9,
      }],
    };
  }
  return {
    hash: fixture.tx,
    from: fixture.from,
    to: fixture.to,
    contractAddress: null,
    logs: [{
      address: ca,
      topics: [
        ethers.id('Transfer(address,address,uint256)'),
        ethers.zeroPadValue('0x00', 32),
        ethers.zeroPadValue(fixture.to || fixture.from, 32),
      ],
      index: name === 'MANCER' ? 40 : 9,
    }],
  };
}

const settings = { chainWatchlist: defaultChainWatchlist() };
const watch = enabledWatchSet(settings);
const weth = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

for (const [name, fixture] of Object.entries(FIXTURES)) {
  test('historical detector ' + name + ' PASS', async () => {
    const receipt = makeReceipt(name, fixture);
    const tx = {
      hash: fixture.tx,
      from: fixture.from,
      to: fixture.to,
    };
    assert.equal(txTouchesWatch(tx, watch), true, 'watch match');
    assert.ok(matchedWatchSide(tx, watch), 'matched side');
    const extracted = extractCandidatesFromReceipt(receipt, { excludeAddresses: new Set([weth]) });
    const hit = extracted.find((c) => c.contract.toLowerCase() === normAddr(fixture.ca).toLowerCase());
    assert.ok(hit, 'extracted CA must match');
  });
}
