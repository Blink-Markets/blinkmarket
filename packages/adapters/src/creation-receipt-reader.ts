import {
  decodeEventLog,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type PublicClient,
  type Hash,
} from "viem";
import type { CreationReceiptReader, CreationObservation } from "@blink/ports";

const abi = parseAbi([
  "function createMarket(bytes32 specHash,string specURI,uint8 mode,uint64 closeAt,uint64 proposalDeadline,uint64 hardDeadline,uint32 challengeSeconds,uint64 maxPairs,uint64 maxTakerShares) returns (uint256)",
  "event MarketCreated(uint256 indexed marketId,bytes32 indexed specHash,string specURI,uint8 mode,uint64 closeAt,uint64 proposalDeadline,uint64 hardDeadline,uint32 challengeSeconds,uint64 maxPairs,uint64 maxTakerShares)",
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const missing = (error: unknown, name: string) =>
  error instanceof Error && error.name === name;

export function creationReceiptReader(
  clientOrFactory: PublicClient | ((signal?: AbortSignal) => PublicClient),
): CreationReceiptReader {
  return {
    async observe(creation, hash, signal) {
      const client =
        typeof clientOrFactory === "function"
          ? clientOrFactory(signal)
          : clientOrFactory;
      if (signal?.aborted) throw new Error("CREATION_RECONCILIATION_ABORTED");
      const { intent, manifest, status: previous } = creation;
      if (
        (await client.getChainId()) !== 84532 ||
        manifest.chainId !== 84532 ||
        intent.chainId !== 84532 ||
        manifest.deploymentId !== intent.deploymentId ||
        !same(intent.to, manifest.contracts.BlinkMarket) ||
        !same(intent.requiredSender, manifest.roles.admin)
      )
        throw new Error("CREATION_DEPLOYMENT_MISMATCH");
      const head = await client.getBlock({ blockTag: "latest" });
      if (!head.hash) throw new Error("MISSING_CANONICAL_HEAD");
      if (previous.headNumber && head.number < BigInt(previous.headNumber))
        throw new Error("CREATION_HEAD_REGRESSED");
      const base: CreationObservation = {
        state: "UNKNOWN",
        txHash: hash,
        marketId: null,
        blockNumber: null,
        blockHash: null,
        headNumber: head.number.toString(),
        headHash: head.hash,
        confirmations: "0",
        requiredConfirmations: 12,
      };
      const stable = async () => {
        if (
          (await client.getBlock({ blockNumber: head.number })).hash !==
          head.hash
        )
          throw new Error("REORG_DURING_CREATION_CHECK");
      };
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: hash as Hash });
      } catch (error) {
        if (!missing(error, "TransactionReceiptNotFoundError")) throw error;
      }
      let tx;
      try {
        tx = await client.getTransaction({ hash: hash as Hash });
      } catch (error) {
        if (!missing(error, "TransactionNotFoundError")) throw error;
      }
      if (
        tx &&
        (!same(tx.hash, hash) ||
          !tx.to ||
          !same(tx.to, intent.to) ||
          !same(tx.from, intent.requiredSender) ||
          tx.value !== 0n ||
          !same(tx.input, intent.calldata))
      )
        throw new Error("CREATION_TRANSACTION_MISMATCH");
      if (!receipt) {
        if (!previous.txHash && !tx)
          throw new Error("CREATION_TRANSACTION_NOT_FOUND");
        if (previous.blockNumber && previous.blockHash) {
          base.blockNumber = previous.blockNumber;
          base.blockHash = previous.blockHash;
          const height = BigInt(previous.blockNumber);
          const orphaned =
            height > head.number ||
            !same(
              (await client.getBlock({ blockNumber: height })).hash!,
              previous.blockHash,
            );
          if (orphaned) base.state = "REORGED";
          else if (
            previous.state === "INCLUDED" ||
            previous.state === "CONFIRMED" ||
            previous.state === "REVERTED"
          ) {
            await stable();
            throw new Error("CREATION_RECEIPT_INDETERMINATE");
          }
        } else if (previous.state === "REORGED") base.state = "REORGED";
        await stable();
        return base;
      }
      if (
        !tx ||
        !same(receipt.transactionHash, hash) ||
        !receipt.to ||
        !same(receipt.to, intent.to) ||
        !same(receipt.from, intent.requiredSender) ||
        tx.blockHash !== receipt.blockHash ||
        tx.blockNumber !== receipt.blockNumber
      )
        throw new Error("CREATION_RECEIPT_MISMATCH");
      if (receipt.blockNumber < BigInt(manifest.deploymentBlock))
        throw new Error("CREATION_BEFORE_DEPLOYMENT");
      base.blockNumber = receipt.blockNumber.toString();
      base.blockHash = receipt.blockHash;
      if (receipt.blockNumber > head.number)
        throw new Error("CREATION_HEAD_BEHIND_RECEIPT");
      if (
        (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !==
        receipt.blockHash
      ) {
        await stable();
        return { ...base, state: "REORGED" };
      }
      const code = await client.getCode({
        address: intent.to as `0x${string}`,
        blockNumber: receipt.blockNumber,
      });
      if (
        !code ||
        keccak256(code) !== manifest.artifacts.bytecodeHashes.BlinkMarket
      )
        throw new Error("CREATION_BYTECODE_MISMATCH");
      base.confirmations = (head.number - receipt.blockNumber + 1n).toString();
      if (receipt.status !== "success" && receipt.status !== "reverted")
        throw new Error("INVALID_CREATION_RECEIPT_STATUS");
      if (receipt.status === "reverted") base.state = "REVERTED";
      else {
        const events = [];
        for (const log of receipt.logs) {
          if (!same(log.address, intent.to)) continue;
          try {
            const decoded = decodeEventLog({
              abi,
              eventName: "MarketCreated",
              data: log.data,
              topics: log.topics,
              strict: true,
            });
            if (decoded.eventName === "MarketCreated")
              events.push({ log, args: decoded.args });
          } catch {
            /* Non-MarketCreated logs are not evidence of creation. */
          }
        }
        if (events.length !== 1)
          throw new Error("CREATION_EVENT_MISSING_OR_AMBIGUOUS");
        const { log, args } = events[0]!;
        if (
          log.removed ||
          log.blockHash !== receipt.blockHash ||
          log.transactionHash !== receipt.transactionHash ||
          log.blockNumber !== receipt.blockNumber ||
          args.marketId === 0n
        )
          throw new Error("CREATION_EVENT_MISMATCH");
        const encoded = encodeFunctionData({
          abi,
          functionName: "createMarket",
          args: [
            args.specHash,
            args.specURI,
            args.mode,
            args.closeAt,
            args.proposalDeadline,
            args.hardDeadline,
            args.challengeSeconds,
            args.maxPairs,
            args.maxTakerShares,
          ],
        });
        if (
          !same(encoded, intent.calldata) ||
          !same(args.specHash, intent.specHash) ||
          args.specURI !== intent.specUri
        )
          throw new Error("CREATION_EVENT_MISMATCH");
        base.state =
          BigInt(base.confirmations) >= 12n ? "CONFIRMED" : "INCLUDED";
        base.marketId = args.marketId.toString();
      }
      // Recheck both anchors after all transaction/event/code reads.
      if (
        (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !==
        receipt.blockHash
      )
        throw new Error("REORG_DURING_CREATION_CHECK");
      await stable();
      return base;
    },
  };
}
