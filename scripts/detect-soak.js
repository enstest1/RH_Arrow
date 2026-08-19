/**
 * detect-soak.js — DETECTION ONLY live observation. AUTO BUY stays DISARMED.
 * Never broadcasts. Ctrl+C or DETECT_SOAK_MS timeout.
 */
import 'dotenv/config';
import { startDetectionOnly, stopWatching, readAutoStatus, log } from '../src/autobuy.js';
import { forceWsDropForObserve, getChainScannerStatus, emulateWsDisconnectForTest } from '../src/chainscanner.js';

const ms = Math.max(5000, Number(process.env.DETECT_SOAK_MS) || 20000);

log('[SOAK] starting detection-only for ' + ms + 'ms');
await startDetectionOnly();

await new Promise((r) => setTimeout(r, Math.min(8000, Math.floor(ms / 2))));
const ws = getChainScannerStatus();
log('[SOAK] websocket snapshot liveLag=' + ws.liveLag + ' mode=' + ws.scannerMode + ' health=' + ws.scannerHealth);

if (String(process.env.SOAK_FORCE_WSS_DROP || 'true') !== 'false') {
  log('[SOAK] forcing WSS drop to measure HTTP fallback');
  try { forceWsDropForObserve(); } catch { /* ignore */ }
  emulateWsDisconnectForTest();
}

await new Promise((r) => setTimeout(r, Math.max(4000, ms - 8000)));
const st = await readAutoStatus();
const snap = {
  mode: st.scannerMode,
  httpHead: st.httpHead,
  liveScanned: st.latestLiveScannedBlock,
  liveLag: st.liveLag,
  wssLast: st.wssLastBlock,
  wssLag: st.wssLag,
  backgroundCursor: st.contiguousHistoricalBlock,
  backgroundLag: st.backgroundLag,
  health: st.scannerHealth,
  activeHttp: st.activeHttpProvider,
  activeWss: st.activeWssProvider,
  rateLimited: st.rpcRateLimited,
  xPoll: st.xPoll,
  armed: st.armed,
  autoBuy: st.autoBuyState,
};
console.log('[SOAK] final ' + JSON.stringify(snap));
stopWatching();
process.exit(0);
