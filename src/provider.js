/**
 * provider.js — HTTP failover facade + WSS factory.
 *
 * Backward compatible: ALCHEMY_URL / ALCHEMY_KEY / RPC_URL / ALCHEMY_WSS_URL
 * still work. Prefer RPC_HTTP_* and RPC_WSS_* when available.
 */
import {
  makeFailoverProvider,
  makeWssProvider,
  wssConfigured,
  listHttpEndpoints,
  listWssEndpoints,
} from './rpcpool.js';

export function makeProvider() {
  return makeFailoverProvider();
}

/**
 * WebSocket provider for chain scanner block subscriptions only.
 * HTTP makeProvider() remains for quotes, reads, and tx broadcast.
 */
export function makeEventProvider() {
  return makeWssProvider();
}

export function wssUrlConfigured() {
  return wssConfigured();
}

export { listHttpEndpoints, listWssEndpoints, wssConfigured };
