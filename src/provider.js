import { ethers } from 'ethers';

// Prefer Alchemy if configured (lower latency = a real edge on a fast L2),
// else fall back to the public RPC.
export function makeProvider() {
  const { ALCHEMY_URL, ALCHEMY_KEY, RPC_URL, CHAIN_ID } = process.env;
  let url;
  if (ALCHEMY_URL && ALCHEMY_URL.startsWith('http')) {
    url = ALCHEMY_URL;
  } else if (ALCHEMY_KEY) {
    // Best-effort mainnet host guess. If this 401s/404s, paste the exact
    // endpoint URL from your Alchemy app into ALCHEMY_URL instead.
    url = `https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
  } else {
    url = RPC_URL;
  }
  const net = CHAIN_ID ? { chainId: Number(CHAIN_ID), name: 'robinhood' } : undefined;
  // staticNetwork avoids an extra round-trip per call.
  return new ethers.JsonRpcProvider(url, net, { staticNetwork: true });
}

/**
 * WebSocket provider for chain scanner block subscriptions only.
 * HTTP makeProvider() remains for quotes, reads, and tx broadcast.
 */
export function makeEventProvider() {
  const { ALCHEMY_WSS_URL, ALCHEMY_KEY, CHAIN_ID } = process.env;
  let url = ALCHEMY_WSS_URL?.trim();
  if (!url && ALCHEMY_KEY) {
    url = `wss://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
  }
  if (!url || !url.startsWith('ws')) return null;
  const net = CHAIN_ID ? { chainId: Number(CHAIN_ID), name: 'robinhood' } : undefined;
  return new ethers.WebSocketProvider(url, net, { staticNetwork: true });
}
