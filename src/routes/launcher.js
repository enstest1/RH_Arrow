/**
 * launcher.js — launch-contract detection only.
 *
 * STRIKE launcher 0xc6cc8979… has no historical buy txs (create selector
 * 0x70fb7e8a, value=0). First STRIKE buy used SigmaSwap, not this contract.
 * Do not invent a buy ABI.
 */
import { STRIKE_LAUNCHER } from './constants.js';

/** Known launcher contracts (detection hints only). */
export const LAUNCHER_CONTRACTS = new Set([
  STRIKE_LAUNCHER.toLowerCase(),
]);

/**
 * Infer whether source tx touched a launcher (for UI/audit — not a buy route).
 * @param {{ type: string, address?: string, txHash?: string, role?: string }} source
 */
export function detectLauncherContext(source) {
  if (source.type !== 'chain') return { active: false, reason: 'not_chain' };
  const addr = String(source.address || '').toLowerCase();
  const role = String(source.role || '');
  if (role === 'launcher-contract' || LAUNCHER_CONTRACTS.has(addr)) {
    return {
      active: true,
      launcher: STRIKE_LAUNCHER,
      reason: 'launcher_contract_in_watch_path',
      executable: false,
    };
  }
  return { active: false, reason: 'no_launcher_match' };
}

/**
 * Launcher buy route — NOT AVAILABLE until ABI verified from historical buys.
 * @returns {null}
 */
export async function discoverLauncherRoute() {
  return null;
}

/**
 * @param {{ currentTaxPct?: number, maxLaunchTaxPct?: number }} p
 */
export function evaluateLaunchTax({ currentTaxPct, maxLaunchTaxPct }) {
  const max = Number(maxLaunchTaxPct);
  if (!Number.isFinite(max) || max <= 0) return { ok: true };
  const tax = Number(currentTaxPct);
  if (!Number.isFinite(tax)) return { ok: true };
  if (tax > max) {
    return { ok: false, reason: 'launch_tax_too_high', detail: 'tax ' + tax + '% > max ' + max + '%' };
  }
  return { ok: true };
}
