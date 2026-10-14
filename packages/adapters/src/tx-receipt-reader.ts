import {
  decodeFunctionData,
  hashTypedData,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  BlockNotFoundError,
  type PublicClient,
  type Hex,
} from "viem";
import { quoteTypes } from "@blink/schemas";
import type { TxReceiptReader, TxObservation } from "@blink/ports";
import { blinkMarketAbi, blinkTestUsdAbi } from "./blink-abi.js";

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
        transaction = { from: tx.from, to: tx.to, action: null };
        try {
          if (row.action === "APPROVE") {
            const decoded = decodeFunctionData({
              abi: blinkTestUsdAbi,
              data: tx.input,
            });
            if (decoded.functionName === "approve")
              transaction = {
                ...transaction,
                action: "APPROVE",
                spender: decoded.args[0],
              };
          } else {
            const decoded = decodeFunctionData({
              abi: blinkMarketAbi,
              data: tx.input,
            });
            if (decoded.functionName === "redeem")
              transaction = {
                ...transaction,
                action: "REDEEM",
                marketId: decoded.args[0].toString(),
              };
            else if (decoded.functionName === "fillQuote") {
              const quote = decoded.args[0];
              transaction = {
                ...transaction,
                action: "FILL",
                marketId: quote.marketId.toString(),
                quoteDigest: hashTypedData({
                  domain: {
                    name: "Blink RFQ",
                    version: "0.1",
                    chainId: 84532,
                    verifyingContract: manifest.contracts.BlinkMarket as Hex,
                  },
                  types: quoteTypes,
                  primaryType: "Quote",
                  message: quote,
                }),
              };
            }
          }
        } catch {
          /* Unrecognized or malformed calldata remains an action mismatch. */
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
