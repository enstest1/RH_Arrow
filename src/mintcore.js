// Shared claim logic used by both the CLI (mint.js) and the UI server.
import { ethers } from 'ethers';
import { ABI, NATIVE_CURRENCY, EMPTY_PROOF } from './abi.js';

export async function readActive(c) {
  const id = await c.getActiveClaimConditionId();
  const cond = await c.getClaimConditionById(id);
  return { id, cond };
}

export function buildClaim(cond, receiver, qty) {
  const hasAllowlist = cond.merkleRoot && cond.merkleRoot !== ethers.ZeroHash;
  const allowlistProof = { proof: EMPTY_PROOF, quantityLimitPerWallet: 0n,
    pricePerToken: cond.pricePerToken, currency: cond.currency };
  const native = BigInt(cond.currency) === BigInt(NATIVE_CURRENCY);
  const value = native ? BigInt(cond.pricePerToken) * qty : 0n;
  const args = [receiver, qty, cond.currency, cond.pricePerToken, allowlistProof, '0x'];
  return { args, value, hasAllowlist };
}

export async function computeGas(provider, { to, data, value, from }, maxGasUsd, ethUsd, gasLimitOverride) {
  let gasLimit = gasLimitOverride ? BigInt(gasLimitOverride) : null;
  if (!gasLimit) {
    const est = await provider.estimateGas({ to, data, value, from });
    gasLimit = (est * 130n) / 100n;
  }
  const fee = await provider.getFeeData();
  const suggested = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits('0.1','gwei');
  let maxFeePerGas = suggested * 2n;
  const capWei = ethers.parseEther((Number(maxGasUsd)/Number(ethUsd)).toFixed(18)) / gasLimit;
  if (maxFeePerGas > capWei) maxFeePerGas = capWei;
  let priority = ethers.parseUnits('0.01','gwei'); if (priority > maxFeePerGas) priority = maxFeePerGas;
  return { gasLimit, maxFeePerGas, priority };
}
