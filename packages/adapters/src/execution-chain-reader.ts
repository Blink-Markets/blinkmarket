import { createPublicClient, http, type Address } from "viem";
import type { DispatchRpc, ExecutionChainReader } from "@blink/ports";
import { blinkMarketAbi } from "./blink-abi.js";

export function executionChainReader(options: {
  url: string;
  marketAddress: string;
}): ExecutionChainReader & {
  assertChain(): Promise<void>;
  guardDispatch(rpc: DispatchRpc): DispatchRpc;
} {
  const client = createPublicClient({
    transport: http(options.url, { timeout: 5000, retryCount: 0 }),
    cacheTime: 0,
  });
  const assertChain = async () => {
    const chainId = await client.getChainId();
    if (chainId === 8453) throw new Error("MAINNET_REFUSED");
    if (chainId !== 84532) throw new Error("CHAIN_NOT_ALLOWED");
  };
  return {
    assertChain,
    async marketState(marketId) {
      await assertChain();
      const market = (await client.readContract({
        address: options.marketAddress as Address,
        abi: blinkMarketAbi,
        functionName: "getMarket",
        args: [BigInt(marketId)],
        blockTag: "latest",
      })) as { state: number };
      const state = (["OPEN", "PROPOSED", "DISPUTED", "FINAL"] as const)[
        market.state
      ];
      if (!state) throw new Error("INVALID_MARKET_STATE");
      return state;
    },
    async blockTimestamp(number) {
      await assertChain();
      return (await client.getBlock({ blockNumber: number })).timestamp;
    },
    guardDispatch(rpc) {
      return {
        async sendRawTransaction(raw) {
          await assertChain();
          return rpc.sendRawTransaction(raw);
        },
        async getReceipt(hash) {
          await assertChain();
          return rpc.getReceipt(hash);
        },
        async blockHashAt(number) {
          await assertChain();
          return rpc.blockHashAt(number);
        },
        async finalizedBlockNumber() {
          await assertChain();
          return rpc.finalizedBlockNumber();
        },
      };
    },
  };
}
