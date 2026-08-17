# Using this for future mints (any Robinhood Chain contract)

## The workflow you'll repeat
1. Find the contract. Take a wallet that already minted the collection (yours from
   an earlier phase, or any minter you see in the collection's activity). Open its
   mint transaction on robinhoodchain.blockscout.com and read "Interacted with" —
   that address is the contract. For phased drops, phase 1 and phase 2 are almost
   always the SAME contract, so a phase-1 tx gives you the phase-2 address.
2. Start the UI:  npm run ui   ->  open http://localhost:4663
3. Paste the contract address into "Contract address".
4. If you have a known mint tx hash for the collection, paste it too — it makes
   detection reliable (it reads the tx's events/method).
5. Click "Detect & load". The tool identifies the pattern and shows it.
6. Set Quantity. If it's a manual pattern (mint/mintTo), a Price box appears —
   enter the per-token price from the mint page.
7. Click "Dry run". If it validates, you're set. Click MINT when the phase is open.

## How it knows which function to call
- If the contract is VERIFIED on Blockscout, it has a published ABI (green check).
- If UNVERIFIED (common), the tool matches a FINGERPRINT instead:
  * thirdweb Drop -> emits `TokensClaimed` / has getActiveClaimConditionId -> uses claim(...)
  * Standard -> method id 0xa0712d68 -> mint(uint256)
  * mintTo -> 0x449a52f8 -> mintTo(address,uint256)
  This is why pasting a known mint tx hash helps: the tool reads its method id and
  event topics and matches the pattern exactly.

## Adding a new pattern later
Patterns live in src/patterns.js. Each has: how to recognize it (a 4-byte selector
or an event signature) and how to build the call (fn name, args, value). To support
a new template, add one entry there. If you hit a contract the tool can't identify,
grab a mint tx for it, note the method id (first 10 chars of Input Data) and any
event names, and that's everything needed to add support.

## The allowlist reality (unchanged, important)
For thirdweb drops, allowlist phases need a merkle proof that only the official
mint site / project can give you. This tool sends an EMPTY proof — which works for
PUBLIC phases only (e.g. the open "FCFS for all" phase). If "Allowlist-gated" shows
YES, an empty-proof mint will revert; mint that phase via the official site. The
public phase (usually the last one, open to everyone) is the one a fast bot helps
with — and it's exactly the one this tool handles.

## Robinhood Chain speed reality (unchanged)
First-come-first-served ordering, no mempool. Gas doesn't buy priority. If a public
phase is genuinely contested, run this near the Ohio sequencer (see DEPLOY.md).

--------------------------------------------------------------------
## Two ways to tell the tool which function to call
--------------------------------------------------------------------

### Way 1 — Detect from a transaction (you don't know the function)
Input: a MINT TRANSACTION HASH — the 0x... hash of a tx where someone successfully
minted THIS collection. Not the contract address, not your wallet — a mint tx.
Where to get it: open the collection on Blockscout -> Transactions -> click a
successful mint -> copy the hash. Paste into "Known mint tx hash", click
"Detect from tx". The tool reads the tx's method id + events and matches a pattern.

### Way 2 — Enter the function yourself (you already found it)
Input: the FUNCTION SIGNATURE — the name plus arg types in parentheses, exactly:
   mint(uint256)
   mintTo(address,uint256)
   claim(address,uint256)
   publicMint(uint256)
Where to get it: the contract's verified "Write" tab (function name + each input's
type), or a mint tx's "Decode input data" section (shows method + arg types).
Type it into "Or enter the mint function yourself", click "Use this function".
The tool validates it and switches to MANUAL mode.

How manual mode fills the arguments:
- a uint argument  -> your Quantity
- an address arg   -> your wallet (the receiver)
- if it's payable  -> set Price/token; it sends price x quantity as value
If a function has an argument it can't guess (an unusual type), it will say so and
you'd need one of the built-in patterns instead. Manual mode is for SIMPLE mints
(mint/mintTo/publicMint style). Complex ones (thirdweb claim with merkle proof)
should use Detect, which handles the proof structure.

### Which to use
- Contract verified or a normal mint() style -> either works; manual is fastest.
- thirdweb / merkle-proof drops -> use Detect (it builds the claim struct for you).
- Can't detect AND it's a simple function -> enter the signature manually.
