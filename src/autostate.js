/**
 * autostate.js — local persistence for auto-buy.
 *
 * Migrates older autobuy-state.json files forward without requiring deletion.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultChainWatchlist } from './chainwatchlist.js';

const FILE = process.env.AUTOBUY_STATE_PATH || path.resolve(process.cwd(), 'autobuy-state.json');

const BLANK = {
  settings: {
    enabled: false,
    maxSpendEth: '',
    slippageTolerancePct: '',
    xEnabled: true,
    handles: [],
    chainEnabled: true,
    targetSymbol: process.env.TARGET_SYMBOL || 'CLOCKIN',
    chainWatchlist: defaultChainWatchlist(),
    maxLaunchTaxPct: '',
  },
  buys: {},
  seenTweets: {},
  seenChainEvents: {},
  seenCandidates: {},
  pendingCandidates: {},
  lastProcessedBlock: null,
};

function mergeWatchlist(saved) {
  if (Array.isArray(saved) && saved.length) return saved;
  return defaultChainWatchlist();
}

function read() {
  try {
    if (!fs.existsSync(FILE)) return structuredClone(BLANK);
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      settings: {
        ...BLANK.settings,
        ...(parsed.settings || {}),
        chainWatchlist: mergeWatchlist(parsed.settings?.chainWatchlist),
      },
      buys: parsed.buys || {},
      seenTweets: parsed.seenTweets || {},
      seenChainEvents: parsed.seenChainEvents || {},
      seenCandidates: parsed.seenCandidates || {},
      pendingCandidates: parsed.pendingCandidates || {},
      lastProcessedBlock: parsed.lastProcessedBlock ?? null,
    };
  } catch {
    return structuredClone(BLANK);
  }
}

function write(state) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

let cache = read();

export const getSettings = () => ({ ...cache.settings, chainWatchlist: [...(cache.settings.chainWatchlist || [])] });

export function saveSettings(patch) {
  cache.settings = { ...cache.settings, ...patch };
  if (patch.chainWatchlist) cache.settings.chainWatchlist = patch.chainWatchlist;
  write(cache);
  return getSettings();
}

export const alreadyBought = (contract) => Boolean(cache.buys[String(contract).toLowerCase()]);

export function recordBuy(contract, info) {
  cache.buys[String(contract).toLowerCase()] = { at: Date.now(), ...info };
  write(cache);
}

export function listBuys(limit = 25) {
  return Object.entries(cache.buys)
    .map(([contract, b]) => ({ contract, ...b }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

export const seenTweet = (id) => Boolean(cache.seenTweets[String(id)]);

export function markTweet(id) {
  cache.seenTweets[String(id)] = Date.now();
  pruneOld(cache.seenTweets);
  write(cache);
}

/** Stable chain event key: txHash:logIndex */
export function chainEventKey(txHash, logIndex = -1) {
  return String(txHash).toLowerCase() + ':' + String(logIndex ?? -1);
}

export const seenChainEvent = (key) => Boolean(cache.seenChainEvents[String(key)]);

export function markChainEvent(key) {
  cache.seenChainEvents[String(key)] = Date.now();
  pruneOld(cache.seenChainEvents, 24 * 60 * 60 * 1000);
  write(cache);
}

export const seenCandidate = (contract) => Boolean(cache.seenCandidates[String(contract).toLowerCase()]);

export function markCandidate(contract) {
  cache.seenCandidates[String(contract).toLowerCase()] = Date.now();
  write(cache);
}

export function getPendingCandidate(contract) {
  return cache.pendingCandidates[String(contract).toLowerCase()] || null;
}

export function setPendingCandidate(contract, info) {
  cache.pendingCandidates[String(contract).toLowerCase()] = { ...info, updatedAt: Date.now() };
  write(cache);
}

export function clearPendingCandidate(contract) {
  delete cache.pendingCandidates[String(contract).toLowerCase()];
  write(cache);
}

export function getLastProcessedBlock() {
  return cache.lastProcessedBlock;
}

export function setLastProcessedBlock(n) {
  cache.lastProcessedBlock = n;
  write(cache);
}

function pruneOld(map, maxAgeMs = 6 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [k, at] of Object.entries(map)) {
    if (at < cutoff) delete map[k];
  }
}

export function totalSpentEth() {
  const wei = Object.values(cache.buys).reduce((s, b) => s + BigInt(b.spendWei || 0), 0n);
  return Number(wei) / 1e18;
}

export function reload() {
  cache = read();
  return cache;
}

export { FILE as STATE_FILE };
