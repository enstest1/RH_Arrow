/**
 * autobuy.js — the pipeline: watched X account posts a CA → quote → gate → buy.
 *
 * Standalone (no Discord). Status goes to a log ring the UI polls, exactly
 * like the mint flow's log panel.
 *
 * DESIGN RULE: no limit logic in this file. Everything that can stop funds
 * leaving the wallet is in swaprules.js, which is exhaustively tested. This
 * file only sequences I/O.
 *
 * The X account is polled through goat-x-pro (cookie auth, same as the other
 * tools in this stack). Set X_COOKIES_JSON or X_COOKIES_PATH.
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { makeProvider } from './provider.js';
import { evaluateBuy, ethToWei, weiToEthNum } from './swaprules.js';
import { quoteBuy, tokenMeta, executeBuy, V4_QUOTER } from './swap.js';
import { getSettings, saveSettings, alreadyBought, recordBuy, seenTweet, markTweet, listBuys, totalSpentEth } from './autostate.js';
import { fetchHandleTweets, resetXTimelineCache } from './xtimeline.js';

const CA_RE = /\b0x[a-fA-F0-9]{40}\b/;
/** Read poll interval at runtime so .env is always loaded first. */
function pollSec() {
  return Math.max(15, Number(process.env.AUTO_POLL_SEC) || 30);
}

export const state = {
  running: false,
  watching: false,
  log: [],
  lastPollAt: null,
  lastError: null,
};

export function log(msg) {
  state.log.push('[' + new Date().toLocaleTimeString() + '] ' + msg);
  if (state.log.length > 300) state.log.shift();
  console.log('[autobuy] ' + msg);
}

/** Extract the first EVM contract address from tweet text. */
export function extractCA(text) {
  const m = String(text || '').match(CA_RE);
  return m ? m[0] : null;
}

let _provider = null;
let _wallet = null;
let _timer = null;
let _busy = false;
let _xclient = null;

function walletOrNull() {
  const k = process.env.PRIVATE_KEY;
  if (!k || k.includes('YOUR')) return null;
  if (!_provider) _provider = makeProvider();
  if (!_wallet) _wallet = new ethers.Wallet(k, _provider);
  return _wallet;
}

async function getXClient() {
  if (_xclient) return _xclient;
  const mod = await import('goat-x-pro');
  const XProClient = mod.XProClient || mod.default?.XProClient;
  if (!XProClient) throw new Error('goat-x-pro: XProClient export not found');
  const opts = {};
  if (process.env.X_COOKIES_JSON?.trim()) opts.cookies = JSON.parse(process.env.X_COOKIES_JSON);
  else opts.cookiesPath = process.env.X_COOKIES_PATH || './cookies.json';
  _xclient = new XProClient(opts);
  await _xclient.login();
  log('X client logged in');
  return _xclient;
}

/**
 * Run one contract address through the pipeline.
 * → { action, reason }  — never throws.
 */
export async function handleCA({ contract, handle, tweetUrl }) {
  const settings = getSettings();
  const w = walletOrNull();
  if (!w) { log('❌ no PRIVATE_KEY loaded'); return { action: 'skipped', reason: 'no_key' }; }
  if (!V4_QUOTER) { log('❌ V4_QUOTER not set in .env — cannot quote'); return { action: 'skipped', reason: 'no_quoter' }; }
  if (_busy) { log('⏳ a buy is already in flight — skipping ' + contract); return { action: 'skipped', reason: 'busy' }; }

  _busy = true;
  try {
    const provider = w.provider;
    const meta = await tokenMeta(provider, contract);
    const label = meta.symbol || contract.slice(0, 10) + '…';
    log('signal @' + handle + ' → ' + label + ' ' + contract);

    const spendWei = ethToWei(settings.maxSpendEth);
    const quote = spendWei > 0n ? await quoteBuy(provider, contract, spendWei) : null;

    if (quote) {
      log('  quote: fee tier ' + (quote.fee / 10000).toFixed(2) + '%');
    }

    const balance = await provider.getBalance(w.address);
    const verdict = evaluateBuy({
      settings,
      alreadyBought: alreadyBought(contract),
      walletBalanceWei: balance,
      gasReserveWei: ethToWei('0.001'),
      quote,
      sourceHandle: handle,
    });

    if (!verdict.ok) {
      log('⏭️  skipped: ' + verdict.detail);
      return { action: 'skipped', reason: verdict.reason };
    }

    log('  buying ' + weiToEthNum(verdict.spendWei).toFixed(5) + ' ETH of ' + label + '…');
    const result = await executeBuy({
      wallet: w,
      provider,
      quote,
      spendWei: verdict.spendWei,
      tolerancePct: Number(settings.slippageTolerancePct),
      maxGasUsd: Number(process.env.MAX_GAS_USD || '5'),
      ethUsd: Number(process.env.ETH_USD || '3000'),
      dryRun: false,
      deadlineSec: 120,
    });

    if (!result.sent) {
      log('❌ buy failed: ' + result.error);
      return { action: 'failed', reason: result.error };
    }

    recordBuy(contract, {
      txHash: result.txHash,
      spendWei: String(verdict.spendWei),
      symbol: meta.symbol,
      handle,
      tweetUrl: tweetUrl || null,
    });
    log('🚀 BOUGHT ' + label + ' — tx ' + result.txHash);

    try {
      const r = await result.tx.wait();
      log(r.status === 1 ? '✅ CONFIRMED block ' + r.blockNumber : '❌ REVERTED block ' + r.blockNumber);
    } catch (e) { log('⚠️ confirmation wait failed: ' + e.message); }

    return { action: 'bought', txHash: result.txHash };
  } catch (e) {
    log('❌ pipeline error: ' + (e.shortMessage || e.message));
    state.lastError = e.message;
    return { action: 'failed', reason: e.message };
  } finally {
    _busy = false;
  }
}

