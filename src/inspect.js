import 'dotenv/config';
import { ethers } from 'ethers';
import { makeProvider } from './provider.js';
import { ABI } from './abi.js';

// thirdweb DropERC721 preflight. Run: npm run inspect
const { CONTRACT_ADDRESS, PRIVATE_KEY } = process.env;
const provider = makeProvider();

const net = await provider.getNetwork();
console.log('chainId:', net.chainId.toString(), '(expect 4663)');
const code = await provider.getCode(CONTRACT_ADDRESS);
console.log(code === '0x' ? '❌ no contract at address' : '✅ contract present');

const c = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
const now = Math.floor(Date.now() / 1000);

async function safe(label, fn, fmt = (x)=>x.toString()) {
  try { const v = await fn(); console.log(label + ':', fmt(v)); return v; }
  catch (e) { console.log(label + ': (unreadable) ' + (e.shortMessage || e.code || e.message)); return null; }
}

await safe('name', () => c.name(), x=>x);
const total = await safe('totalSupply (minted so far)', () => c.totalSupply());

console.log('--- active claim phase ---');
const activeId = await safe('activeClaimConditionId', () => c.getActiveClaimConditionId());
if (activeId != null) {
  try {
    const cond = await c.getClaimConditionById(activeId);
    const price = cond.pricePerToken;
    const hasAllowlist = cond.merkleRoot && cond.merkleRoot !== ethers.ZeroHash;
    console.log('  startTimestamp   :', cond.startTimestamp.toString(),
                '(' + (Number(cond.startTimestamp) <= now ? 'STARTED' : ('in ' + (Number(cond.startTimestamp)-now) + 's')) + ')');
    console.log('  maxClaimable     :', cond.maxClaimableSupply.toString());
    console.log('  supplyClaimed    :', cond.supplyClaimed.toString());
    console.log('  remaining (phase):', (BigInt(cond.maxClaimableSupply) - BigInt(cond.supplyClaimed)).toString());
    console.log('  perWalletLimit   :', cond.quantityLimitPerWallet.toString());
    console.log('  pricePerToken    :', ethers.formatEther(price), 'ETH (' + price.toString() + ' wei)');
    console.log('  currency         :', cond.currency);
    console.log('  ALLOWLIST on this phase:', hasAllowlist ? 'YES — needs a merkle proof' : 'NO — public, empty proof works');
    if (hasAllowlist) {
      console.log('  ⚠️  This phase is allowlist-gated. An empty proof will REVERT.');
      console.log('     You must mint via the official site (it fetches your proof) or supply the proof.');
    }
  } catch (e) { console.log('  could not read active condition:', e.shortMessage || e.message); }
}

if (PRIVATE_KEY && !PRIVATE_KEY.includes('YOUR')) {
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log('--- your wallet ---');
  console.log('address:', wallet.address);
  console.log('balance:', ethers.formatEther(await provider.getBalance(wallet.address)), 'ETH');
  await safe('your NFT balance', () => c.balanceOf(wallet.address));
  if (activeId != null) await safe('you claimed this phase', () => c.getSupplyClaimedByWallet(activeId, wallet.address));
}
console.log('\nIf the active phase shows ALLOWLIST=NO and price/currency look right, the bot can claim it.');
