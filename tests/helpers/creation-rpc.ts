import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toBytes,
  type PublicClient,
} from "viem";
import type { CreationIntent } from "../../packages/ports/src/index.js";
const abi = parseAbi([
  "function createMarket(bytes32 specHash,string specURI,uint8 mode,uint64 closeAt,uint64 proposalDeadline,uint64 hardDeadline,uint32 challengeSeconds,uint64 maxPairs,uint64 maxTakerShares) returns (uint256)",
  "event MarketCreated(uint256 indexed marketId,bytes32 indexed specHash,string specURI,uint8 mode,uint64 closeAt,uint64 proposalDeadline,uint64 hardDeadline,uint32 challengeSeconds,uint64 maxPairs,uint64 maxTakerShares)",
]);
export const hashOf = (text: string) => keccak256(toBytes(text));
export function creationRpc(intent: CreationIntent) {
  const txHash = hashOf("creation transaction");
  const args = decodeFunctionData({
    abi,
    data: intent.calldata as `0x${string}`,
  }).args;
  const canonical = new Map<bigint, `0x${string}`>();
  const blockHash = (height: bigint) =>
    canonical.get(height) ?? hashOf("block-" + height);
  function mine(height: bigint, marketId = 9007199254740993n) {
    const hash = blockHash(height);
    const log = {
      address: intent.to,
      blockHash: hash,
      blockNumber: height,
      transactionHash: txHash,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
      topics: encodeEventTopics({
        abi,
        eventName: "MarketCreated",
        args: { marketId, specHash: args[0] },
      }),
      data: encodeAbiParameters(
        parseAbiParameters(
          "string,uint8,uint64,uint64,uint64,uint32,uint64,uint64",
        ),
        args.slice(1) as [
          string,
          number,
          bigint,
          bigint,
          bigint,
          number,
          bigint,
          bigint,
        ],
      ),
    };
    return {
      tx: {
        hash: txHash,
        to: intent.to,
        from: intent.requiredSender,
        value: 0n,
        input: intent.calldata,
        blockHash: hash,
        blockNumber: height,
      },
      receipt: {
        transactionHash: txHash,
        to: intent.to,
        from: intent.requiredSender,
        blockHash: hash,
        blockNumber: height,
        status: "success",
        logs: [log],
      },
    };
  }
  const first = mine(10n);
  const state: {
    head: bigint;
    tx: typeof first.tx | null;
    receipt: typeof first.receipt | null;
    chainId: number;
    code: `0x${string}`;
    fail: boolean;
  } = { head: 10n, ...first, chainId: 84532, code: "0x6000", fail: false };
  const notFound = (name: string): never => {
    const error = new Error(name);
    error.name = name;
    throw error;
  };
  const client = {
    async getChainId() {
      if (state.fail) throw new Error("RPC unavailable");
      return state.chainId;
    },
    async getBlock(q: { blockNumber?: bigint }) {
      if (state.fail) throw new Error("RPC unavailable");
      const number = q.blockNumber ?? state.head;
      return { number, hash: blockHash(number) };
    },
    async getTransaction() {
      return state.tx ?? notFound("TransactionNotFoundError");
    },
    async getTransactionReceipt() {
      return state.receipt ?? notFound("TransactionReceiptNotFoundError");
    },
    async getCode() {
      return state.code;
    },
  } as unknown as PublicClient;
  return { client, state, canonical, mine, txHash };
}
