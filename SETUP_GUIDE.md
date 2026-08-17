# Full setup guide (ELI5)

Big idea: the webpage is just BUTTONS. Your private key and the contract address
live in a hidden settings file (`.env`) that only the little server reads. You never
type your key into the webpage. Do PART 1 on your laptop first. PART 2 (AWS) is
optional and only worth it if the mint is a real race.

--------------------------------------------------------------------
## PART 1 — Get it working on your laptop (do this first, always)
--------------------------------------------------------------------

### Step 1. Open a terminal in the project folder
In Cursor: Terminal menu -> New Terminal. You should be inside the `rh-minter`
folder (the one with `package.json`). Check:

    ls

You should see: package.json, src, README.md, DEPLOY.md, etc.

### Step 2. Check Node is installed (need v18+, ideally v20/22)

    node --version

If it prints v18 or higher, good. If "command not found", install Node from
nodejs.org (LTS), close and reopen the terminal, try again.

### Step 3. Install the project's dependencies (one time)

    npm install

This downloads ethers etc. into a `node_modules` folder. Wait for it to finish.

### Step 4. Make your settings file from the template

    cp .env.example .env

(Windows PowerShell: `copy .env.example .env`)

Now open `.env` in Cursor (click it in the file list). This is the hidden file
that holds your secrets. It is gitignored, so it never gets uploaded anywhere.

### Step 5. Fill in `.env`. Only a few lines matter:

    PRIVATE_KEY=0x....       <- the key for your WL wallet (see Step 6)
    ALCHEMY_URL=https://...  <- paste the FULL url from your Alchemy app (see Step 7)
    PRICE_PER_UNIT_ETH=0     <- the mint price per NFT, from the mint page. 0 if free.
    MINT_QUANTITY=1          <- how many to mint
    MAX_GAS_USD=15           <- hard ceiling on gas spend

Leave the rest as-is for now. Save the file.

### Step 6. Where do I get PRIVATE_KEY?
From the wallet that holds your allowlist spot.
- MetaMask: click the 3 dots -> Account details -> Show private key -> type your
  password -> copy the 0x... string -> paste into PRIVATE_KEY in `.env`.
- USE A BURNER: ideally this wallet holds ONLY the WL spot + a little ETH for the
  mint and gas. Never your main wallet.

