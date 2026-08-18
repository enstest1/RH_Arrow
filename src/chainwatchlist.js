/**
 * chainwatchlist.js — default historical launch fingerprints + address helpers.
 *
 * These are OBSERVED historical deployment paths — not guaranteed universal
 * factories. Labels describe what we saw on-chain, not official protocol names.
 */
import { ethers } from 'ethers';

/** @typedef {{ address: string, role: string, label: string, enabled: boolean }} WatchEntry */

/** Normalize to checksummed address; returns null on invalid input. */
export function normAddr(a) {
  try {
    const s = String(a).trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(s)) return null;
    return ethers.getAddress(s.toLowerCase());
  } catch {
    return null;
  }
}

/** Case-insensitive address equality. */
export function addrEq(a, b) {
  const x = normAddr(a);
  const y = normAddr(b);
  return x && y ? x.toLowerCase() === y.toLowerCase() : false;
}

/**
 * Seed watch list from historical Stonkbrokers-style launches.
 * Authoritative copy lives in autobuy-state.json once saved from UI.
 */
export function defaultChainWatchlist() {
  return [
    {
      address: '0x4Be25231574464E58c593BC3001b4BdEE37954A6',
      role: 'direct-deployer-eoa',
      label: 'DERP historical deployer',
      enabled: true,
    },
    {
      address: '0x662003BF6049e36b4E887D47b8df8718fFBbc6C2',
      role: 'creator-contract',
      label: 'Secondary fingerprint (not MANCER/WALL launch tx.from/to)',
      enabled: true,
    },
    {
      address: '0xc6cc8979e6e4f74d2da3ff2e514ff3f336cb1e73',
      role: 'launcher-contract',
      label: 'STRIKE launcher',
      enabled: true,
    },
    {
      address: '0x3238d679b3d18c88039e786e2e4d5afb41735f6f',
      role: 'launch-caller-eoa',
      label: 'STRIKE launch caller',
      enabled: true,
    },
    {
      address: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
      role: 'observed-parent-contract',
      label: 'Secondary fingerprint (not STRIKE launch tx.from/to)',
      enabled: true,
    },
    {
      address: '0x432d20aae5605b1e94c914283d7155ebc6727351',
      role: 'amm-factory-v2',
      label: 'MANCER/WALL/YARD AMMFactoryV2 (live launch match)',
      enabled: true,
    },
    {
      address: '0x04d870ff10ccba4b7ee7387e8e3189adac79bf83',
      role: 'launch-caller-eoa',
      label: 'YARD launch caller',
      enabled: true,
    },
    {
      address: '0xb668382cf44038a3e8140e789060f6a809787cda',
      role: 'factory-deployer-eoa',
      label: 'AMMFactoryV2 deployer',
      enabled: true,
    },
  ].map((e) => ({ ...e, address: normAddr(e.address) }));
}

/** Build lowercase Set of enabled watched addresses for fast block scans. */
export function enabledWatchSet(settings) {
  const list = settings?.chainWatchlist || [];
  const s = new Set();
  for (const e of list) {
    if (!e?.enabled) continue;
    const a = normAddr(e.address);
    if (a) s.add(a.toLowerCase());
  }
  return s;
}

/** Find watch entry matching an address (enabled only). */
export function findWatchEntry(settings, address) {
  const target = normAddr(address);
  if (!target) return null;
  const list = settings?.chainWatchlist || [];
  return list.find((e) => e.enabled && addrEq(e.address, target)) || null;
}
