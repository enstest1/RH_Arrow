// Manual mint builder: user supplies the function signature and how to fill its args.
// This handles the "I found the function myself" path for any simple mint function.
import { ethers } from 'ethers';

// signature examples: "mint(uint256)", "mintTo(address,uint256)", "claim(address,uint256)"
// argPlan maps each parameter to a source:
//   "quantity" -> the qty number
//   "recipient" -> the wallet address
//   "price"     -> pricePerToken in wei (rarely an arg)
//   literal     -> a literal value you type (address/number/bool/bytes)
// If a param isn't mapped, we try to infer: uint->quantity, address->recipient.
export function buildManual(signature, receiver, qty, priceEth, argPlan) {
  const sig = signature.trim();
  const iface = new ethers.Interface([`function ${sig} payable`]);
  const fnName = sig.split('(')[0].trim();
  const frag = iface.getFunction(fnName);
  const args = frag.inputs.map((inp, i) => {
    const plan = argPlan?.[i];
    if (plan && plan.source === 'quantity') return qty;
    if (plan && plan.source === 'recipient') return receiver;
    if (plan && plan.source === 'literal') return coerce(inp.type, plan.value);
    // inference fallback
    if (inp.type.startsWith('uint')) return qty;          // most single-uint mints = quantity
    if (inp.type === 'address') return receiver;          // address arg = recipient
    if (inp.type === 'bool') return false;
    if (inp.type.startsWith('bytes')) return '0x';
    throw new Error(`Don't know how to fill arg ${i} (${inp.type} ${inp.name||''}). Map it explicitly.`);
  });
  const value = ethers.parseEther(String(priceEth ?? '0')) * qty;
  const data = iface.encodeFunctionData(fnName, args);
  return { fn: fnName, args, value, data,
    notes: [`manual: ${sig}`, `args: [${args.map(String).join(', ')}]`,
            `value ${ethers.formatEther(value)} ETH`] };
}

function coerce(type, v){
  if (type.startsWith('uint') || type.startsWith('int')) return BigInt(v);
  if (type === 'bool') return v === true || v === 'true';
  return v; // address / bytes / string pass through
}
