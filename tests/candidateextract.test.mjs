import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  extractDirectDeploy,
  extractMintFromZeroLogs,
  extractCandidatesFromReceipt,
  txTouchesWatch,
} from '../src/candidateextract.js';

test('direct deploy extraction from receipt.contractAddress', () => {
  const receipt = {
    hash: '0xabc',
    contractAddress: '0x6543b7746Ca744C4bb2198191E71F40fF04C41B9',
    logs: [],
  };
  const out = extractDirectDeploy(receipt);
  assert.equal(out.length, 1);
  assert.equal(out[0].method, 'receipt.contractAddress');
  assert.equal(out[0].contract.toLowerCase(), '0x6543b7746ca744c4bb2198191e71f40ff04c41b9');
});

test('mint-from-zero Transfer log extraction', () => {
  const token = '0xE3FA12dA7fa026B21817f16622E8AE48fA785166';
  const zero = ethers.zeroPadValue('0x00', 32);
  const to = ethers.zeroPadValue('0x04d870ff10ccba4b7ee7387e8e3189adac79bf83', 32);
  const receipt = {
    hash: '0xdef',
    logs: [{
      address: token,
      topics: [
        ethers.id('Transfer(address,address,uint256)'),
        zero,
        to,
      ],
      index: 3,
    }],
  };
  const out = extractMintFromZeroLogs(receipt);
  assert.equal(out.length, 1);
  assert.equal(out[0].method, 'Transfer-from-zero');
  assert.equal(out[0].logIndex, 3);
});

test('merge extraction dedupes by contract', () => {
  const addr = '0x6543b7746Ca744C4bb2198191E71F40fF04C41B9';
  const receipt = { hash: '0x1', contractAddress: addr, logs: [] };
  const out = extractCandidatesFromReceipt(receipt);
  assert.equal(out.length, 1);
});

test('txTouchesWatch matches from and to', () => {
  const watch = new Set(['0x432d20aae5605b1e94c914283d7155ebc6727351']);
  assert.equal(txTouchesWatch({ from: '0x432d20aae5605b1e94c914283d7155ebc6727351', to: '0x1' }, watch), true);
  assert.equal(txTouchesWatch({ from: '0x2', to: '0x432d20aae5605b1e94c914283d7155ebc6727351' }, watch), true);
  assert.equal(txTouchesWatch({ from: '0x2', to: '0x3' }, watch), false);
});
