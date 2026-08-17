#!/usr/bin/env bash
# Run this ON the Ohio box (after scp'ing the project up) to install Node + deps.
set -euo pipefail
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
cd ~/rh-minter
npm install
[ -f .env ] || cp .env.example .env
echo ""
echo "✅ Installed. Now: nano .env  (fill PRIVATE_KEY, ALCHEMY_URL, etc.)"
echo "   Then: npm run ui   (binds localhost)"
echo "   From your laptop, tunnel:  ssh -i KEY.pem -L 4663:localhost:4663 ubuntu@THIS_IP"