### Step 7. Where do I get ALCHEMY_URL?
- Go to alchemy.com, sign up / log in.
- Create App -> choose chain/network "Robinhood Chain" -> Mainnet.
- Open the app -> "API Key" or "Endpoints" -> copy the full https URL it shows
  (looks like https://robinhood-mainnet.g.alchemy.com/v2/XXXXXXXX).
- Paste that WHOLE url into ALCHEMY_URL in `.env`.
- (If you pasted a key in a chat earlier, click "Reset/rotate key" first and use
  the new one. A shared key should be treated as burned.)

### Step 8. READ-ONLY check — is the sale real and am I eligible?

    npm run inspect

This does NOT spend anything. It reads the chain and prints: chainId (should be
4663), your wallet + balance, whether the sale is live, supply left, and most
importantly `mintableBy(you)`. If that is 0 or false, your wallet is NOT on the
allowlist and the mint would fail no matter what — sort that before going further.

### Step 9. Open the 90s control panel

    npm run ui

You'll see: "running on 127.0.0.1:4663". Open a browser to:

    http://localhost:4663

That's your dashboard. Click **Refresh** to load the chain state. Click
**Dry run** to build+price a mint without sending it. When the sale is live and
Dry run looks clean, click **MINT** (it asks you to confirm).

>>> If you only mint from your laptop, YOU ARE DONE. Part 2 is optional speed. <<<

--------------------------------------------------------------------
## PART 2 — (Optional) Run it on AWS near the Ohio sequencer
--------------------------------------------------------------------

Only do this if `npm run inspect` shows the mint is actually contested (lots of
demand vs allowlist supply). Otherwise it's effort for no gain.

The point: the sequencer is in AWS Ohio (us-east-2). A server there reaches it in
~3ms vs ~50-200ms from home. Ordering is first-come-first-served, so being early
is the ONLY edge — gas can't buy priority.

### Step A. Launch a server in Ohio
1. Log into AWS console.
2. TOP-RIGHT region selector -> choose "US East (Ohio) us-east-2". THIS is the
   step that gives you the edge. Get it wrong and the whole exercise is pointless.
3. EC2 -> Launch instance.
   - Name: rh-minter
   - OS: Ubuntu (latest LTS)
   - Type: t3.micro (fine)
   - Key pair: Create new -> download the .pem file, keep it safe.
   - Network/Security group: allow SSH (port 22) from "My IP" only.
     Do NOT open any other ports to the world.
4. Launch. Note the instance's Public IPv4 address.

### Step B. Connect to it (from your laptop terminal)
Mac/Linux:
    chmod 400 your-key.pem
    ssh -i your-key.pem ubuntu@YOUR_PUBLIC_IP
Windows (PowerShell): same ssh command works on Windows 10/11.

### Step C. Install Node + git on the server

    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs git

### Step D. Get the project onto the server
Easiest: from your LAPTOP terminal (not the server), copy the folder up:

    scp -i your-key.pem -r ./rh-minter ubuntu@YOUR_PUBLIC_IP:~

### Step E. Set it up ON the server
Back in the SSH session:

    cd rh-minter
    npm install
    cp .env.example .env
    nano .env        # paste the SAME values as your laptop .env, then Ctrl-O, Enter, Ctrl-X

### Step F. Run it WITHOUT exposing it to the internet (safest)
Two ways to do the env/keys — you do NOT put them in the website:

Option 1 (simple): keep them in `.env` on the server (Step E). Then:
  On the server:   npm run ui
  This binds to localhost on the server only.

Then, from your LAPTOP, make a private tunnel so you can see the dashboard:
    ssh -i your-key.pem -L 4663:localhost:4663 ubuntu@YOUR_PUBLIC_IP

Now open http://localhost:4663 on your laptop. The UI is RUNNING in Ohio, but only
YOU can see it, through the encrypted SSH tunnel. Nothing is public. This is best.

### Step G. Mint, then shut it down
Use the dashboard exactly like on your laptop (Refresh -> Dry run -> MINT).
When the mint is done: AWS console -> EC2 -> select the instance -> Terminate,
so you stop paying (it's pennies/hour, but still).

--------------------------------------------------------------------
## Do I ever type keys into the website? NO.
--------------------------------------------------------------------
Keys live in `.env` (or, if you host publicly, in the platform's "Variables"
boxes). The server reads them and signs transactions server-side. The webpage only
sends "start dry run" / "start mint" commands. Your key never touches the browser.

If you host the UI on a PUBLIC url (Railway, or an EC2 port open to the world),
you MUST set DASH_TOKEN to a long random string and open the page as
`?token=YOUR_TOKEN`, or a stranger who finds the URL could press MINT with your
wallet. The SSH-tunnel method above avoids this entirely by never being public.

--------------------------------------------------------------------
## IMPORTANT: this is a thirdweb Drop (updated facts)
--------------------------------------------------------------------
- The mint function is `claim(...)`, NOT `mint`. The bot now calls it correctly.
- Contract is 0x51363a6520563Be4D029E9e7523d9F348A21298A (the one you minted through).
- Price and currency are read LIVE from the active claim condition — you don't set
  a price in .env. Whatever the current phase charges is what the bot sends.
- Phases = "claim conditions". `npm run inspect` shows the active phase, its price,
  how many remain, the per-wallet limit, and whether it's ALLOWLIST-GATED.
- ALLOWLIST-GATED phases need a merkle proof that only the official mint site /
  project can give you. The bot sends an EMPTY (public) proof, which works ONLY for
  public phases (like the 7PM FCFS "all others" phase). If inspect says the active
  phase is allowlist-gated, an empty-proof claim will revert — mint via the official
  site for that phase, or get the proof from the project.
