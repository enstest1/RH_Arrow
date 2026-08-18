/**
 * Bounded in-memory RPC used by local discovery tests.
 * Pool addresses are historically observed; no live calls, no broadcasts.
 */
import { ethers } from 'ethers';
import {
  AGGREGATOR_PROXY,
  AGGREGATOR_EXPECTED_IMPL,
  AGGREGATOR_SWAP_ABI,
  EIP1967_IMPL_SLOT,
  FEE_RATE_ABI,
  UNI_V3_FACTORY,
  UNI_V3_QUOTER_V2,
  UP_CL_FACTORY,
  V3_FACTORY_ABI,
  V3_POOL_ABI,
  V3_QUOTER_ABI,
  UP_CL_FACTORY_ABI,
  WETH,
  USDG,
  ZERO_ADDRESS,
} from '../../src/routes/constants.js';

export const MANCER = '0xc72f232a6869e6cf34dc06129affd07f8a2a246a';
export const MANCER_POOL = '0x543127d6a1932689faacc1afad4a81146d9ccf54';
export const STRIKE = '0x5aed379a72bd2533371d153135c47d5eb61babc8';
export const STRIKE_UPCL = '0x97cf6a6271ff5cabdf3a6698e218a47fb65a15d7';
export const WETH_USDG = '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca';

const coder = ethers.AbiCoder.defaultAbiCoder();
const v3FactoryIface = new ethers.Interface(V3_FACTORY_ABI);
const upFactoryIface = new ethers.Interface(UP_CL_FACTORY_ABI);
const poolIface = new ethers.Interface(V3_POOL_ABI);
const quoterIface = new ethers.Interface(V3_QUOTER_ABI);
const feeIface = new ethers.Interface(FEE_RATE_ABI);
const swapIface = new ethers.Interface(AGGREGATOR_SWAP_ABI);
const erc20Iface = new ethers.Interface([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
]);

function lc(a) {
  return String(a || '').toLowerCase();
}

function pairKey(a, b, extra) {
  return lc(a) + ':' + lc(b) + ':' + String(extra);
}

function encodeAddr(a) {
  return coder.encode(['address'], [a]);
}

function encodeUint(n) {
  return coder.encode(['uint256'], [n]);
}

function encodeQuote(amountOut) {
  return coder.encode(['uint256', 'uint160', 'uint32', 'uint256'], [amountOut, 0, 0, 0]);
}

/**
 * @param {{ impl?: string, simOk?: boolean, simOut?: bigint, v4Quoter?: string, v4Out?: bigint, tokenMeta?: Record<string, { symbol: string, name?: string, decimals?: number }> }} [opts]
 */
