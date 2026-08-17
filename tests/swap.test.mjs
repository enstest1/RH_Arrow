import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  buildPoolKey, encodeV4Swap, UNIVERSAL_ROUTER, WETH, NATIVE,
  ROBINHOOD_CHAIN_ID, CMD_V4_SWAP, ACTION_SWAP_EXACT_IN_SINGLE, UNIVERSAL_ROUTER_ABI,
} from '../src/swap.js';
import { extractCA } from '../src/autobuy.js';

const TOKEN = '0x45242320dbb855eea8fd36804c6487e10e97fcf9';

test('Robinhood Chain constants match the verified deployment', () => {
  assert.equal(ROBINHOOD_CHAIN_ID, 4663);
  assert.equal(UNIVERSAL_ROUTER, '0x8876789976decbfcbbbe364623c63652db8c0904');
  assert.equal(WETH, '0x0bd7d308f8e1639fab988df18a8011f41eacad73');
  assert.ok(ethers.isAddress(UNIVERSAL_ROUTER));
  assert.ok(ethers.isAddress(WETH));
});

test('pool key sorts currencies canonically and sets direction', () => {
  const { poolKey, zeroForOne } = buildPoolKey(TOKEN, 10000);
  assert.ok(poolKey.currency0 < poolKey.currency1, 'currency0 must sort first');
  assert.equal(poolKey.currency0, NATIVE, 'native ETH (0x0) sorts before any token');
  assert.equal(zeroForOne, true, 'ETH→token is zeroForOne when ETH is currency0');
  assert.equal(poolKey.tickSpacing, 200, '1% tier → 200 spacing');
});

test('tick spacing follows Uniswap convention', () => {
  assert.equal(buildPoolKey(TOKEN, 500).poolKey.tickSpacing, 10);
  assert.equal(buildPoolKey(TOKEN, 3000).poolKey.tickSpacing, 60);
  assert.equal(buildPoolKey(TOKEN, 10000).poolKey.tickSpacing, 200);
});

test('swap encodes as V4_SWAP with swap+settle+take actions', () => {
  const { poolKey, zeroForOne } = buildPoolKey(TOKEN, 10000);
  const { commands, inputs } = encodeV4Swap({ poolKey, zeroForOne, amountIn: 10n ** 16n, amountOutMin: 1n });
  assert.equal(commands, '0x10');
  assert.equal(CMD_V4_SWAP, 0x10);
  assert.equal(inputs.length, 1);

  const [actions, params] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes', 'bytes[]'], inputs[0]);
  assert.equal(params.length, 3, 'swap + settle + take');
  assert.equal(actions.slice(0, 4), '0x' + ACTION_SWAP_EXACT_IN_SINGLE.toString(16).padStart(2, '0'));
});

test('the call encodes and decodes against the real Universal Router ABI', () => {
  const { poolKey, zeroForOne } = buildPoolKey(TOKEN, 10000);
  const { commands, inputs } = encodeV4Swap({ poolKey, zeroForOne, amountIn: 10n ** 16n, amountOutMin: 5n });
  const iface = new ethers.Interface(UNIVERSAL_ROUTER_ABI);
  const data = iface.encodeFunctionData('execute', [commands, inputs, 1800000000n]);
  const decoded = iface.decodeFunctionData('execute', data);
  assert.equal(decoded[0], commands);
  assert.equal(decoded[2], 1800000000n);
});

test('CA extraction pulls an EVM address out of tweet text', () => {
  assert.equal(extractCA('new coin ' + TOKEN + ' send it'), TOKEN);
  assert.equal(extractCA('CA: ' + TOKEN.toUpperCase().replace('0X', '0x')), TOKEN.toUpperCase().replace('0X', '0x'));
  assert.equal(extractCA('gm no address here'), null);
  assert.equal(extractCA(''), null);
  assert.equal(extractCA('0xshort'), null, 'partial addresses must not match');
});
