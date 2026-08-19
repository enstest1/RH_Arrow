/**
 * chainfreshness.js — reject stale chain launches found by background catch-up.
 * Does not apply to X candidates. Historical/dry-run replay may bypass.
 *
 * Robinhood Chain produces ~8–10 blocks/s in recent soaks. 32 blocks ≈ 3.2–4s.
 * 5000ms is aligned with that window (8000ms would accept ~64–80 blocks).
 */

/** @returns {number} */
export function maxChainCandidateAgeBlocks() {
  return Math.max(1, Number(process.env.MAX_CHAIN_CANDIDATE_AGE_BLOCKS) || 32);
}

/** @returns {number} */
export function maxChainCandidateAgeMs() {
  return Math.max(250, Number(process.env.MAX_CHAIN_CANDIDATE_AGE_MS) || 5000);
}

/**
 * Historical fixtures and dry-run pipeline tests must still accept old blocks.
 * @param {{ dryRun?: boolean, source?: object }} [p]
 */
export function bypassChainFreshness(p = {}) {
  if (p.source?.historical) return true;
  if (String(process.env.HISTORICAL_REPLAY || '').toLowerCase() === 'true') return true;
  return false;
}

/**
 * @param {{
 *   source?: object,
 *   currentHead?: number|null,
 *   now?: number,
 *   liveHealth?: string,
 *   chainBuyBlocked?: boolean,
 *   dryRun?: boolean,
 * }} p
 */
export function evaluateChainCandidateFreshness(p) {
  const source = p.source || {};
  if (source.type !== 'chain') return { ok: true, reason: 'not_chain' };
  if (bypassChainFreshness({ dryRun: p.dryRun, source })) {
    return { ok: true, reason: 'bypass' };
  }
  if (p.chainBuyBlocked || p.liveHealth === 'STALE') {
    return {
      ok: false,
      reason: 'scanner_live_stale',
      currentHead: p.currentHead ?? null,
      sourceBlock: source.blockNumber ?? null,
    };
  }

  const now = p.now ?? Date.now();
  const srcBlock = Number(source.blockNumber);
  const head = p.currentHead == null ? null : Number(p.currentHead);
  const ageBlocks = (head != null && Number.isFinite(srcBlock)) ? (head - srcBlock) : 0;
  if (head != null && Number.isFinite(srcBlock) && ageBlocks > maxChainCandidateAgeBlocks()) {
    return {
      ok: false,
      reason: 'stale_chain_candidate',
      sourceBlock: srcBlock,
      currentHead: head,
      ageBlocks,
    };
  }

  const detectedAt = Number(source.detectedAt || 0);
  if (detectedAt && now - detectedAt > maxChainCandidateAgeMs()) {
    return {
      ok: false,
      reason: 'stale_chain_candidate',
      sourceBlock: Number.isFinite(srcBlock) ? srcBlock : null,
      currentHead: head,
      ageBlocks,
      ageMs: now - detectedAt,
    };
  }

  return { ok: true, ageBlocks, currentHead: head, sourceBlock: srcBlock };
}
