/**
 * routes/constants.js — verified Robinhood Chain routing addresses (4663).
 *
 * Sourced from on-chain verification + Uniswap docs deployment table.
 * Do not add addresses here without independent proof.
 */
import 'dotenv/config';

/** EIP-1967 implementation slot (TransparentUpgradeableProxy). */
export const EIP1967_IMPL_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/** Robinhood aggregator proxy — stable public entrypoint. */
export const AGGREGATOR_PROXY = (
  process.env.AGGREGATOR_PROXY || '0x65050A9b7E5075A2bA5cED7b1b64EE66262c40Dc'
).toLowerCase();

/** Implementation validated against swap() calldata decode (2026-08-17). */
export const AGGREGATOR_EXPECTED_IMPL = (
  process.env.AGGREGATOR_EXPECTED_IMPL || '0xb70DA7425Bc26A6aFd60d080148248389a9073bF'
).toLowerCase();

/** Observed fee collector (from live txs — log only, not execution dependency). */
export const AGGREGATOR_FEE_COLLECTOR = '0xb8159ba378904f803639d274cec79f788931c9c8';

/** Default effective aggregator fee if on-chain read unavailable (1.00%). */
export const AGGREGATOR_DEFAULT_FEE_BPS = Number(process.env.AGGREGATOR_FEE_BPS || '100');

export const WETH = (process.env.WETH_ADDRESS || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73').toLowerCase();
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

export const UNI_V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
export const UNI_V3_QUOTER_V2 = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';
export const UNI_V3_TICK_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

export const V4_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

/** Proven swapType enum values only — do not invent others. */
export const SWAP_TYPE = Object.freeze({
  V3: 1,
  V4: 2,
  UP_V3: 12,
});

/** Bounded bridge assets for route search (narrow CLOCKIN objective). */
export const BRIDGE_ASSETS = [WETH, USDG];

export const V3_FEE_TIERS = [100, 500, 3000, 10000];

/** STRIKE launcher — detection only until buy ABI verified. */
export const STRIKE_LAUNCHER = '0xc6cc8979e6e4f74d2da3ff2e514ff3f336cb1e73';

export const AGGREGATOR_SWAP_ABI = [
  'function swap((uint8 swapType,address tokenIn,address tokenOut,address poolAddress,uint24 fee,int24 tickSpacing,address hooks,bytes hookData,address poolManager,bytes32 parameters)[] descs, address feeToken, uint256 amountIn, uint256 minReturn, uint256 deadline) payable',
];

export const V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function liquidity() view returns (uint128)',
];

export const V3_FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)'];

export const V3_QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) view returns (uint256 amountOut,uint160,uint32,uint256)',
];
