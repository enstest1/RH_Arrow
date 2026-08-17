import 'dotenv/config';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ethers } from 'ethers';
import { makeProvider } from './provider.js';
import { PATTERNS, patternById } from './patterns.js';
import { detectFromTx, detectFromContract } from './detect.js';
import { buildManual } from './manual.js';
import { readAutoStatus, saveSettings, getSettings, startWatching, stopWatching } from './autobuy.js';
import { validateSettings } from './swaprules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || process.env.UI_PORT || 4663);
const HOST = process.env.BIND_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const DASH_TOKEN = process.env.DASH_TOKEN || '';

const haveKey = () => { const k = process.env.PRIVATE_KEY; return !!k && !k.includes('YOUR'); };
const walletOrNull = () => haveKey() ? new ethers.Wallet(process.env.PRIVATE_KEY, makeProvider()) : null;

// Active session: which contract + pattern the user has loaded.
let session = {
  address: process.env.CONTRACT_ADDRESS || '',
  patternId: 'thirdweb-drop',      // default; overwritten by detect
  priceEth: process.env.PRICE_PER_UNIT_ETH || '0', // used by non-thirdweb + manual
  qty: BigInt(process.env.MINT_QUANTITY || '1'),
  manualSig: '',                   // e.g. "mint(uint256)" — when set, overrides pattern
  useManual: false,
  maxGasUsd: process.env.MAX_GAS_USD || '15',  // UI-editable hard cap on gas spend
};
let state = { running:false, log:[], txHash:null, done:false, ok:null };
const log = m => { state.log.push(`[${new Date().toLocaleTimeString()}] ${m}`); if (state.log.length>300) state.log.shift(); };

function contractFor(providerOrWallet) {
  const p = patternById(session.patternId);
  if (!p) throw new Error('no pattern selected');
  return { c: new ethers.Contract(session.address, p.abi, providerOrWallet), p };
}

async function detect({ address, txHash }) {
  const provider = makeProvider();
  const result = { address, patternId:null, label:null, via:null, error:null };
  try {
    if (txHash) {
      const d = await detectFromTx(provider, txHash);
      if (d?.patternId) { result.patternId=d.patternId; result.via=d.via; if (d.contract) result.address = d.contract; }
    }
    if (!result.patternId && address) {
      const d = await detectFromContract(provider, address);
      if (d?.patternId) { result.patternId=d.patternId; result.via=d.via; }
    }
    if (result.patternId) {
      result.label = patternById(result.patternId)?.label;
      session.address = result.address || address;
      session.patternId = result.patternId;
    } else {
      result.error = 'Could not identify the mint pattern. Paste a known mint tx hash for this collection, or the contract may use an unsupported template.';
    }
  } catch (e) { result.error = e.shortMessage || e.message; }
  return result;
}

// Unified: build the mint calldata + value, using manual signature if set, else pattern.
async function buildCall(providerOrWallet, receiver) {
  if (session.useManual && session.manualSig.trim()) {
    const b = buildManual(session.manualSig, receiver, session.qty, session.priceEth);
    return { data: b.data, value: b.value, to: session.address, notes: b.notes, gated: false, fn: b.fn };
  }
  const { c, p } = contractFor(providerOrWallet);
  const built = await p.build(c, receiver, session.qty, { priceEth: session.priceEth });
  const to = built.to ?? session.address;
  const data = built.data ?? c.interface.encodeFunctionData(built.fn, built.args);
  return { data, value: built.value, to, notes: built.notes, gated: built.gated, fn: built.fn,
           onchainPriceEth: built.onchainPriceEth ?? null };
}

