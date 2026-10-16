import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { chainSnapshotReader } from "../packages/adapters/src/chain-snapshot-reader.js";

test("snapshot reader refuses an RPC chain change before head or contract reads", async () => {
  let chainId = 84532;
  let reads = 0;
  const reader = chainSnapshotReader({
    market: `0x${"11".repeat(20)}`,
    client: {
      getChainId: async () => chainId,
      getBlock: async () => {
        reads++;
        return { number: 1n, hash: `0x${"22".repeat(32)}`, timestamp: 1n };
      },
      request: async () => {
        reads++;
        throw new Error("unexpected contract read");
      },
    } as unknown as PublicClient,
  });
  await reader.head();
  assert.equal(reads, 1);
  for (const [id, code] of [
    [8453, "MAINNET_REFUSED"],
    [1, "CHAIN_NOT_ALLOWED"],
  ] as const) {
    chainId = id;
    await assert.rejects(reader.head(), new RegExp(code));
    await assert.rejects(
      reader.read({
        blockHash: `0x${"22".repeat(32)}`,
        marketId: 1n,
        taker: `0x${"11".repeat(20)}`,
      }),
      new RegExp(code),
    );
    assert.equal(reads, 1);
  }
});
