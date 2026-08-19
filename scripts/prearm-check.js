/**
 * prearm-check.js — production-environment validation. No broadcast, no ARM.
 *
 * Usage: node scripts/prearm-check.js
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { makeProvider } from '../src/provider.js';
import { runPrearm } from '../src/prearm.js';
import { getSettings } from '../src/autostate.js';

const pk = process.env.PRIVATE_KEY;
const provider = makeProvider();
let wallet = null;
if (pk && !pk.includes('YOUR')) {
  wallet = new ethers.Wallet(pk, provider);
}

const result = await runPrearm({
  provider,
  wallet,
  settings: getSettings(),
});
console.log(result.text);
process.exit(result.ok ? 0 : 1);