async function readStatus() {
  const provider = makeProvider();
  const manualActive = session.useManual && session.manualSig.trim();
  const out = { connected:false, hasKey:haveKey(), address:session.address,
    patternId:session.patternId,
    patternLabel: manualActive ? ('MANUAL: '+session.manualSig.split('(')[0].trim())
      : patternById(session.patternId)?.label,
    manualSig: session.manualSig, useManual: session.useManual,
    wallet:null, balanceEth:null, notes:null, gated:null, minted:null, maxSupply:null, youMinted:null,
    priceEth:session.priceEth, maxGasUsd:session.maxGasUsd, qty:session.qty.toString(),
    onchainPriceEth:null };
  try { out.chainId = (await provider.getNetwork()).chainId.toString(); out.connected = true; }
  catch (e) { out.error='connect: '+(e.shortMessage||e.code||e.message); return out; }

  // Always surface wallet + balance when a key is loaded (even before Detect).
  try {
    const w = walletOrNull();
    if (w) {
      out.wallet = w.address;
      try { out.balanceEth = ethers.formatEther(await provider.getBalance(w.address)); } catch {}
    }
  } catch {}

  if (!session.address) { out.error='No contract loaded. Enter an address and Detect.'; return out; }

  try {
    const w = walletOrNull();
    const receiver = w ? w.address : ethers.ZeroAddress;
    out.mode = manualActive ? 'manual' : 'pattern';
    // ERC721 supply reads work for most collections regardless of mint pattern.
    try {
      const erc = new ethers.Contract(session.address, [
        'function totalSupply() view returns (uint256)',
        'function maxSupply() view returns (uint256)',
      ], provider);
      out.minted = (await erc.totalSupply()).toString();
      try { out.maxSupply = (await erc.maxSupply()).toString(); } catch {}
    } catch {}
    // SeaDrop: per-wallet mint count + collection cap from getMintStats.
    if (session.patternId === 'seadrop' && !manualActive && w) {
      try {
        const sd = new ethers.Contract(session.address,
          ['function getMintStats(address) view returns (uint256,uint256,uint256)'], provider);
        const [minterNumMinted,, maxSup] = await sd.getMintStats(w.address);
        out.youMinted = minterNumMinted.toString();
        if (out.maxSupply == null) out.maxSupply = maxSup.toString();
      } catch {}
    }
    // build a preview (reads live price/phase for thirdweb; encodes manual sig if set)
    try {
      const built = await buildCall(provider, receiver);
      out.notes = built.notes; out.gated = built.gated;
      out.onchainPriceEth = built.onchainPriceEth;
      out.valueEth = ethers.formatEther(built.value);
    } catch (e) { out.buildError = e.shortMessage || e.message; }
  } catch (e) { out.readError = e.shortMessage || e.message; }
  return out;
}

async function doMint({ dryRun }) {
  if (state.running) return;
  state = { running:true, log:[], txHash:null, done:false, ok:null };
  try {
    const w = walletOrNull(); if (!w) { log('❌ no PRIVATE_KEY in .env'); throw new Error('nokey'); }
    if (!session.address) { log('❌ no contract loaded'); throw new Error('noaddr'); }
    const provider = w.provider;
    log(`contract ${session.address}`);
    const built = await buildCall(w, w.address);
    const mode = session.useManual && session.manualSig.trim() ? 'manual signature' : ('pattern: '+(patternById(session.patternId)?.label||'?'));
    log(mode);
    built.notes?.forEach(n=>log('  '+n));
    if (built.gated) log('⚠️ this phase is allowlist-gated — an empty proof will likely revert.');

    const to = built.to ?? session.address;
    const data = built.data;
    const value = built.value;
    if (to !== session.address) log('SeaDrop call → ' + to);
    let gasLimit;
    try { gasLimit = ((await provider.estimateGas({ to, data, value, from:w.address })) * 130n)/100n; }
    catch (x) { log('❌ would revert: '+(x.shortMessage||x.message)); log('   (phase not open / gated / wrong price / limit hit)'); throw x; }
    const fee = await provider.getFeeData();
    const suggested = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits('0.1','gwei');
    const ethUsd = Number(process.env.ETH_USD||'3000'), maxGasUsd = Number(session.maxGasUsd||'15');
    let maxFeePerGas = suggested*2n;
    const capWei = ethers.parseEther((maxGasUsd/ethUsd).toFixed(18))/gasLimit;
    if (maxFeePerGas>capWei) maxFeePerGas=capWei;
    let priority = ethers.parseUnits('0.01','gwei'); if (priority>maxFeePerGas) priority=maxFeePerGas;
    const estEth = Number(ethers.formatEther(maxFeePerGas*gasLimit));
    log(`send ${ethers.formatEther(value)} ETH | gas ~$${(estEth*ethUsd).toFixed(2)}`);

    if (dryRun) { log('✅ dry run — call valid, nothing sent'); state.ok=true; return; }

    const net = await provider.getNetwork();
    const nonce = await provider.getTransactionCount(w.address,'pending');
    const signed = await w.signTransaction({ to, data, value, gasLimit, nonce, type:2,
      maxFeePerGas, maxPriorityFeePerGas:priority, chainId:net.chainId });
    log(`pre-signed (nonce ${nonce})`);
    log('🚀 broadcasting...');
    const resp = await provider.broadcastTransaction(signed);
    state.txHash = resp.hash; log('tx '+resp.hash);
    const r = await resp.wait(); state.ok = r.status===1;
    log(state.ok ? `✅ CONFIRMED block ${r.blockNumber}` : `❌ REVERTED block ${r.blockNumber}`);
  } catch (x) { if (!['nokey','noaddr'].includes(x.message)) log('❌ '+(x.shortMessage||x.message)); state.ok=false; }
  finally { state.done = true; state.running = false; }
}

