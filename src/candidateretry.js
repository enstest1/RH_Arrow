/**
 * candidateretry.js — per-candidate retry loop without overlapping setInterval.
 *
 * One in-flight attempt at a time. Self-scheduling setTimeout. Cancel + timeout.
 */
import { auditEvent } from './auditlog.js';

/** Reasons that must stop retry (do not keep the candidate alive). */
export const TERMINAL_REASONS = new Set([
  'already_bought',
  'wrong_symbol',
  'untrusted_source',
  'no_key',
  'disabled',
  'unconfigured',
  'invalid_contract',
  'metadata_failed',
  'route_timeout',
  'wallet_unavailable',
  'unsupported_route_venue',
  'unsupported_swap_type',
  'launch_tax_too_high',
  'stale_chain_candidate',
  'scanner_live_stale',
  'insufficient_safe_budget',
]);

/**
 * Classify a tryOnce() result.
 * @param {{ action?: string, reason?: string, status?: string, sent?: boolean } | null} r
 * @returns {'sent' | 'terminal' | 'retry'}
 */
export function classifyCandidateResult(r) {
  if (!r) return 'retry';
  if (r.status === 'sent' || r.action === 'bought' || r.sent === true) return 'sent';
  if (r.status === 'terminal') return 'terminal';
  if (r.reason && TERMINAL_REASONS.has(r.reason)) return 'terminal';
  if (r.reason === 'busy' || r.status === 'retry' || r.action === 'failed' || r.sent === false) {
    return 'retry';
  }
  if (r.action === 'skipped' && r.reason === 'no_route') return 'retry';
  if (r.action === 'skipped' && r.reason === 'deferred') return 'retry';
  if (r.action === 'skipped') {
    return TERMINAL_REASONS.has(r.reason) ? 'terminal' : 'retry';
  }
  return 'retry';
}

/**
 * Self-scheduling retry worker. tryOnce must not be invoked overlapping.
 * @param {{
 *   key: string,
 *   tryOnce: (attempt: number) => Promise<object | null>,
 *   delayMs: number,
 *   windowMs: number,
 *   startedAt?: number,
 *   onDone: (result: object) => void,
 * }} p
 */
export function startRetryLoop(p) {
  let timer = null;
  let stopped = false;
  let inFlight = false;
  let attempt = 1;
  const startedAt = p.startedAt || Date.now();

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  async function tick() {
    if (stopped || inFlight) return;
    if (Date.now() - startedAt > p.windowMs) {
      auditEvent('candidate_expired', { candidateContract: p.key });
      stop();
      p.onDone({ action: 'skipped', reason: 'route_timeout', status: 'terminal' });
      return;
    }
    inFlight = true;
    attempt += 1;
    auditEvent('candidate_retry', { candidateContract: p.key, attempt });
    try {
      const r = await p.tryOnce(attempt);
      const cls = classifyCandidateResult(r);
      if (cls === 'sent' || cls === 'terminal') {
        stop();
        p.onDone(r || { action: 'skipped', reason: 'terminal', status: 'terminal' });
        return;
      }
    } catch (e) {
      auditEvent('candidate_retry', { candidateContract: p.key, attempt, error: e.message });
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, p.delayMs);
  }

  timer = setTimeout(() => { void tick(); }, p.delayMs);
  return {
    stop,
    getAttempt: () => attempt,
    getKey: () => p.key,
    startedAt,
  };
}
