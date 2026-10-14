import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  type Hex,
  type PublicClient,
} from "viem";
import type { ChainBlock, ChainLogReader, DecodedEvent } from "@blink/ports";
import {
  blinkEventNames,
  blinkMarketAbi,
  type BlinkEventName,
} from "./blink-abi.js";

const MARKET_STATES = ["OPEN", "PROPOSED", "DISPUTED", "FINAL"] as const;
const UNSUPPORTED_RPC_CODES = new Set([-32601, -32602, -32004]);

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (
    let e = error;
    e && chain.length < 8;
    e = (e as { cause?: unknown }).cause
  )
    chain.push(e);
  return chain;
}
const named = (error: unknown, name: string) =>
  causes(error).some((e) => (e as Error).name === name);
// A provider that does not know the tag answers with a method or params error; anything else
// (timeouts, 5xx) must not read as "finality unknown".
const unsupportedTag = (error: unknown) =>
  causes(error).some((e) =>
    UNSUPPORTED_RPC_CODES.has((e as { code?: number }).code ?? 0),
  ) || named(error, "BlockNotFoundError");

const eventAbi = new Map(
  blinkMarketAbi.flatMap((item) =>
    item.type === "event" ? [[item.name, item] as const] : [],
  ),
);

// Decimal strings for integers, lowercase hex for addresses and hashes, as the reducer expects.
function decodeArgs(name: BlinkEventName, args: unknown): DecodedEvent["args"] {
  const abi = eventAbi.get(name);
  const values = (args ?? {}) as Record<string, unknown>;
  if (!abi) throw new Error("CHAIN_LOG_UNDECODABLE");
  const out: DecodedEvent["args"] = {};
  for (const input of abi.inputs) {
    const value = values[input.name!];
    if (input.type === "address" || input.type === "bytes32")
      out[input.name!] = String(value).toLowerCase();
    else if (input.type === "bool") out[input.name!] = Boolean(value);
    else if (input.type === "string") out[input.name!] = String(value);
    else if (
      input.type.startsWith("uint") &&
      (typeof value === "bigint" || typeof value === "number")
    )
      out[input.name!] = value.toString();
    else throw new Error("CHAIN_LOG_UNDECODABLE");
  }
  return out;
}

export function chainLogReader(client: PublicClient): ChainLogReader {
  const header = (b: {
    number: bigint | null;
    hash: Hex | null;
    parentHash: Hex;
    timestamp: bigint;
  }): ChainBlock => {
    if (b.number === null || b.hash === null)
      throw new Error("CHAIN_BLOCK_PENDING");
    return {
      number: b.number,
      hash: b.hash.toLowerCase(),
      parentHash: b.parentHash.toLowerCase(),
      timestamp: b.timestamp,
    };
  };
  return {
    chainId: () => client.getChainId(),
    async head() {
      const { number, hash, timestamp } = header(
        await client.getBlock({ blockTag: "latest" }),
      );
      return { number, hash, timestamp };
    },
    async finalized() {
      try {
        return header(await client.getBlock({ blockTag: "finalized" })).number;
      } catch (error) {
        if (unsupportedTag(error)) return null;
        throw error;
      }
    },
    async block(number) {
      try {
        return header(await client.getBlock({ blockNumber: number }));
      } catch (error) {
        if (named(error, "BlockNotFoundError")) return null;
        throw error;
      }
    },
    async logs(address, from, to) {
      const logs = await client.getLogs({
        address: address as Hex,
        fromBlock: from,
        toBlock: to,
      });
      const timestamps = new Map<string, bigint>();
      const events: DecodedEvent[] = [];
      for (const log of logs) {
        if (log.removed) throw new Error("CHAIN_LOG_REMOVED");
        if (
          log.blockHash === null ||
          log.blockNumber === null ||
          log.transactionHash === null ||
          log.transactionIndex === null ||
          log.logIndex === null
        )
          throw new Error("CHAIN_LOG_PENDING");
        if (log.address.toLowerCase() !== address.toLowerCase())
          throw new Error("CHAIN_LOG_FOREIGN_ADDRESS");
        let decoded;
        try {
          decoded = decodeEventLog({
            abi: blinkMarketAbi,
            data: log.data,
            topics: log.topics,
            strict: true,
          });
        } catch {
          throw new Error("CHAIN_LOG_UNDECODABLE");
        }
        const name = decoded.eventName as string;
        if (!(blinkEventNames as readonly string[]).includes(name))
          throw new Error("CHAIN_LOG_UNDECODABLE");
        const blockHash = log.blockHash.toLowerCase();
        if (!timestamps.has(blockHash))
          timestamps.set(
            blockHash,
            header(await client.getBlock({ blockHash: log.blockHash }))
              .timestamp,
          );
        events.push({
          name: name as BlinkEventName,
          args: decodeArgs(name as BlinkEventName, decoded.args),
          blockNumber: log.blockNumber,
          blockHash,
          blockTimestamp: timestamps.get(blockHash)!,
          txHash: log.transactionHash.toLowerCase(),
          txIndex: log.transactionIndex,
          logIndex: log.logIndex,
        });
      }
      return events;
    },
    async views(address, blockHash, marketIds) {
      // EIP-1898: the call is pinned to the block hash and fails if that block left the canonical chain.
      const read = async (
        functionName: string,
        args: readonly unknown[] = [],
      ) => {
        const data = encodeFunctionData({
          abi: blinkMarketAbi,
          functionName,
          args,
        } as never);
        const result = (await client.request({
          method: "eth_call",
          params: [
            { to: address as Hex, data },
            { blockHash: blockHash as Hex, requireCanonical: true },
          ],
        })) as Hex;
        return decodeFunctionResult({
          abi: blinkMarketAbi,
          functionName,
          data: result,
        } as never) as unknown;
      };
      const markets = new Map<
        string,
        { totalPairs: bigint; escrowMicros: bigint; state: string }
      >();
      for (const id of marketIds) {
        const market = (await read("getMarket", [id])) as {
          totalMintedPairs: bigint;
          escrowMicros: bigint;
          state: number;
        };
        const state = MARKET_STATES[market.state];
        if (!state) throw new Error("CHAIN_VIEW_UNDECODABLE");
        markets.set(id.toString(), {
          totalPairs: market.totalMintedPairs,
          escrowMicros: market.escrowMicros,
          state,
        });
      }
      return {
        makerFreeMicros: (await read("makerFreeBalance")) as bigint,
        epoch: (await read("currentMakerEpoch")) as bigint,
        markets,
      };
    },
  };
}
