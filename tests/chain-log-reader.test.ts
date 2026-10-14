import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type PublicClient,
} from "viem";
import { blinkMarketAbi } from "../packages/adapters/src/blink-abi.js";
import { chainLogReader } from "../packages/adapters/src/chain-log-reader.js";

const MARKET = "0x" + "aa".repeat(20);
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const named = (name: string, props: object = {}) =>
  Object.assign(new Error(name), { name, ...props });
const reader = (client: object) => chainLogReader(client as PublicClient);

const depositLog = (overrides: object = {}) => ({
  address: MARKET,
  blockHash: hash(0xb1),
  blockNumber: 12n,
  transactionHash: hash(0xc1),
  transactionIndex: 3,
  logIndex: 7,
  removed: false,
  topics: encodeEventTopics({
    abi: blinkMarketAbi,
    eventName: "MakerDeposited",
  }),
  data: encodeAbiParameters([{ type: "uint256" }], [5_000_000n]),
  ...overrides,
});
const withLogs = (logs: object[]) => ({
  getLogs: async () => logs,
  getBlock: async () => ({
    number: 12n,
    hash: hash(0xb1),
    parentHash: hash(0xb0),
    timestamp: 1234n,
  }),
});

test("logs are decoded to decimal strings and lowercase hex with the block timestamp", async () => {
  const fill = encodeEventTopics({
    abi: blinkMarketAbi,
    eventName: "QuoteFilled",
    args: {
      marketId: 1n,
      digest: hash(0xd1),
      taker: ("0x" + "b1".repeat(20)) as `0x${string}`,
    },
  });
  const data = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint8" },
      { type: "uint64" },
      { type: "uint16" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [
      ("0x" + "a1".repeat(20)) as `0x${string}`,
      0,
      10n,
      6000,
      6_000_000n,
      4_000_000n,
    ],
  );
  const [deposit, filled] = await reader(
    withLogs([depositLog(), depositLog({ topics: fill, data, logIndex: 8 })]),
  ).logs(MARKET, 1n, 20n);
  assert.deepEqual(deposit, {
    name: "MakerDeposited",
    args: { amountMicros: "5000000" },
    blockNumber: 12n,
    blockHash: hash(0xb1),
    blockTimestamp: 1234n,
    txHash: hash(0xc1),
    txIndex: 3,
    logIndex: 7,
  });
  assert.deepEqual(filled!.args, {
    marketId: "1",
    digest: hash(0xd1),
    maker: "0x" + "a1".repeat(20),
    taker: "0x" + "b1".repeat(20),
    side: "0",
    quantity: "10",
    priceBps: "6000",
    takerCost: "6000000",
    makerCost: "4000000",
  });
});

test("removed, pending, foreign and undecodable logs are rejected", async () => {
  const rejects = (log: object, code: RegExp) =>
    assert.rejects(reader(withLogs([log])).logs(MARKET, 1n, 20n), code);
  await rejects(depositLog({ removed: true }), /CHAIN_LOG_REMOVED/);
  await rejects(depositLog({ blockHash: null }), /CHAIN_LOG_PENDING/);
  await rejects(
    depositLog({ address: "0x" + "bb".repeat(20) }),
    /CHAIN_LOG_FOREIGN_ADDRESS/,
  );
  await rejects(
    depositLog({ topics: [hash(0xdead)] }),
    /CHAIN_LOG_UNDECODABLE/,
  );
  await rejects(depositLog({ data: "0x1234" }), /CHAIN_LOG_UNDECODABLE/);
});

test("the finalized tag reads as unknown only when the provider does not support it", async () => {
  const failing = (error: unknown) =>
    reader({
      getBlock: async () => {
        throw error;
      },
    });
  assert.equal(
    await failing(named("InvalidParamsRpcError", { code: -32602 })).finalized(),
    null,
  );
  assert.equal(
    await failing(
      Object.assign(new Error("wrapped"), { cause: { code: -32601 } }),
    ).finalized(),
    null,
  );
  assert.equal(await failing(named("BlockNotFoundError")).finalized(), null);
  await assert.rejects(
    failing(named("HttpRequestError", { code: 502 })).finalized(),
    /HttpRequestError/,
  );
  assert.equal(
    await reader({
      getBlock: async () => ({
        number: 7n,
        hash: hash(7),
        parentHash: hash(6),
        timestamp: 1n,
      }),
    }).finalized(),
    7n,
  );
});

test("a missing block is null and other failures propagate", async () => {
  assert.equal(
    await reader({
      getBlock: async () => {
        throw named("BlockNotFoundError");
      },
    }).block(5n),
    null,
  );
  await assert.rejects(
    reader({
      getBlock: async () => {
        throw named("TimeoutError");
      },
    }).block(5n),
    /TimeoutError/,
  );
  assert.deepEqual(
    await reader({
      getBlock: async () => ({
        number: 5n,
        hash: hash(0xab),
        parentHash: hash(4),
        timestamp: 9n,
      }),
    }).block(5n),
    { number: 5n, hash: hash(0xab), parentHash: hash(4), timestamp: 9n },
  );
});
