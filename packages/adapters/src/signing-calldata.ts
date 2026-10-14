import { encodeFunctionData } from "viem";
import type { CallEncoder, Hex } from "@blink/ports";
import { blinkMarketAbi, blinkTestUsdAbi } from "./blink-abi.js";

// The signer encodes calldata itself from the canonical ABI; callers never send calldata.
export const encodeAllowedCall: CallEncoder = (call) => {
  switch (call.functionName) {
    case "approve":
      return encodeFunctionData({
        abi: blinkTestUsdAbi,
        functionName: "approve",
        args: [call.args[0] as Hex, call.args[1]],
      });
    case "mint":
      return encodeFunctionData({
        abi: blinkTestUsdAbi,
        functionName: "mint",
        args: [call.args[0] as Hex, call.args[1]],
      });
    case "fillQuote": {
      const [q, signature] = call.args;
      return encodeFunctionData({
        abi: blinkMarketAbi,
        functionName: "fillQuote",
        args: [
          {
            marketId: q.marketId,
            specHash: q.specHash as Hex,
            maker: q.maker as Hex,
            taker: q.taker as Hex,
            side: q.side,
            quantity: q.quantity,
            priceBps: Number(q.priceBps),
            validAfter: q.validAfter,
            expiresAt: q.expiresAt,
            nonce: q.nonce,
            epoch: q.epoch,
          },
          signature as Hex,
        ],
      });
    }
    case "redeem":
    case "finalizeUnchallenged":
    case "finalizeTimeout":
      return encodeFunctionData({
        abi: blinkMarketAbi,
        functionName: call.functionName,
        args: [call.args[0]],
      });
  }
};
