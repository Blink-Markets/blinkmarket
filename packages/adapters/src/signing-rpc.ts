import {
  createPublicClient,
  http,
  BaseError,
  HttpRequestError,
  TimeoutError,
  type PublicClient,
} from "viem";
import type {
  DispatchReceipt,
  DispatchRpc,
  Hex,
  SendRawResult,
  SignerRpc,
} from "@blink/ports";
import { oracleL1Fee } from "./gas-oracle.js";

const unavailable = () => new Error("RPC_UNAVAILABLE");
function isTransportError(error: unknown) {
  return (
    error instanceof BaseError &&
    error.walk(
      (e) => e instanceof HttpRequestError || e instanceof TimeoutError,
    ) !== null
  );
}
// Transport failures say nothing about the request, so they surface as one retryable code.
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isTransportError(error)) throw unavailable();
    throw error;
  }
}
const client = (url: string, timeoutMs: number): PublicClient =>
  createPublicClient({
    transport: http(url, { timeout: timeoutMs, retryCount: 0 }),
    cacheTime: 0,
  });

export function viemSignerRpc(options: {
  url: string;
  timeoutMs?: number;
}): SignerRpc {
  const c = client(options.url, options.timeoutMs ?? 5000);
  return {
    chainId: () => guarded(() => c.getChainId()),
    estimateGas: ({ from, to, data }) =>
      guarded(() => c.estimateGas({ account: from, to, data, value: 0n })),
    async baseFeePerGas() {
      const block = await guarded(() => c.getBlock({ blockTag: "latest" }));
      if (block.baseFeePerGas == null) throw new Error("BASE_FEE_UNAVAILABLE");
      return block.baseFeePerGas;
    },
    maxPriorityFeePerGas: () => guarded(() => c.estimateMaxPriorityFeePerGas()),
    async pendingNonce(address) {
      return BigInt(
        await guarded(() =>
          c.getTransactionCount({ address, blockTag: "pending" }),
        ),
      );
    },
    l1Fee: (serializedUnsigned) =>
      guarded(() => oracleL1Fee(c, serializedUnsigned)),
  };
}

const errorText = (error: unknown) =>
  error instanceof BaseError
    ? [error.shortMessage, error.details, error.message].join(" ")
    : String(error);

export function viemDispatchRpc(options: {
  url: string;
  timeoutMs?: number;
}): DispatchRpc {
  const c = client(options.url, options.timeoutMs ?? 5000);
  return {
    async sendRawTransaction(raw: Hex): Promise<SendRawResult> {
      try {
        return {
          state: "ACCEPTED",
          hash: await c.sendRawTransaction({ serializedTransaction: raw }),
        };
      } catch (error) {
        if (isTransportError(error)) throw unavailable();
        const text = errorText(error);
        if (
          /already known|known transaction|already imported|already in the (?:mem|tx)pool/i.test(
            text,
          )
        )
          return { state: "ALREADY_KNOWN" };
        if (
          /nonce too low|nonce is too low|nonce has already been used/i.test(
            text,
          )
        )
          return { state: "NONCE_TOO_LOW" };
        throw error;
      }
    },
    async getReceipt(hash): Promise<DispatchReceipt | null> {
      // Raw request: the OP Stack l1Fee field is not part of viem's generic receipt type.
      const receipt = await guarded(
        () =>
          c.request({
            method: "eth_getTransactionReceipt",
            params: [hash],
          }) as Promise<{
            status?: Hex;
            blockHash: Hex;
            blockNumber: Hex;
            gasUsed: Hex;
            effectiveGasPrice?: Hex;
            l1Fee?: Hex | null;
          } | null>,
      );
      if (!receipt) return null;
      if (receipt.status !== "0x1" && receipt.status !== "0x0")
        throw new Error("RECEIPT_STATUS_UNAVAILABLE");
      return {
        status: receipt.status === "0x1" ? "success" : "reverted",
        blockHash: receipt.blockHash,
        blockNumber: BigInt(receipt.blockNumber),
        gasSpentWei:
          BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? "0x0") +
          BigInt(receipt.l1Fee ?? "0x0"),
      };
    },
    async blockHashAt(number) {
      try {
        const block = await c.getBlock({ blockNumber: number });
        return block.hash;
      } catch (error) {
        if (error instanceof BaseError && error.name === "BlockNotFoundError")
          return null;
        if (isTransportError(error)) throw unavailable();
        throw error;
      }
    },
    async finalizedBlockNumber() {
      try {
        return (await c.getBlock({ blockTag: "finalized" })).number;
      } catch (error) {
        if (isTransportError(error)) throw unavailable();
        // A provider without a finalized tag reports no finality; it never fakes FINALIZED.
        return null;
      }
    },
  };
}
