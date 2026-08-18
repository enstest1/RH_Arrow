/**
 * Per-candidate retry: no overlapping attempts, busy keeps the candidate,
 * execution failure retries, deadline is terminal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCandidateResult,
  startRetryLoop,
} from '../src/candidateretry.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('classify: sent / terminal / retry', () => {
  assert.equal(classifyCandidateResult({ action: 'bought', txHash: '0x1' }), 'sent');
  assert.equal(classifyCandidateResult({ sent: true }), 'sent');
  assert.equal(classifyCandidateResult({ status: 'sent' }), 'sent');
  assert.equal(classifyCandidateResult({ action: 'skipped', reason: 'wrong_symbol' }), 'terminal');
  assert.equal(classifyCandidateResult({ action: 'skipped', reason: 'already_bought', status: 'terminal' }), 'terminal');
  assert.equal(classifyCandidateResult({ action: 'skipped', reason: 'busy', status: 'retry' }), 'retry');
  assert.equal(classifyCandidateResult({ sent: false, status: 'retry' }), 'retry');
  assert.equal(classifyCandidateResult({ action: 'failed', reason: 'temporary RPC' }), 'retry');
  assert.equal(classifyCandidateResult({ action: 'skipped', reason: 'no_route', status: 'retry' }), 'retry');
  assert.equal(classifyCandidateResult({ reason: 'unsupported_swap_type', status: 'terminal' }), 'terminal');
  assert.equal(classifyCandidateResult({ reason: 'launch_tax_too_high' }), 'terminal');
});

test('busy candidate keeps retrying until sent', async () => {
  let n = 0;
  const result = await new Promise((resolve) => {
    startRetryLoop({
      key: '0xbusy',
      delayMs: 15,
      windowMs: 2000,
      tryOnce: async () => {
        n += 1;
        if (n < 3) return { action: 'skipped', reason: 'busy', status: 'retry' };
        return { action: 'bought', txHash: '0xabc', status: 'sent' };
      },
      onDone: resolve,
    });
  });
  assert.equal(result.status, 'sent');
  assert.ok(n >= 3);
});

test('execution failure is retryable until success', async () => {
  let n = 0;
  const result = await new Promise((resolve) => {
    startRetryLoop({
      key: '0xfail',
      delayMs: 15,
      windowMs: 2000,
      tryOnce: async () => {
        n += 1;
        if (n < 3) return { sent: false, error: 'quote changed', status: 'retry' };
        return { sent: true, status: 'sent', txHash: '0xdef' };
      },
      onDone: resolve,
    });
  });
  assert.equal(result.txHash, '0xdef');
  assert.ok(n >= 3);
});

test('deadline expiry is terminal', async () => {
  const result = await new Promise((resolve) => {
    startRetryLoop({
      key: '0xlate',
      delayMs: 20,
      windowMs: 40,
      startedAt: Date.now() - 50,
      tryOnce: async () => ({ action: 'skipped', reason: 'no_route', status: 'retry' }),
      onDone: resolve,
    });
  });
  assert.equal(result.reason, 'route_timeout');
  assert.equal(result.status, 'terminal');
});

test('retry loop never overlaps tryOnce', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  let ticks = 0;
  await new Promise((resolve) => {
    startRetryLoop({
      key: '0xoverlap',
      delayMs: 8,
      windowMs: 5000,
      tryOnce: async () => {
        ticks += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(25);
        concurrent -= 1;
        if (ticks >= 3) return { action: 'bought', status: 'sent', txHash: '0x1' };
        return { action: 'skipped', reason: 'no_route', status: 'retry' };
      },
      onDone: resolve,
    });
  });
  assert.equal(maxConcurrent, 1);
  assert.ok(ticks >= 3);
});
