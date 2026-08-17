// Detect which mint pattern a contract uses.
// Strategy: (1) if a sample mint tx is given, read its logs/selector -> strong signal.
//           (2) else probe the contract for known view functions -> best-effort.
import { ethers } from 'ethers';
import { PATTERNS, EVENT_TOPIC_MAP, SELECTOR_MAP, patternById } from './patterns.js';

export async function detectFromTx(provider, txHash) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return null;
  // check event topics first (most reliable)
  for (const lg of receipt.logs) {
    const t0 = (lg.topics[0] || '').toLowerCase();
    if (EVENT_TOPIC_MAP[t0]) return { patternId: EVENT_TOPIC_MAP[t0], via: 'event', contract: lg.address };
  }
  // fall back to the tx input selector
  const tx = await provider.getTransaction(txHash);
  if (tx?.data && tx.data.length >= 10) {
    const sel = tx.data.slice(0,10).toLowerCase();
    if (SELECTOR_MAP[sel]) {
      // SeaDrop mintPublic tx targets SeaDrop — decode NFT address from calldata.
      if (SELECTOR_MAP[sel] === 'seadrop') {
        try {
          const iface = new ethers.Interface(['function mintPublic(address,address,address,uint256) payable']);
          const [nftContract] = iface.decodeFunctionData('mintPublic', tx.data);
          return { patternId: 'seadrop', via: 'selector', contract: nftContract };
        } catch {}
      }
      return { patternId: SELECTOR_MAP[sel], via: 'selector', contract: tx.to };
    }
  }
  return { patternId: null, via: 'unknown', contract: receipt.to };
}

export async function detectFromContract(provider, address) {
  // probe: does it answer thirdweb's getActiveClaimConditionId? then it's thirdweb.
  const probes = [
    { id: 'thirdweb-drop', abi: ['function getActiveClaimConditionId() view returns (uint256)'], call: c=>c.getActiveClaimConditionId() },
  ];
  for (const p of probes) {
    try { const c = new ethers.Contract(address, p.abi, provider); await c[Object.keys(c.interface.fragments.reduce((a,f)=>{a[f.name]=1;return a;},{}))[0]]?.(); }
    catch {}
  }
  // simpler explicit probe:
  try { const c = new ethers.Contract(address, ['function getActiveClaimConditionId() view returns (uint256)'], provider);
        await c.getActiveClaimConditionId(); return { patternId:'thirdweb-drop', via:'probe' }; } catch {}
  // OpenSea ERC721SeaDrop exposes getMintStats on the NFT contract.
  try {
    const c = new ethers.Contract(address, ['function getMintStats(address) view returns (uint256,uint256,uint256)'], provider);
    await c.getMintStats.staticCall(ethers.ZeroAddress);
    return { patternId: 'seadrop', via: 'probe' };
  } catch {}
  return { patternId: null, via: 'unknown' };
}

// Try to fetch a verified ABI from Blockscout (works only if the server's network allows it).
export async function tryFetchVerifiedAbi(address, chainId=4663) {
  const url = `https://api.blockscout.com/${chainId}/api/v2/smart-contracts/${address}`;
  try {
    const r = await fetch(url); if (!r.ok) return null;
    const j = await r.json();
    if (j.abi) return j.abi;
  } catch {}
  return null;
}
