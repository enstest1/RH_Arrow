// Library of known NFT mint patterns. Detection matches a contract/tx against these.
// Each pattern: how to recognize it (selector or event), and how to build the call.
import { ethers } from 'ethers';

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const EMPTY_PROOF = ['0x0000000000000000000000000000000000000000000000000000000000000000'];
/** Canonical OpenSea SeaDrop deploy — same on Robinhood Chain (4663). */
export const SEADROP_ADDRESS = process.env.SEADROP_ADDRESS || '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const SEADROP_ABI = [
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  'function getCreatorPayoutAddress(address nftContract) view returns (address)',
];

export const PATTERNS = [
  {
    id: 'thirdweb-drop',
    label: 'thirdweb Drop (claim)',
    // fingerprint: emits TokensClaimed, or claim selector present
    eventSig: 'TokensClaimed(uint256,address,address,uint256,uint256)',
    abi: [
      'function claim(address receiver, uint256 quantity, address currency, uint256 pricePerToken, (bytes32[] proof, uint256 quantityLimitPerWallet, uint256 pricePerToken, address currency) allowlistProof, bytes data) payable',
      'function getActiveClaimConditionId() view returns (uint256)',
      'function getClaimConditionById(uint256 conditionId) view returns ((uint256 startTimestamp, uint256 maxClaimableSupply, uint256 supplyClaimed, uint256 quantityLimitPerWallet, bytes32 merkleRoot, uint256 pricePerToken, address currency, string metadata) condition)',
      'function getSupplyClaimedByWallet(uint256 conditionId, address claimer) view returns (uint256)',
      'function totalSupply() view returns (uint256)',
      'function balanceOf(address) view returns (uint256)',
    ],
    // reads live price+currency from active condition; returns {fn,args,value,notes}
    async build(contract, receiver, qty) {
      const id = await contract.getActiveClaimConditionId();
      const cond = await contract.getClaimConditionById(id);
      const gated = cond.merkleRoot && cond.merkleRoot !== ethers.ZeroHash;
      const allowlistProof = { proof: EMPTY_PROOF, quantityLimitPerWallet: 0n,
        pricePerToken: cond.pricePerToken, currency: cond.currency };
      const value = BigInt(cond.currency) === BigInt(NATIVE) ? BigInt(cond.pricePerToken) * qty : 0n;
      return { fn: 'claim',
        args: [receiver, qty, cond.currency, cond.pricePerToken, allowlistProof, '0x'],
        value,
        onchainPriceEth: ethers.formatEther(cond.pricePerToken),
        notes: [`phase ${id}`, `price ${ethers.formatEther(cond.pricePerToken)} ETH`,
                gated ? 'ALLOWLIST-GATED: empty proof will revert (use official site for this phase)' : 'public phase',
                `starts ${cond.startTimestamp}`],
        gated };
    },
  },
  {
    id: 'seadrop',
    label: 'OpenSea SeaDrop (mintPublic)',
    // Users call SeaDrop.mintPublic — NOT mintSeaDrop on the NFT contract.
    selector: '0x161ac21f',
    abi: [
      'function getMintStats(address minter) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)',
      'function totalSupply() view returns (uint256)',
      'function maxSupply() view returns (uint256)',
    ],
    async build(nftContract, receiver, qty) {
      const provider = nftContract.runner?.provider ?? nftContract.provider;
      const nftAddress = nftContract.target ?? nftContract.address;
      const sea = new ethers.Contract(SEADROP_ADDRESS, SEADROP_ABI, provider);
      const pd = await sea.getPublicDrop(nftAddress);
      const now = Math.floor(Date.now() / 1000);
      const price = BigInt(pd.mintPrice);
      const value = price * qty;
      // feeRecipient: zero when unrestricted; creator payout when restricted.
      let feeRecipient = ethers.ZeroAddress;
      if (pd.restrictFeeRecipients) {
        feeRecipient = await sea.getCreatorPayoutAddress(nftAddress);
      }
      const args = [nftAddress, feeRecipient, ethers.ZeroAddress, qty];
      const seaIface = new ethers.Interface(SEADROP_ABI);
      const data = seaIface.encodeFunctionData('mintPublic', args);
      const start = Number(pd.startTime);
      const end = Number(pd.endTime);
      const maxWallet = Number(pd.maxTotalMintableByWallet);
      const phase =
        now < start ? `opens in ${start - now}s` :
        now > end ? 'ENDED' :
        'PUBLIC OPEN';
      const notes = [
        'SeaDrop mintPublic → ' + SEADROP_ADDRESS.slice(0, 10) + '…',
        `price ${ethers.formatEther(price)} ETH/token`,
        `max/wallet ${maxWallet}`,
        phase,
      ];
      if (Number(qty) > maxWallet) notes.push(`⚠ qty ${qty} > max/wallet ${maxWallet} — will revert`);
      return {
        data,
        to: SEADROP_ADDRESS,
        value,
        onchainPriceEth: ethers.formatEther(price),
        notes,
        gated: false,
      };
    },
  },
  {
    id: 'mint-uint256',
    label: 'Standard mint(uint256 quantity)',
    selector: '0xa0712d68',
    abi: [
      'function mint(uint256 quantity) payable',
      'function totalSupply() view returns (uint256)',
      'function balanceOf(address) view returns (uint256)',
    ],
    async build(contract, receiver, qty, opts) {
      // price unknown from ABI alone; caller must supply PRICE_PER_UNIT_ETH
      const price = ethers.parseEther(String(opts?.priceEth ?? '0'));
      return { fn: 'mint', args: [qty], value: price * qty,
        notes: ['mint(uint256)', `sending ${ethers.formatEther(price*qty)} ETH (from your PRICE setting)`],
        gated: false };
    },
  },
  {
    id: 'mint-to',
    label: 'mintTo(address,uint256)',
    selector: '0x449a52f8',
    abi: [ 'function mintTo(address to, uint256 quantity) payable',
           'function totalSupply() view returns (uint256)' ],
    async build(contract, receiver, qty, opts) {
      const price = ethers.parseEther(String(opts?.priceEth ?? '0'));
      return { fn: 'mintTo', args: [receiver, qty], value: price * qty,
        notes: ['mintTo(address,uint256)'], gated: false };
    },
  },
];

// selector lookup for quick detection from a tx's input data
export const SELECTOR_MAP = Object.fromEntries(
  PATTERNS.filter(p=>p.selector).map(p=>[p.selector.toLowerCase(), p.id])
);

// event topic0 lookup for detection from tx logs
export const EVENT_TOPIC_MAP = Object.fromEntries(
  PATTERNS.filter(p=>p.eventSig).map(p=>[ethers.id(p.eventSig).toLowerCase(), p.id])
);

export function patternById(id){ return PATTERNS.find(p=>p.id===id); }