export function makeDiscoveryProvider(opts = {}) {
  const impl = lc(opts.impl || AGGREGATOR_EXPECTED_IMPL);
  const simOk = opts.simOk !== false;
  const simOut = opts.simOut ?? 10n ** 18n;
  const v4Quoter = opts.v4Quoter ? lc(opts.v4Quoter) : '';
  const v4Out = opts.v4Out ?? 0n;
  const tokenMeta = opts.tokenMeta || {};

  /** @type {Map<string, string>} */
  const v3 = new Map();
  /** @type {Map<string, string>} */
  const up = new Map();
  /** @type {Map<string, { token0: string, token1: string, fee: number, tickSpacing: number, liquidity: bigint }>} */
  const pools = new Map();

  function addV3(tokenA, tokenB, fee, pool, meta) {
    v3.set(pairKey(tokenA, tokenB, fee), lc(pool));
    v3.set(pairKey(tokenB, tokenA, fee), lc(pool));
    pools.set(lc(pool), meta);
  }

  function addUp(tokenA, tokenB, spacing, pool, meta) {
    up.set(pairKey(tokenA, tokenB, spacing), lc(pool));
    up.set(pairKey(tokenB, tokenA, spacing), lc(pool));
    pools.set(lc(pool), meta);
  }

  // Historical MANCER: WETH → token Uniswap V3 fee 10000
  addV3(WETH, MANCER, 10000, MANCER_POOL, {
    token0: WETH < MANCER ? WETH : MANCER,
    token1: WETH < MANCER ? MANCER : WETH,
    fee: 10000,
    tickSpacing: 200,
    liquidity: 1_000_000n,
  });

  // Historical STRIKE bridge: WETH → USDG (V3 fee 100) then USDG → STRIKE (Up CL 2000)
  addV3(WETH, USDG, 100, WETH_USDG, {
    token0: WETH < USDG ? WETH : USDG,
    token1: WETH < USDG ? USDG : WETH,
    fee: 100,
    tickSpacing: 1,
    liquidity: 1_000_000n,
  });
  addUp(USDG, STRIKE, 2000, STRIKE_UPCL, {
    token0: USDG < STRIKE ? USDG : STRIKE,
    token1: USDG < STRIKE ? STRIKE : USDG,
    fee: 10000,
    tickSpacing: 2000,
    liquidity: 1_000_000n,
  });

  async function call(tx) {
    const to = lc(tx.to);
    const data = tx.data || '0x';
    const sel = data.slice(0, 10);

    if (to === lc(AGGREGATOR_PROXY)) {
      if (sel === feeIface.getFunction('feeRate').selector) return encodeUint(100n);
      if (sel === swapIface.getFunction('swap').selector) {
        if (!simOk) {
          const err = new Error('execution reverted');
          err.shortMessage = 'execution reverted';
          throw err;
        }
        return encodeUint(simOut);
      }
    }

    if (to === lc(UNI_V3_FACTORY) && sel === v3FactoryIface.getFunction('getPool').selector) {
      const [a, b, fee] = v3FactoryIface.decodeFunctionData('getPool', data);
      return encodeAddr(v3.get(pairKey(a, b, Number(fee))) || ZERO_ADDRESS);
    }

    if (to === lc(UP_CL_FACTORY) && sel === upFactoryIface.getFunction('getPool').selector) {
      const [a, b, spacing] = upFactoryIface.decodeFunctionData('getPool', data);
      return encodeAddr(up.get(pairKey(a, b, Number(spacing))) || ZERO_ADDRESS);
    }

    if (to === lc(UNI_V3_QUOTER_V2) && sel === quoterIface.getFunction('quoteExactInputSingle').selector) {
      return encodeQuote(50_000n);
    }

    if (v4Quoter && to === v4Quoter) {
      if (v4Out > 0n) return coder.encode(['uint256', 'uint256'], [v4Out, 0]);
      const err = new Error('no v4 pool');
      err.shortMessage = 'no v4 pool';
      throw err;
    }

    const pool = pools.get(to);
    if (pool) {
      if (sel === poolIface.getFunction('token0').selector) return encodeAddr(pool.token0);
      if (sel === poolIface.getFunction('token1').selector) return encodeAddr(pool.token1);
      if (sel === poolIface.getFunction('fee').selector) return coder.encode(['uint24'], [pool.fee]);
      if (sel === poolIface.getFunction('tickSpacing').selector) return coder.encode(['int24'], [pool.tickSpacing]);
      if (sel === poolIface.getFunction('liquidity').selector) return coder.encode(['uint128'], [pool.liquidity]);
    }

    const meta = tokenMeta[to];
    if (meta) {
      if (sel === erc20Iface.getFunction('symbol').selector) return coder.encode(['string'], [meta.symbol]);
      if (sel === erc20Iface.getFunction('name').selector) return coder.encode(['string'], [meta.name || meta.symbol]);
      if (sel === erc20Iface.getFunction('decimals').selector) return coder.encode(['uint8'], [meta.decimals ?? 18]);
    }

    return '0x';
  }

  return {
    call,
    getStorage: async (address, slot) => {
      if (lc(address) === lc(AGGREGATOR_PROXY) && String(slot).toLowerCase() === EIP1967_IMPL_SLOT.toLowerCase()) {
        return '0x' + impl.replace(/^0x/, '').padStart(64, '0');
      }
      return ethers.ZeroHash;
    },
    getCode: async (address) => (lc(address) === ZERO_ADDRESS ? '0x' : '0x6080604052'),
    getNetwork: async () => ({ chainId: 4663n }),
    getBlockNumber: async () => 1,
    getBalance: async () => 10n ** 18n,
  };
}
