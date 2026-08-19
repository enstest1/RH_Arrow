/**
 * rpcpool.js — multi-endpoint HTTP/WSS with cooldown. Never logs API keys.
 *
 * Official RH Chain (4663) public HTTP is always eligible as a secondary.
 * Sequencer feed wss://feed.mainnet.chain.robinhood.com is a Nitro feed, not
 * JSON-RPC eth_subscribe — do not use it with ethers WebSocketProvider.
 */
import { ethers } from 'ethers';

const CHAIN = { chainId: 4663, name: 'robinhood' };
const PUBLIC_HTTP = 'https://rpc.mainnet.chain.robinhood.com';
function requestTimeoutMs() {
  const n = Number(process.env.RPC_TIMEOUT_MS);
  if (Number.isFinite(n) && n > 0) return n;
  return 8000;
}

/** @type {((info: { reason: string, label: string }) => void) | null} */
let _onPressure = null;
let _httpPool = null;
let _facade = null;

export function onRpcPressure(fn) {
  _onPressure = fn;
}

export function sanitizeRpcUrl(url) {
  return String(url || '').replace(/\/v2\/[^/]+/g, '/v2/***').replace(/\/[A-Za-z0-9_-]{20,}$/g, '/***');
}

function is429(err) {
  const s = String(err?.info?.responseBody || err?.shortMessage || err?.message || err || '');
  return /429|capacity limit|Too Many Requests|rate.?limit/i.test(s);
}

function isRetryable(err) {
  const s = String(err?.shortMessage || err?.message || err || '');
  return is429(err) || /timeout|ECONNRESET|ETIMEDOUT|5\d\d|SERVER_ERROR|network/i.test(s);
}

function envUrl(name) {
  return String(process.env[name] || '').trim();
}

function alchemyHttpFromEnv() {
  const full = envUrl('ALCHEMY_URL');
  if (full.startsWith('http')) return full;
  const key = envUrl('ALCHEMY_KEY');
  if (key) return `https://robinhood-mainnet.g.alchemy.com/v2/${key}`;
  return '';
}

function alchemyWssFromEnv() {
  const full = envUrl('ALCHEMY_WSS_URL') || envUrl('RPC_WSS_PRIMARY');
  if (full.startsWith('ws')) return full;
  const key = envUrl('ALCHEMY_KEY');
  if (key) return `wss://robinhood-mainnet.g.alchemy.com/v2/${key}`;
  return '';
}

function labelFor(url, fallback) {
  const u = String(url || '').toLowerCase();
  if (u.includes('alchemy.com')) return fallback.startsWith('wss') ? 'alchemy-wss' : 'alchemy-http';
  if (u.includes('rpc.mainnet.chain.robinhood.com')) return 'public-rpc';
  if (u.includes('quiknode') || u.includes('quicknode')) return fallback.startsWith('wss') ? 'quicknode-wss' : 'quicknode-http';
  return fallback;
}

function uniqueUrls(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it?.url) continue;
    const key = it.url.replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function roleSuffix(i) {
  if (i === 0) return 'primary';
  if (i === 1) return 'secondary';
  return 'tertiary';
}

export function listHttpEndpoints() {
  const raw = [
    envUrl('RPC_HTTP_PRIMARY'),
    alchemyHttpFromEnv(),
    envUrl('RPC_URL'),
    envUrl('RPC_HTTP_SECONDARY'),
    envUrl('RPC_HTTP_TERTIARY'),
    PUBLIC_HTTP,
  ].filter((u) => u && u.startsWith('http'));
  const unique = uniqueUrls(raw.map((url) => ({ url, label: labelFor(url, 'http') })));
  return unique.map((e, i) => {
    const base = labelFor(e.url, 'http');
    const label = (base === 'public-rpc' && i > 0)
      ? 'public-rpc-fallback'
      : base + '-' + roleSuffix(i);
    return { url: e.url, label };
  });
}

export function listWssEndpoints() {
  const items = [
    { url: alchemyWssFromEnv(), label: 'wss-primary' },
    { url: envUrl('RPC_WSS_SECONDARY'), label: 'wss-secondary' },
    { url: envUrl('RPC_WSS_TERTIARY'), label: 'wss-tertiary' },
  ].filter((e) => e.url && e.url.startsWith('ws') && !e.url.includes('feed.mainnet.chain.robinhood.com'));
  return uniqueUrls(items).map((e, i) => ({
    url: e.url,
    label: labelFor(e.url, e.label) + '-' + roleSuffix(i),
  }));
}

