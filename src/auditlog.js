/**
 * auditlog.js — append-only JSONL forensic log for auto-buy lifecycle.
 *
 * Writes are queued and flushed asynchronously so the buy hot path never
 * blocks on disk I/O before broadcast.
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.AUTOBUY_AUDIT_PATH || path.resolve(process.cwd(), 'autobuy-events.jsonl');

/** @type {string[]} */
const queue = [];
let flushing = false;

function flushSoon() {
  if (flushing) return;
  flushing = true;
  setImmediate(() => {
    flushing = false;
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    try {
      fs.appendFileSync(FILE, batch.join(''));
    } catch (e) {
      console.error('[auditlog] write failed:', e.message);
    }
  });
}

/**
 * Append one JSON event line. Never throws; never blocks buy path synchronously
 * beyond enqueue.
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 */
export function auditEvent(event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n';
  queue.push(line);
  flushSoon();
}

export function auditPath() {
  return FILE;
}
