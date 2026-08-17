# rh-minter — Script Kiddies (KIDDIES), Robinhood Chain

Confirmed: mint(uint256) selector 0xa0712d68, contract
0x0130adFd81393Dcb5F510469635413bAE1Cd6402, chainId 4663.

## How winning actually works on Robinhood Chain (important)
The chain uses STRICT first-come-first-served ordering with NO public mempool.
Paying higher gas does NOT move you up the queue — Robinhood designed it that way
to blunt fee-based front-running. Sniping here is a pure LATENCY RACE to the
sequencer, which runs in AWS Ohio (us-east-2).

Measured latency to the sequencer: ~3ms from Ohio vs ~140ms Tokyo, ~200ms Sydney.
With ~100ms blocks, location alone can be worth ~2 blocks of advantage.

### The single biggest optimization
Run this bot from a server physically near the sequencer, NOT from your laptop:
- Best: a cheap AWS EC2 instance in us-east-2 (Ohio). Puts you at ~3ms.
- Good: any US-East VPS.
- Worst: home wifi far from us-east — you're adding 50-200ms for free.
Gas tuning is irrelevant by comparison; latency is the whole game.

## What the code already does right
- Pre-signs the tx before open, so firing is a bare network broadcast.
- Polls every POLL_MS and fires the instant mintLive() flips.
- Sets gas only to inclusion level, capped in USD (no pointless overbidding).

## Setup (Cursor terminal)
```bash
npm install
cp .env.example .env    # edit: PRIVATE_KEY, ALCHEMY, PRICE_PER_UNIT_ETH
npm run inspect         # READ-ONLY go/no-go — run first
npm run dryrun          # prices tx, sends nothing
npm run mint            # pre-signs, waits, broadcasts
```

## Wallet
Needs your private key (signing can't happen without it). Export from your wallet
(MetaMask: ⋮ > Account details > Show private key), paste into PRIVATE_KEY in .env.
Use a burner with only the WL spot + ETH for mint + gas.

## Go/no-go
`npm run inspect` shows if the sale's live and whether your wallet is allowlisted.
If mintableBy(you) is 0/false, the mint reverts no matter what — fix that first.

## 90s UI control panel
Prefer clicking to editing files? Run the local control panel:
```bash
npm run ui
```
Then open http://localhost:4663 in your browser. It shows connection, mint status,
your allowlist eligibility, and gives Refresh / Dry run / MINT buttons with a live log.
Your PRIVATE_KEY stays in .env and is only used by the local server — it never reaches
the browser. Change the port with UI_PORT=xxxx npm run ui.