function blankHealth(ep) {
  return {
    label: ep.label,
    urlSanitized: sanitizeRpcUrl(ep.url),
    type: ep.url.startsWith('ws') ? 'wss' : 'http',
    healthy: true,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    latencyMs: null,
    consecutiveFailures: 0,
    lastBlock: null,
    chainId: 4663,
    rateLimited: false,
    last429At: 0,
    cooldownUntil: 0,
    rateLimitCount: 0,
  };
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error('rpc_timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * Sequential HTTP failover with 429 cooldown. Overrides JsonRpcProvider.send.
 */
export class HttpRpcPool {
  /**
   * @param {{ url: string, label: string }[]} endpoints
   * @param {{ sendImpl?: Function, now?: () => number }} [opts]
   */
  constructor(endpoints, opts = {}) {
    this._now = opts.now || Date.now;
    this._sendImpl = opts.sendImpl || null;
    this.rateLimitCount = 0;
    this.last429At = 0;
    this.endpoints = endpoints.map((e) => ({
      url: e.url,
      ...blankHealth(e),
      _provider: opts.sendImpl ? null : new ethers.JsonRpcProvider(e.url, CHAIN, { staticNetwork: true }),
    }));
    this.activeLabel = this.endpoints[0]?.label || null;
  }

  snapshot() {
    return {
      activeHttpProvider: this.activeLabel,
      rateLimitCount: this.rateLimitCount,
      last429At: this.last429At,
      provider429: this.endpoints.some((e) => e.rateLimited && e.cooldownUntil > this._now()),
      endpoints: this.endpoints.map((e) => ({
        label: e.label,
        healthy: e.healthy,
        latencyMs: e.latencyMs,
        rateLimited: e.rateLimited,
        consecutiveFailures: e.consecutiveFailures,
        cooldownUntil: e.cooldownUntil,
      })),
    };
  }

  _fail(ep, err) {
    ep.consecutiveFailures += 1;
    ep.healthy = false;
    ep.lastFailureAt = this._now();
    const retryable = isRetryable(err);
    if (is429(err)) {
      ep.rateLimited = true;
      ep.last429At = this._now();
      ep.rateLimitCount += 1;
      this.rateLimitCount += 1;
      this.last429At = this._now();
      const cool = Math.min(60_000, 5000 * (2 ** Math.min(4, ep.consecutiveFailures)));
      ep.cooldownUntil = this._now() + cool;
      if (_onPressure) _onPressure({ reason: '429', label: ep.label });
    } else if (retryable) {
      // Timeout/reset cooldown must exceed request timeout or every call re-hits a dead primary.
      ep.cooldownUntil = this._now() + Math.max(10_000, requestTimeoutMs());
    } else {
      ep.cooldownUntil = this._now() + 5000;
    }
  }

  async send(method, params) {
    const now = this._now();
    const ready = this.endpoints.filter((e) => e.cooldownUntil <= now)
      .sort((a, b) => {
        if (a.label === this.activeLabel) return -1;
        if (b.label === this.activeLabel) return 1;
        return (b.lastSuccessAt || 0) - (a.lastSuccessAt || 0);
      });
    const ordered = ready.length ? ready : [...this.endpoints];
    let lastErr;
    for (const ep of ordered) {
      const t0 = this._now();
      try {
        const result = this._sendImpl
          ? await withTimeout(this._sendImpl(ep, method, params), requestTimeoutMs())
          : await withTimeout(ep._provider.send(method, params), requestTimeoutMs());
        ep.consecutiveFailures = 0;
        ep.healthy = true;
        ep.rateLimited = false;
        ep.lastSuccessAt = this._now();
        ep.latencyMs = this._now() - t0;
        if (method === 'eth_blockNumber' && result != null) {
          const n = Number(result);
          if (Number.isFinite(n)) ep.lastBlock = n;
        }
        if (this.activeLabel !== ep.label && this.activeLabel) {
          // One-line failover notice — no URL/secrets.
          console.log('[RPC] switched HTTP to ' + ep.label);
        }
        this.activeLabel = ep.label;
        return result;
      } catch (e) {
        lastErr = e;
        this._fail(ep, e);
        if (is429(e)) console.log('[RPC] ' + ep.label + ' rate-limited — switching to secondary');
      }
    }
    throw lastErr || new Error('no_http_provider');
  }
}

export function getHttpPool() {
  if (!_httpPool) _httpPool = new HttpRpcPool(listHttpEndpoints());
  return _httpPool;
}

/** Existing pool or null — status reads must not construct providers. */
export function peekHttpPool() {
  return _httpPool;
}

export function resetRpcPoolForTest() {
  _httpPool = null;
  _facade = null;
}

export function makeFailoverProvider() {
  if (_facade) return _facade;
  const pool = getHttpPool();
  const first = pool.endpoints[0];
  if (!first) throw new Error('no HTTP RPC configured');
  const p = new ethers.JsonRpcProvider(first.url, CHAIN, { staticNetwork: true });
  p.send = (method, params) => pool.send(method, params);
  _facade = p;
  return p;
}

let _wssIndex = 0;

export function peekWssEndpoint() {
  const list = listWssEndpoints();
  if (!list.length) return null;
  return list[_wssIndex % list.length];
}

export function rotateWssEndpoint() {
  const list = listWssEndpoints();
  if (list.length < 2) return peekWssEndpoint();
  _wssIndex = (_wssIndex + 1) % list.length;
  return list[_wssIndex];
}

export function resetWssIndexForTest() {
  _wssIndex = 0;
}

export function makeWssProvider() {
  const ep = peekWssEndpoint();
  if (!ep) return null;
  const ws = new ethers.WebSocketProvider(ep.url, CHAIN, { staticNetwork: true });
  ws._rhLabel = ep.label;
  // Alchemy may 429 the handshake; unhandled 'error' would crash the process.
  ws.on('error', () => {});
  try { ws.websocket?.on?.('error', () => {}); } catch { /* ignore */ }
  return ws;
}

export function wssConfigured() {
  return listWssEndpoints().length > 0;
}

export { PUBLIC_HTTP, CHAIN, is429, isRetryable };
