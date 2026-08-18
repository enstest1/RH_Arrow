/**
 * candidateextract.js — pure receipt/tx candidate extraction (no I/O).
 *
 * Used by chainscanner and unit tests. Multiple paths:
 *   A) receipt.contractAddress (direct deploy)
 *   B) ERC20 Transfer from zero address in any receipt log
 *   C) (future) decoded factory events when ABI verified
 */
import { ethers } from 'ethers';
import { normAddr } from './chainwatchlist.js';

export const ZERO_TOPIC = ethers.zeroPadValue('0x00', 32).toLowerCase();
export const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)').toLowerCase();

/**
 * @typedef {{ contract: string, method: string, logIndex?: number, txHash?: string }} ExtractedCandidate
 */

/**
 * Path A — contract created in this transaction.
 * @param {import('ethers').TransactionReceipt} receipt
 * @returns {ExtractedCandidate[]}
 */
export function extractDirectDeploy(receipt) {
  if (!receipt?.contractAddress) return [];
  const c = normAddr(receipt.contractAddress);
  return c ? [{ contract: c, method: 'receipt.contractAddress', logIndex: -1, txHash: receipt.hash }] : [];
}

/**
 * Path C — ERC20 mint-from-zero Transfer logs.
 * @param {import('ethers').TransactionReceipt} receipt
 * @param {{ excludeAddresses?: Set<string> }} [opts]
 * @returns {ExtractedCandidate[]}
 */
export function extractMintFromZeroLogs(receipt, opts = {}) {
  const exclude = opts.excludeAddresses || new Set();
  /** @type {Map<string, ExtractedCandidate>} */
  const found = new Map();
  for (const lg of receipt?.logs || []) {
    const t0 = (lg.topics?.[0] || '').toLowerCase();
    if (t0 !== TRANSFER_TOPIC) continue;
    const fromTopic = (lg.topics[1] || '').toLowerCase();
    if (fromTopic !== ZERO_TOPIC) continue;
    const addr = normAddr(lg.address);
    if (!addr) continue;
    if (exclude.has(addr.toLowerCase())) continue;
    const key = addr.toLowerCase();
    if (!found.has(key)) {
      found.set(key, {
        contract: addr,
        method: 'Transfer-from-zero',
        logIndex: lg.index,
        txHash: receipt.hash,
      });
    }
  }
  return [...found.values()];
}

/**
 * Merge extraction paths, dedupe by contract address (prefer lower logIndex).
 * @param {import('ethers').TransactionReceipt} receipt
 * @param {{ excludeAddresses?: Set<string> }} [opts]
 * @returns {ExtractedCandidate[]}
 */
export function extractCandidatesFromReceipt(receipt, opts = {}) {
  const all = [
    ...extractDirectDeploy(receipt),
    ...extractMintFromZeroLogs(receipt, opts),
  ];
  /** @type {Map<string, ExtractedCandidate>} */
  const byAddr = new Map();
  for (const c of all) {
    const k = c.contract.toLowerCase();
    const prev = byAddr.get(k);
    if (!prev || (c.logIndex ?? 999) < (prev.logIndex ?? 999)) byAddr.set(k, c);
  }
  return [...byAddr.values()];
}

/**
 * Does this tx involve a watched address as from or to?
 * @param {import('ethers').TransactionResponse} tx
 * @param {Set<string>} watchLower
 */
export function txTouchesWatch(tx, watchLower) {
  const from = (tx.from || '').toLowerCase();
  const to = (tx.to || '').toLowerCase();
  return watchLower.has(from) || (to && watchLower.has(to));
}

/**
 * Which watched address matched (for source attribution).
 * @param {import('ethers').TransactionResponse} tx
 * @param {Set<string>} watchLower
 * @returns {{ side: 'from'|'to', address: string } | null}
 */
export function matchedWatchSide(tx, watchLower) {
  const from = (tx.from || '').toLowerCase();
  const to = (tx.to || '').toLowerCase();
  if (watchLower.has(from)) return { side: 'from', address: from };
  if (to && watchLower.has(to)) return { side: 'to', address: to };
  return null;
}