/** Poll every watched handle for new tweets containing a CA. */
async function pollOnce() {
  const settings = getSettings();
  if (!settings.handles?.length) return;

  // Warm X session (validates cookies); tweets fetched via UserTweets in xtimeline.js.
  await getXClient();
  for (const raw of settings.handles) {
    const handle = String(raw).replace(/^@/, '').trim();
    if (!handle) continue;
    try {
      // SearchTimeline 401s on many accounts — UserTweets via xtimeline.js instead.
      const tweets = await fetchHandleTweets(handle, 10);
      let newCount = 0;
      let caFound = 0;

      for (const t of tweets || []) {
        if (!t?.id || seenTweet(t.id)) continue;
        markTweet(t.id);
        newCount++;
        const ca = extractCA(t.text);
        if (!ca) continue;
        caFound++;
        await handleCA({
          contract: ca,
          handle,
          tweetUrl: 'https://x.com/' + handle + '/status/' + t.id,
        });
      }
      log('✓ polled @' + handle + ' — ' + (tweets?.length || 0) + ' tweets' +
          (newCount ? ', ' + newCount + ' new' : '') +
          (caFound ? ', ' + caFound + ' with CA' : ', no CA'));
    } catch (e) {
      // Reset clients on auth failure so refreshed cookies.json is picked up next poll.
      if (/401|403|authenticate/i.test(String(e.message))) {
        _xclient = null;
        resetXTimelineCache();
      }
      log('⚠️ poll @' + handle + ': ' + e.message + ( /401|403|authenticate/i.test(String(e.message)) ? ' — refresh auth_token + ct0 in cookies.json' : ''));
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  state.lastPollAt = Date.now();
}

export function startWatching() {
  if (_timer) return { ok: true, already: true };
  const settings = getSettings();
  const pollMs = pollSec() * 1000;
  const handles = (settings.handles || []).map((h) => '@' + String(h).replace(/^@/, ''));

  _timer = setInterval(() => {
    pollOnce().catch((e) => log('⚠️ poll cycle: ' + e.message));
  }, pollMs);
  state.watching = true;
  log('👀 LIVE — watching ' + handles.join(', ') + ' every ' + pollSec() + 's');
  pollOnce().catch(() => {});
  return { ok: true };
}

export function stopWatching() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  state.watching = false;
  log('⏹️ stopped watching');
  return { ok: true };
}

/** Everything the UI needs in one call. */
export async function readAutoStatus() {
  const settings = getSettings();
  const w = walletOrNull();
  const out = {
    settings,
    watching: state.watching,
    log: state.log,
    lastPollAt: state.lastPollAt,
    quoterSet: Boolean(V4_QUOTER),
    wallet: null,
    balanceEth: null,
    buys: listBuys(10),
    totalSpentEth: totalSpentEth(),
  };
  if (w) {
    out.wallet = w.address;
    try { out.balanceEth = Number(ethers.formatEther(await w.provider.getBalance(w.address))); } catch {}
  }
  return out;
}

export { saveSettings, getSettings } from './autostate.js';
