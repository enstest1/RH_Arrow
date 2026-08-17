/**
 * autostate.js — local persistence for auto-buy.
 *
 * Written to autobuy-state.json next to the project (override with
 * AUTOBUY_STATE_PATH). No database, no volume — this is a standalone tool.
 *
 * Holds: settings entered in the UI, contracts already bought, and the tweets
 * already acted on. Settings persist so a restart doesn't silently drop your
 * spend limits back to blank mid-session.
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.AUTOBUY_STATE_PATH || path.resolve(process.cwd(), 'autobuy-state.json');

const BLANK = {
  settings: {
    enabled: false,
    maxSpendEth: '',            // deliberately blank — user must set it
    slippageTolerancePct: '',
    handles: [],
  },
  buys: {},                     // contract → { at, txHash, spendWei, symbol, handle }
  seenTweets: {},               // tweetId → at
};

function read() {
  try {
    if (!fs.existsSync(FILE)) return structuredClone(BLANK);
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      settings: { ...BLANK.settings, ...(parsed.settings || {}) },
      buys: parsed.buys || {},
      seenTweets: parsed.seenTweets || {},
    };
  } catch {
    return structuredClone(BLANK);
  }
}

function write(state) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);     // atomic — a crash mid-write can't corrupt it
}

let cache = read();

export const getSettings = () => ({ ...cache.settings });

export function saveSettings(patch) {
  cache.settings = { ...cache.settings, ...patch };
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
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [k, at] of Object.entries(cache.seenTweets)) {
    if (at < cutoff) delete cache.seenTweets[k];
  }
  write(cache);
}

/** Total ETH spent, for the UI. */
export function totalSpentEth() {
  const wei = Object.values(cache.buys).reduce((s, b) => s + BigInt(b.spendWei || 0), 0n);
  return Number(wei) / 1e18;
}

export function reload() {
  cache = read();
  return cache;
}

export { FILE as STATE_FILE };