const json = (res,code,obj) => { res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); };
async function body(req){ return new Promise(r=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{r(JSON.parse(d||'{}'))}catch{r({})} }); }); }

const server = http.createServer(async (req,res) => {
  try {
    if (DASH_TOKEN) { const u=new URL(req.url,'http://x');
      if (u.searchParams.get('token')!==DASH_TOKEN){ res.writeHead(401); return res.end('unauthorized — append ?token=YOUR_DASH_TOKEN'); }
      req.url = u.pathname; }
    if (req.method==='GET' && (req.url==='/'||req.url==='/index.html')) {
      const html = await readFile(path.join(__dirname,'ui.html')); res.writeHead(200,{'Content-Type':'text/html'}); return res.end(html); }
    if (req.method==='GET' && req.url==='/api/patterns') return json(res,200,PATTERNS.map(p=>({id:p.id,label:p.label})));
    if (req.method==='GET' && req.url==='/api/status') return json(res,200,await readStatus());
    if (req.method==='GET' && req.url==='/api/log') return json(res,200,state);
    if (req.method==='POST' && req.url==='/api/detect') { const b=await body(req); return json(res,200, await detect(b)); }
    if (req.method==='POST' && req.url==='/api/session') { const b=await body(req);
      if (b.address!=null) session.address=b.address.trim();
      if (b.patternId!=null) session.patternId=b.patternId;
      if (b.priceEth!=null) session.priceEth=String(b.priceEth);
      if (b.qty!=null) session.qty=BigInt(b.qty||'1');
      if (b.manualSig!=null) session.manualSig=b.manualSig.trim();
      if (b.useManual!=null) session.useManual=!!b.useManual;
      if (b.maxGasUsd!=null) session.maxGasUsd=String(b.maxGasUsd);
      return json(res,200,{ok:true, session:{...session, qty:session.qty.toString()}}); }
    if (req.method==='POST' && req.url==='/api/validate-sig') { const b=await body(req);
      const sig = (b.sig||'').trim();
      if (!sig) return json(res,200,{ok:false, error:'Empty signature.'});
      if (/^mintSeaDrop/i.test(sig)) {
        return json(res,200,{ok:false,
          error:'mintSeaDrop is only callable by the SeaDrop contract — use Detect (SeaDrop) or mintPublic on SeaDrop, not mintSeaDrop on the NFT.'});
      }
      const fn = sig.split('(')[0].trim();
      for (const suffix of [' payable', '']) {
        try {
          const iface = new ethers.Interface([`function ${sig}${suffix}`]);
          const inputs = iface.getFunction(fn).inputs.map(i=>`${i.type} ${i.name||''}`.trim());
          return json(res,200,{ok:true, fn, inputs, payable: suffix.includes('payable')});
        } catch {}
      }
      return json(res,200,{ok:false, error:'Invalid signature. Examples: mint(uint256), mintTo(address,uint256).'}); }
    if (req.method==='POST' && req.url==='/api/dryrun') { doMint({dryRun:true}); return json(res,200,{started:true}); }
    if (req.method==='POST' && req.url==='/api/mint') { doMint({dryRun:false}); return json(res,200,{started:true}); }
    if (req.method==='GET' && req.url==='/api/auto/status') return json(res,200, await readAutoStatus());
    if (req.method==='POST' && req.url==='/api/auto/settings') { const b=await body(req);
      const s=saveSettings(b); return json(res,200,{ok:true, settings:s, errors:validateSettings(s)}); }
    if (req.method==='POST' && req.url==='/api/auto/start') { const s=getSettings();
      const errors=validateSettings(s); if (errors.length) return json(res,200,{ok:false,errors});
      saveSettings({enabled:true}); return json(res,200, startWatching()); }
    if (req.method==='POST' && req.url==='/api/auto/stop') { saveSettings({enabled:false});
      return json(res,200, stopWatching()); }
    res.writeHead(404); res.end('not found');
  } catch (e) { json(res,500,{error:e.message}); }
});
server.listen(PORT, HOST, () => {
  console.log('\n  rh-minter control panel on '+HOST+':'+PORT);
  if (HOST==='127.0.0.1') console.log('  Open http://localhost:'+PORT);
  else { console.log('  ⚠️ public bind — set DASH_TOKEN and open with ?token=...'); }
  console.log('  Key loaded:', haveKey()?'yes':'NO');
});
