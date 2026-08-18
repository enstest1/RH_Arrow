# Deploying the minter near the Ohio sequencer

The Robinhood Chain sequencer runs in AWS us-east-2 (Ohio). Lower latency to it =
better position in the first-come-first-served queue. This ONLY matters if the mint
is actually contested — run `npm run inspect` first and check ALLOWLIST_SUPPLY vs demand.

## Option A — Railway (easiest; US East = Virginia, near-but-not-Ohio)
1. Put the repo on GitHub. Confirm .gitignore lists `.env` and `node_modules/`
   (it does) so your key is NOT committed.
2. railway.com -> New Project -> Deploy from GitHub repo -> pick this repo.
3. Service -> Settings -> Region -> **US East (Virginia)**.
4. Service -> Settings -> set Start Command to: `npm run ui`
5. Variables tab -> add these (do NOT commit them):
   PRIVATE_KEY, ALCHEMY_URL (or ALCHEMY_KEY), CONTRACT_ADDRESS,
   PRICE_PER_UNIT_ETH, MAX_GAS_USD, ETH_USD, WAIT_FOR_ONCHAIN, POLL_MS,
   and **DASH_TOKEN** = a long random string you choose.
   (Railway injects PORT automatically; the server picks it up and binds 0.0.0.0.)
6. Deploy. Open the generated URL WITH your token:
   https://your-app.up.railway.app/?token=YOUR_DASH_TOKEN
   Without the token every request returns 401 — that's what stops a stranger
   who finds the URL from pressing MINT with your key.

## Option B — AWS EC2 in us-east-2 (true optimum, ~3ms to sequencer)
1. AWS console -> EC2 -> Launch instance. **Region selector top-right = Ohio (us-east-2).**
2. Ubuntu, t3.micro is plenty. Create/download a key pair. Security group: allow SSH
   (port 22) from your IP only. Do NOT open the UI port to the world.
3. SSH in:  ssh -i your-key.pem ubuntu@THE_PUBLIC_IP
4. Install Node:
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs git
5. Copy the project up (from your laptop):
   scp -i your-key.pem -r ./rh-minter ubuntu@THE_PUBLIC_IP:~
6. On the box:  cd rh-minter && npm install && cp .env.example .env && nano .env
   (fill in PRIVATE_KEY, ALCHEMY_URL, ALCHEMY_WSS_URL, V4_QUOTER, TARGET_SYMBOL,
   X_COOKIES_PATH, etc.)
7. Don't expose the UI publicly. Run it bound to localhost and tunnel it to your laptop:
   On the box:   UI_PORT=4666 node src/server.js
   From laptop:  ssh -i your-key.pem -L 4666:localhost:4666 ubuntu@THE_PUBLIC_IP
   Then open http://localhost:4666 on your laptop — the UI runs in Ohio, you view it locally.
   Launch Scanner tab: Start Watching arms **chain WebSocket scanner (primary)** + **X fallback**.
   Route discovery tries **launcher (detect-only)** → **aggregator (V3 / Up CL)** → **Uniswap v4**.
   Set `AGGREGATOR_ENABLED=true` (default) and verify `AGGREGATOR_PROXY` / `AGGREGATOR_EXPECTED_IMPL`
   match on-chain before production. Aggregator init runs on `/api/auto/start`.
   Audit log writes to `autobuy-events.jsonl` on the box.
8. Terminate the instance when the mint is done so you stop paying.

## Latency sanity check (either option)
From the server, time a request to the RPC:
   time curl -s -X POST -H 'content-type: application/json' \
     --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
     https://rpc.mainnet.chain.robinhood.com
Lower is better. Pair the server region with an RPC endpoint in the same region.
