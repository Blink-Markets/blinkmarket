import {
  decodeFunctionData,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  BlockNotFoundError,
  type Abi,
  type PublicClient,
  type Hex,
} from "viem";
import type { ProtocolDeployment } from "@blink/schemas";
import type {
  TrackedContract,
  TxReceiptReader,
  TxObservation,
} from "@blink/ports";
import { protocolAbi } from "./protocol-abi.js";

// The function name is decoded from the protocol ABI of the contract the transaction targets.
/** The tracked contract at `to`: the current generation's, the faucet or the anchor; else null. */
export function trackedContract(
  manifest: ProtocolDeployment,
  to: string | null,
): TrackedContract | null {
  if (!to) return null;
  const slots: [TrackedContract, string][] = [
    ["registry", manifest.generation.registry],
    ["jurors", manifest.generation.jurors],
    ["markets", manifest.generation.markets],
    ["resolution", manifest.generation.resolution],
    ["faucet", manifest.shared.faucet],
    ["anchor", manifest.shared.anchor],
  ];
  return (
    slots.find(([, address]) => address.toLowerCase() === to.toLowerCase())?.[0] ??
    null
  );
}
// The market a markets-contract call acts on, where the call names one.
function marketIdOf(
  contract: TrackedContract,
  decoded: { functionName: string; args?: readonly unknown[] | undefined },
): string | undefined {
  if (contract !== "markets") return undefined;
  const first = decoded.args?.[0];
  if (decoded.functionName === "redeem" && typeof first === "bigint")
    return first.toString();
  if (
    decoded.functionName === "fillQuote" &&
    typeof first === "object" &&
    first !== null &&
    "marketId" in first &&
    typeof first.marketId === "bigint"
  )
    return first.marketId.toString();
  return undefined;
}

export function txReceiptReader(client: PublicClient): TxReceiptReader {
  async function canonical(number: string, hash: string) {
    try {
      const block = await client.getBlock({ blockNumber: BigInt(number) });
      return block.hash?.toLowerCase() === hash.toLowerCase();
    } catch (error) {
      if (error instanceof BlockNotFoundError) return false;
      throw error;
    }
  }
  return {
    async read(row, manifest) {
      const chainId = await client.getChainId();
      if (chainId === 8453) throw new Error("MAINNET_REFUSED");
      if (chainId !== 84532) throw new Error("DEPLOYMENT_MISMATCH");
      let tx: Awaited<ReturnType<typeof client.getTransaction>> | null = null;
      let receipt: Awaited<
        ReturnType<typeof client.getTransactionReceipt>
      > | null = null;
      try {
        tx = await client.getTransaction({ hash: row.txHash as Hex });
      } catch (error) {
        if (!(error instanceof TransactionNotFoundError)) throw error;
      }
      try {
        receipt = await client.getTransactionReceipt({
          hash: row.txHash as Hex,
        });
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      }
      if (tx?.chainId === 8453) throw new Error("MAINNET_REFUSED");
      if (
        tx?.chainId !== undefined &&
        tx.chainId !== null &&
        tx.chainId !== 84532
      )
        throw new Error("DEPLOYMENT_MISMATCH");
      if (
        (tx && tx.hash.toLowerCase() !== row.txHash.toLowerCase()) ||
        (receipt &&
          receipt.transactionHash.toLowerCase() !== row.txHash.toLowerCase())
      )
        throw new Error("RPC_TRANSACTION_MISMATCH");
      let transaction: TxObservation["transaction"] = null;
      if (tx) {
        const contract = trackedContract(manifest, tx.to);
        transaction = { from: tx.from, to: tx.to, contract, action: null };
        if (contract) {
          try {
            const decoded = decodeFunctionData({
              abi: protocolAbi[contract] as Abi,
              data: tx.input,
            });
            transaction = { ...transaction, action: decoded.functionName };
            const marketId = marketIdOf(contract, decoded);
            if (marketId !== undefined) transaction = { ...transaction, marketId };
          } catch {
            /* Unrecognized or malformed calldata remains an action mismatch. */
          }
        }
      }
      let finalizedNumber: string | null = null;
      // Finality is optional. An unsupported tag or unavailable provider never fabricates it.
      try {
        finalizedNumber =
          (
            await client.getBlock({ blockTag: "finalized" })
          ).number?.toString() ?? null;
      } catch {
        /* UNKNOWN finality */
      }
      return {
        chainId,
        transaction,
        receipt: receipt
          ? {
              blockHash: receipt.blockHash,
              blockNumber: receipt.blockNumber.toString(),
              success: receipt.status === "success",
              canonical: await canonical(
                receipt.blockNumber.toString(),
                receipt.blockHash,
              ),
            }
          : null,
        previousCanonical:
          row.receiptBlockHash && row.receiptBlockNumber
            ? await canonical(row.receiptBlockNumber, row.receiptBlockHash)
            : null,
        finalizedNumber,
      };
    },
  };
}
