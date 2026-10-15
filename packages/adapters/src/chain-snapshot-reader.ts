import {
  decodeFunctionResult,
  encodeFunctionData,
  type Hex,
  type PublicClient,
} from "viem";
import type { ChainSnapshotReader } from "@blink/ports";
import { blinkMarketAbi } from "./blink-abi.js";

const MARKET_STATES = ["OPEN", "PROPOSED", "DISPUTED", "FINAL"] as const;

/**
 * The RFQ's chain reads. Every contract read is an EIP-1898 `eth_call` pinned to one block hash with
 * `requireCanonical`, so a reorg between the head read and a contract read fails the request
 * instead of mixing two branches.
 */
export function chainSnapshotReader(options: {
  client: PublicClient;
  market: Hex;
}): ChainSnapshotReader {
  const { client } = options;
  return {
    chainId: () => client.getChainId(),
    async head() {
      const block = await client.getBlock({ blockTag: "latest" });
      if (block.number === null || block.hash === null)
        throw new Error("CHAIN_BLOCK_PENDING");
      return {
        number: block.number,
        hash: block.hash.toLowerCase() as Hex,
        timestamp: block.timestamp,
      };
    },
    async read({ blockHash, marketId, taker }) {
      const call = async (functionName: string, args: readonly unknown[]) => {
        const data = encodeFunctionData({
          abi: blinkMarketAbi,
          functionName,
          args,
        } as never);
        const result = (await client.request({
          method: "eth_call",
          params: [
            { to: options.market, data },
            { blockHash, requireCanonical: true },
          ],
        })) as Hex;
        return decodeFunctionResult({
          abi: blinkMarketAbi,
          functionName,
          data: result,
        } as never) as unknown;
      };
      const [market, paused, free, epoch, allowed, cumulative] =
        await Promise.all([
          call("getMarket", [marketId]) as Promise<{
            state: number;
            paused: boolean;
            closeAt: bigint;
            maxPairs: bigint;
            maxTakerShares: bigint;
            totalMintedPairs: bigint;
          }>,
          call("globalTradingPaused", []) as Promise<boolean>,
          call("makerFreeBalance", []) as Promise<bigint>,
          call("currentMakerEpoch", []) as Promise<bigint>,
          call("takerAllowed", [taker]) as Promise<boolean>,
          call("cumulativeTakerShares", [marketId, taker]) as Promise<bigint>,
        ]);
      const state = MARKET_STATES[market.state];
      if (!state) throw new Error("CHAIN_VIEW_UNDECODABLE");
      return {
        market: {
          state,
          paused: market.paused,
          closeAt: market.closeAt,
          maxPairs: market.maxPairs,
          maxTakerShares: market.maxTakerShares,
          totalMintedPairs: market.totalMintedPairs,
        },
        globalTradingPaused: paused,
        makerFreeMicros: free,
        makerEpoch: epoch,
        takerAllowed: allowed,
        cumulativeTakerShares: cumulative,
      };
    },
  };
}
