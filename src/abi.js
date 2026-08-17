// Script Kiddies is a thirdweb DropERC721. Standard, well-known interface.
// Confirmed from the on-chain TokensClaimed event + thirdweb published source.
export const ABI = [
  // The claim (mint) call.
  'function claim(address receiver, uint256 quantity, address currency, uint256 pricePerToken, (bytes32[] proof, uint256 quantityLimitPerWallet, uint256 pricePerToken, address currency) allowlistProof, bytes data) payable',

  // Claim-condition reads (thirdweb standard).
  'function getActiveClaimConditionId() view returns (uint256)',
  'function claimCondition() view returns (uint256 currentStartId, uint256 count)',
  'function getClaimConditionById(uint256 conditionId) view returns ((uint256 startTimestamp, uint256 maxClaimableSupply, uint256 supplyClaimed, uint256 quantityLimitPerWallet, bytes32 merkleRoot, uint256 pricePerToken, address currency, string metadata) condition)',
  'function getSupplyClaimedByWallet(uint256 conditionId, address claimer) view returns (uint256)',

  // ERC721 supply / ownership.
  'function totalSupply() view returns (uint256)',
  'function nextTokenIdToClaim() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function name() view returns (string)',
];

// thirdweb's canonical "no allowlist" sentinel values (from thirdweb docs).
export const NATIVE_CURRENCY = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const EMPTY_PROOF = ['0x0000000000000000000000000000000000000000000000000000000000000000'];
