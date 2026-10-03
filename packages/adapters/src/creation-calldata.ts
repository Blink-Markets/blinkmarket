import { encodeFunctionData, parseAbi } from "viem";
import type { NewMarketSpec } from "@blink/schemas";
const abi = parseAbi([
  "function createMarket(bytes32 specHash,string specURI,uint8 mode,uint64 closeAt,uint64 proposalDeadline,uint64 hardDeadline,uint32 challengeSeconds,uint64 maxPairs,uint64 maxTakerShares) returns (uint256)",
]);
export function encodeMarketCreation(
  spec: NewMarketSpec,
  hash: string,
  uri: string,
) {
  return encodeFunctionData({
    abi,
    functionName: "createMarket",
    args: [
      hash as `0x${string}`,
      uri,
      spec.mode === "LIVE" ? 0 : 1,
      BigInt(spec.closeAt),
      BigInt(spec.proposalDeadline),
      BigInt(spec.hardDeadline),
      spec.challengeSeconds,
      10000n,
      500n,
    ],
  });
}
