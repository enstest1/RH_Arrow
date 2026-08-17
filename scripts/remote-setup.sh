#!/usr/bin/env bash
# Bootstrap rh-minter on a fresh Ubuntu EC2 box (us-east-2).
# Invoked via SSH from deploy-aws.js --setup

set -euo pipefail

echo "[remote-setup] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

echo "[remote-setup] Preparing app directory..."
mkdir -p ~/rh-minter
if [ -d ~/rh-minter-tmp ]; then
  cp -r ~/rh-minter-tmp/* ~/rh-minter/
  rm -rf ~/rh-minter-tmp
fi

cd ~/rh-minter
npm install

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[remote-setup] WARNING: .env missing — edit ~/rh-minter/.env before minting"
fi

echo "[remote-setup] Latency check to Robinhood RPC..."
time curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  https://rpc.mainnet.chain.robinhood.com || true

echo "[remote-setup] Done. Run: npm run ui  (then SSH tunnel from laptop)"
