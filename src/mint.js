import 'dotenv/config';
import { ethers } from 'ethers';
import { makeProvider } from './provider.js';
import { ABI, NATIVE_CURRENCY, EMPTY_PROOF } from './abi.js';

const DRY = process.argv.includes('--dry-run');
const {
  PRIVATE_KEY, CONTRACT_ADDRESS, MINT_QUANTITY,
  MAX_GAS_USD, ETH_USD, GAS_LIMIT, MINT_AT, WAIT_FOR_ONCHAIN, POLL_MS,
} = process.env;

const die = m => { console.error('❌ ' + m); process.exit(1); };
if (!PRIVATE_KEY || PRIVATE_KEY.includes('YOUR')) die('Set PRIVATE_KEY in .env');

const provider = makeProvider();
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const c = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
const qty = BigInt(MINT_QUANTITY || '1');
const ethUsd = Number(ETH_USD || '0'), maxGasUsd = Number(MAX_GAS_USD || '0');
if (!ethUsd || !maxGasUsd) die('Set ETH_USD and MAX_GAS_USD');
const pollMs = Number(POLL_MS || '80');

// Read the active claim condition to get the REAL price + currency. Never hardcode.
async function activeCondition() {
  const id = await c.getActiveClaimConditionId();
  const cond = await c.getClaimConditionById(id);
  return { id, cond };
}

function buildClaimArgs(cond) {
  const hasAllowlist = cond.merkleRoot && cond.merkleRoot !== ethers.ZeroHash;
  // Empty (public) proof — thirdweb's canonical sentinel. Reverts if phase is gated.
  const allowlistProof = {
    proof: EMPTY_PROOF,
    quantityLimitPerWallet: 0n,
    pricePerToken: cond.pricePerToken,   // must match the condition
    currency: cond.currency,
  };
  const value = BigInt(cond.currency).toString().toLowerCase() ===
                BigInt(NATIVE_CURRENCY).toString().toLowerCase()
                ? BigInt(cond.pricePerToken) * qty : 0n;
  const args = [wallet.address, qty, cond.currency, cond.pricePerToken, allowlistProof, '0x'];
  return { args, value, hasAllowlist };
}

async function computeGas(data, value) {
  let gasLimit = GAS_LIMIT ? BigInt(GAS_LIMIT) : null;
  if (!gasLimit) {
    try { gasLimit = ((await provider.estimateGas({ to: CONTRACT_ADDRESS, data, value, from: wallet.address })) * 130n) / 100n; }
    catch (e) { die(`claim would revert: ${e.shortMessage || e.message}\nLikely: phase not open, allowlist-gated (empty proof rejected), wrong price, or per-wallet limit hit.\nSet GAS_LIMIT in .env to bypass estimation and try anyway.`); }
  }
  const fee = await provider.getFeeData();
  const suggested = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits('0.1','gwei');
  let maxFeePerGas = suggested * 2n;
  const capWei = ethers.parseEther((maxGasUsd/ethUsd).toFixed(18)) / gasLimit;
  if (maxFeePerGas > capWei) maxFeePerGas = capWei;
  let priority = ethers.parseUnits('0.01','gwei'); if (priority > maxFeePerGas) priority = maxFeePerGas;
  return { gasLimit, maxFeePerGas, priority };
}

async function phaseOpen(cond) {
  return Number(cond.startTimestamp) <= Math.floor(Date.now()/1000);
}

const net = await provider.getNetwork();
console.log('chainId:', net.chainId.toString(), '| wallet:', wallet.address);
console.log('balance:', ethers.formatEther(await provider.getBalance(wallet.address)), 'ETH');

let { id, cond } = await activeCondition();
let { args, value, hasAllowlist } = buildClaimArgs(cond);
console.log('--- active phase', id.toString(), '---');
console.log('price/token:', ethers.formatEther(cond.pricePerToken), 'ETH | currency:', cond.currency);
console.log('phase remaining:', (BigInt(cond.maxClaimableSupply)-BigInt(cond.supplyClaimed)).toString());
console.log('allowlist:', hasAllowlist ? 'YES (empty proof will revert — need official proof)' : 'NO (public)');
console.log('claim value to send:', ethers.formatEther(value), 'ETH for qty', qty.toString());

const data = c.interface.encodeFunctionData('claim', args);
const { gasLimit, maxFeePerGas, priority } = await computeGas(data, value);
const estEth = Number(ethers.formatEther(maxFeePerGas * gasLimit));
console.log(`gas: ~$${(estEth*ethUsd).toFixed(2)} (cap $${maxGasUsd})`);

if (DRY) { console.log('\n✅ Dry run — claim encodes & estimates OK. Nothing sent.'); process.exit(0); }

// pre-sign for speed
const nonce = await provider.getTransactionCount(wallet.address, 'pending');
const signed = await wallet.signTransaction({ to: CONTRACT_ADDRESS, data, value, gasLimit, nonce, type: 2,
  maxFeePerGas, maxPriorityFeePerGas: priority, chainId: net.chainId });
console.log('✍️  pre-signed (nonce ' + nonce + '), waiting for phase to open...');

if (WAIT_FOR_ONCHAIN === 'true') {
  while (!(await phaseOpen(cond))) { await new Promise(r=>setTimeout(r, pollMs)); ({ cond } = await activeCondition()); }
  console.log('✅ phase open');
} else if (MINT_AT) {
  const t = new Date(MINT_AT).getTime(); if (Number.isNaN(t)) die('MINT_AT invalid');
  while (Date.now() < t) await new Promise(r=>setTimeout(r, 10));
}

console.log('🚀 broadcasting claim...');
try {
  const resp = await provider.broadcastTransaction(signed);
  console.log('tx:', resp.hash);
  const r = await resp.wait();
  console.log(r.status === 1 ? '✅ CLAIM CONFIRMED block '+r.blockNumber : '❌ REVERTED block '+r.blockNumber);
} catch (e) { die('broadcast failed: ' + (e.shortMessage || e.message)); }
