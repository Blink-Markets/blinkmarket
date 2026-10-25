import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeFunctionData,
  hashTypedData,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type PublicClient,
  type Hex,
} from "viem";
import { fixture, hash, address } from "./helpers/market-read.js";
import { inviteAgent, bindWallet } from "./helpers/database.js";
import {
  apiContracts,
  DeploymentManifest,
  quoteTypes,
} from "../packages/schemas/src/index.js";
import { deploymentFixture } from "./helpers/deployment-fixture.js";
import { protocolAbi } from "../packages/adapters/src/protocol-abi.js";
import { erc20Abi as blinkTestUsdAbi } from "viem";
const blinkMarketAbi = protocolAbi.markets;
import { postgresTxTrackingStore } from "../packages/adapters/src/tx-tracking-store.js";
import { txReceiptReader } from "../packages/adapters/src/tx-receipt-reader.js";
import { createTxTracker } from "../packages/application/src/tx-tracking.js";
import type {
  TrackedTransaction,
  TxObservation,
} from "../packages/ports/src/index.js";

const manifest = DeploymentManifest.parse({
  ...deploymentFixture().manifest,
  deploymentId: "d1",
});
const parse = (path: string, body: unknown) =>
  apiContracts.find((c) => c.path === path)!.response.parse(body) as any;
async function setup() {
  const t = await fixture();
  const a = await inviteAgent(t, {
    name: "trader",
    scopes: ["forecast:write"],
  });
  const post = (body: unknown, key = "hint", token = a.apiKey) =>
    t.app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: { authorization: "Bearer " + token, "idempotency-key": key },
      payload: body as any,
    });
  const get = async (txHash = hash(50)) => {
    const r = await t.app.inject(
      "/v1/transactions/" + txHash + "?deploymentId=d1",
    );
    assert.equal(r.statusCode, 200, r.body);
    return parse("/v1/transactions/:txHash", r.json());
  };
  return { ...t, a, post, get };
}
test("transaction hints require wallet binding, replay idempotently, and cannot set status", async () => {
  const t = await setup();
  try {
    const body = {
      deploymentId: "d1",
      txHash: hash(50),
      action: "FILL",
      quoteId: hash(60),
    };
    await t.setRole("blink_api");
    assert.equal((await t.post(body, "anonymous", "invalid")).statusCode, 401);
    const unbound = await t.post(body);
    assert.equal(unbound.statusCode, 403);
    assert.equal(unbound.json().code, "WALLET_NOT_VERIFIED");
    await bindWallet(t, t.a.agentId, address);
    assert.equal((await t.post(body)).statusCode, 403); // Persisted refusal also replays.
    const first = await t.post(body, "bound");
    assert.equal(first.statusCode, 202, first.body);
    parse("/v1/transactions", first.json());
    assert.deepEqual(
      (
        await t.post(
          { ...body, txHash: body.txHash.toUpperCase().replace("0X", "0x") },
          "bound",
        )
      ).json(),
      first.json(),
    );
    assert.deepEqual((await t.post(body, "another-key")).json(), first.json());
    const conflict = await t.post({ ...body, txHash: hash(51) }, "bound");
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().code, "IDEMPOTENCY_CONFLICT");
    const other = await inviteAgent(t, {
      name: "other",
      scopes: ["forecast:write"],
    });
    await bindWallet(t, other.agentId, "0x" + "22".repeat(20));
    const taken = await t.post(body, "other", other.apiKey);
    assert.equal(taken.statusCode, 409);
    assert.equal(taken.json().code, "TX_ALREADY_TRACKED");
    assert.equal(
      (await t.post({ ...body, quoteId: undefined }, "bad-fill")).statusCode,
      400,
    );
    assert.equal(
      (await t.post({ ...body, status: "FINALIZED" }, "bad-status")).statusCode,
      400,
    );
    assert.equal((await t.get()).status, "UNKNOWN");
    assert.equal((await t.get()).rejectReason, null);
    assert.equal(
      (await t.app.inject("/v1/transactions/" + hash(99) + "?deploymentId=d1"))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await t.app.inject(
          "/v1/transactions/" + hash(50) + "?deploymentId=wrong",
        )
      ).statusCode,
      404,
    );
  } finally {
    await t.close();
  }
});
test("tracker verifies a fill before inclusion and projects its market id without touching positions", async () => {
  const t = await setup();
  try {
    await bindWallet(t, t.a.agentId, address);
    await t.post({
      deploymentId: "d1",
      txHash: hash(50),
      action: "FILL",
      quoteId: hash(60),
    });
    const observation: TxObservation = {
      chainId: 84532,
      transaction: {
        from: address,
        to: manifest.contracts.BlinkMarket,
        action: "FILL",
        quoteDigest: hash(60),
        marketId: "1",
      },
      receipt: {
        blockHash: hash(10),
        blockNumber: "10",
        success: true,
        canonical: true,
      },
      previousCanonical: null,
      finalizedNumber: "3",
    };
    const tracker = createTxTracker({
      store: postgresTxTrackingStore(t.pool),
      reader: {
        async read() {
          return observation;
        },
      },
      async manifest() {
        return manifest;
      },
    });
    await t.setRole("blink_indexer");
    assert.equal(await tracker.trackOnce(), 1);
    await t.setRole("blink_api");
    assert.equal((await t.get()).status, "INCLUDED");
    const row = await t.db.query<{ market_id: string }>(
      "SELECT market_id::text FROM chain.transactions",
    );
    assert.equal(row.rows[0]!.market_id, "1");
    assert.equal(
      (await t.db.query("SELECT * FROM protocol.position_reads")).rows.length,
      0,
    );
  } finally {
    await t.close();
  }
});
test("tracker rejects sender, target, selector, spender and quote mismatches and stops polling rejected hints", async () => {
  const t = await setup();
  try {
    await bindWallet(t, t.a.agentId, address);
    const cases = [
      { reason: "SENDER_MISMATCH", change: { from: "0x" + "33".repeat(20) } },
      {
        reason: "TARGET_MISMATCH",
        change: { to: manifest.contracts.BlinkTestUSD },
      },
      { reason: "ACTION_MISMATCH", change: { action: "REDEEM" as const } },
      { reason: "QUOTE_MISMATCH", change: { quoteDigest: hash(99) } },
      {
        reason: "ACTION_MISMATCH",
        approve: true,
        change: {
          action: "APPROVE" as const,
          to: manifest.contracts.BlinkTestUSD,
          spender: "0x" + "33".repeat(20),
        },
      },
    ];
    let calls = 0;
    for (const [i, c] of cases.entries())
      await t.post(
        {
          deploymentId: "d1",
          txHash: hash(70 + i),
          action: c.approve ? "APPROVE" : "FILL",
          ...(c.approve ? {} : { quoteId: hash(60) }),
        },
        "case-" + i,
      );
    const tracker = createTxTracker({
      store: postgresTxTrackingStore(t.pool),
      reader: {
        async read(row) {
          calls++;
          const c = cases[Number(BigInt(row.txHash)) - 70]!;
          return {
            chainId: 84532,
            transaction: {
              from: address,
              to: manifest.contracts.BlinkMarket,
              action: "FILL",
              quoteDigest: hash(60),
              marketId: "1",
              ...c.change,
            },
            receipt: null,
            previousCanonical: null,
            finalizedNumber: null,
          };
        },
      },
      async manifest() {
        return manifest;
      },
    });
    await t.setRole("blink_indexer");
    await tracker.trackOnce();
    assert.equal(await tracker.trackOnce(), 0);
    assert.equal(calls, cases.length);
    await t.setRole("blink_api");
    for (const [i, c] of cases.entries()) {
      const got = await t.get(hash(70 + i));
      assert.equal(got.rejectReason, c.reason);
      assert.equal(got.status, "UNKNOWN");
      assert.equal(got.chainCursor, null);
    }
  } finally {
    await t.close();
  }
});
test("unknown, reverted, reorged and re-included receipts retain correct confirmation states", async () => {
  const t = await setup();
  try {
    await bindWallet(t, t.a.agentId, address);
    await t.post({ deploymentId: "d1", txHash: hash(50), action: "REDEEM" });
    let observation: TxObservation = {
      chainId: 84532,
      transaction: null,
      receipt: null,
      previousCanonical: null,
      finalizedNumber: null,
    };
    const tracker = createTxTracker({
      store: postgresTxTrackingStore(t.pool),
      reader: {
        async read() {
          return observation;
        },
      },
      async manifest() {
        return manifest;
      },
    });
    const run = async () => {
      await t.setRole("blink_indexer");
      await tracker.trackOnce();
      await t.setRole("blink_api");
      return t.get();
    };
    assert.equal((await run()).status, "UNKNOWN");
    observation.transaction = {
      from: address,
      to: manifest.contracts.BlinkMarket,
      action: "REDEEM",
      marketId: "3",
    };
    await t.setRole(null);
    await t.db.query(
      "INSERT INTO protocol.positions(deployment_id,key,data,as_of_block_hash) VALUES ('d1','3:0x'||$1,jsonb_build_object('marketId','3','account','0x'||$1,'yesShares','2','noShares','0','takerBoughtShares','0','redeemedPayoutMicros','0'),decode($2,'hex'))",
      [address.slice(2), hash(10).slice(2)],
    );
    await run();
    observation.receipt = {
      blockHash: hash(10),
      blockNumber: "10",
      success: true,
      canonical: true,
    };
    assert.equal((await run()).status, "INCLUDED");
    observation = {
      ...observation,
      previousCanonical: false,
      transaction: null,
      receipt: null,
    };
    const reorged = await run();
    assert.equal(reorged.status, "REORGED");
    assert.equal(reorged.chainCursor.finality, "UNKNOWN");
    assert.equal((await run()).status, "REORGED");
    observation = {
      ...observation,
      transaction: {
        from: address,
        to: manifest.contracts.BlinkMarket,
        action: "REDEEM",
        marketId: "3",
      },
      receipt: {
        blockHash: hash(11),
        blockNumber: "11",
        success: true,
        canonical: true,
      },
      previousCanonical: false,
    };
    assert.equal((await run()).status, "INCLUDED");
    observation.previousCanonical = true;
    observation.finalizedNumber = "11";
    const final = await run();
    assert.equal(final.status, "FINALIZED");
    assert.equal(final.chainCursor.blockHash, hash(11));
    assert.equal(final.chainCursor.finality, "FINALIZED");
    await t.post(
      { deploymentId: "d1", txHash: hash(51), action: "REDEEM" },
      "reverted",
    );
    observation.receipt!.success = false;
    await run();
    assert.equal((await t.get(hash(51))).status, "REVERTED");
  } finally {
    await t.close();
  }
});
test("tracker refuses mainnet and wrong-chain observations without changing the hint", async () => {
  const t = await setup();
  try {
    await bindWallet(t, t.a.agentId, address);
    await t.post({ deploymentId: "d1", txHash: hash(50), action: "REDEEM" });
    for (const chainId of [8453, 1]) {
      const tracker = createTxTracker({
        store: postgresTxTrackingStore(t.pool),
        reader: {
          async read() {
            return {
              chainId,
              transaction: null,
              receipt: null,
              previousCanonical: null,
              finalizedNumber: null,
            };
          },
        },
        async manifest() {
          return manifest;
        },
      });
      await assert.rejects(
        tracker.trackOnce(),
        chainId === 8453 ? /MAINNET_REFUSED/ : /DEPLOYMENT_MISMATCH/,
      );
      assert.equal((await t.get()).status, "UNKNOWN");
    }
  } finally {
    await t.close();
  }
});
test("transaction table enforces least privilege and version CAS prevents stale overwrite", async () => {
  const t = await setup();
  try {
    await bindWallet(t, t.a.agentId, address);
    await t.post({ deploymentId: "d1", txHash: hash(50), action: "REDEEM" });
    const store = postgresTxTrackingStore(t.pool);
    await t.setRole("blink_api");
    await assert.rejects(
      t.db.exec("UPDATE chain.transactions SET status='FINALIZED'"),
      /permission denied/,
    );
    await assert.rejects(
      t.db.exec("DELETE FROM chain.transactions"),
      /permission denied/,
    );
    await t.setRole("blink_worker");
    assert.equal(
      (await t.db.query("SELECT * FROM chain.transactions")).rows.length,
      1,
    );
    await assert.rejects(
      t.db.exec("UPDATE chain.transactions SET status='FINALIZED'"),
      /permission denied/,
    );
    await t.setRole("blink_indexer");
    await assert.rejects(
      t.db.exec(
        "UPDATE chain.transactions SET wallet=decode('" +
          "44".repeat(20) +
          "','hex')",
      ),
      /permission denied/,
    );
    await assert.rejects(
      t.db.exec("DELETE FROM chain.transactions"),
      /permission denied/,
    );
    const row = (await store.pending(50))[0]!;
    assert.equal(await store.update(row, { ...row, status: "INCLUDED" }), true);
    assert.equal(
      await store.update(row, { ...row, status: "REVERTED" }),
      false,
    );
    await t.setRole("blink_api");
    assert.equal((await t.get()).status, "INCLUDED");
  } finally {
    await t.close();
  }
});

// The actual receipt adapter is exercised against deterministic RPC data, including real ABI bytes.
test("receipt reader decodes actual fill, approve and redeem calldata and checks canonical hashes", async () => {
  const q = {
    marketId: 123n,
    specHash: hash(1) as Hex,
    maker: manifest.roles.maker as Hex,
    taker: address as Hex,
    side: 0,
    quantity: 2n,
    priceBps: 5000,
    validAfter: 10n,
    expiresAt: 40n,
    nonce: 1n,
    epoch: 0n,
  };
  const digest = hashTypedData({
    domain: {
      name: "Blink RFQ",
      version: "0.1",
      chainId: 84532,
      verifyingContract: manifest.contracts.BlinkMarket as Hex,
    },
    types: quoteTypes,
    primaryType: "Quote",
    message: q,
  });
  const row: TrackedTransaction = {
    id: "test",
    deploymentId: "d1",
    txHash: hash(50),
    agentId: "agent",
    wallet: address,
    action: "FILL",
    quoteId: digest,
    marketId: null,
    status: "UNKNOWN",
    rejectReason: null,
    receiptBlockHash: hash(9),
    receiptBlockNumber: "9",
    version: "0",
  };
  let input = encodeFunctionData({
    abi: blinkMarketAbi,
    functionName: "fillQuote",
    args: [q, "0x1234"],
  });
  let missing = false;
  let chainId = 84532;
  let canonicalHash = hash(10);
  let finality = true;
  const client = {
    async getChainId() {
      return chainId;
    },
    async getTransaction() {
      if (missing)
        throw new TransactionNotFoundError({ hash: row.txHash as Hex });
      return {
        hash: row.txHash,
        chainId,
        from: address,
        to: manifest.contracts.BlinkMarket,
        input,
      };
    },
    async getTransactionReceipt() {
      if (missing)
        throw new TransactionReceiptNotFoundError({ hash: row.txHash as Hex });
      return {
        transactionHash: row.txHash,
        blockHash: hash(10),
        blockNumber: 10n,
        status: "success",
      };
    },
    async getBlock(args: { blockTag?: string; blockNumber?: bigint }) {
      if (args.blockTag && !finality) throw new Error("Unsupported tag");
      return { number: args.blockNumber ?? 5n, hash: canonicalHash };
    },
  } as unknown as PublicClient;
  const reader = txReceiptReader(client);
  let o = await reader.read(row, manifest);
  assert.equal(o.transaction!.quoteDigest, digest);
  assert.equal(o.transaction!.marketId, "123");
  assert.equal(o.receipt!.canonical, true);
  assert.equal(o.previousCanonical, false);
  assert.equal(o.finalizedNumber, "5");
  input = encodeFunctionData({
    abi: blinkMarketAbi,
    functionName: "redeem",
    args: [456n],
  });
  o = await reader.read({ ...row, action: "REDEEM" }, manifest);
  assert.equal(o.transaction!.action, "REDEEM");
  assert.equal(o.transaction!.marketId, "456");
  input = encodeFunctionData({
    abi: blinkTestUsdAbi,
    functionName: "approve",
    args: [manifest.contracts.BlinkMarket as Hex, 1000n],
  });
  o = await reader.read({ ...row, action: "APPROVE" }, manifest);
  assert.equal(
    o.transaction!.spender!.toLowerCase(),
    manifest.contracts.BlinkMarket,
  );
  input = "0x12345678";
  assert.equal((await reader.read(row, manifest)).transaction!.action, null);
  canonicalHash = hash(99);
  finality = false;
  o = await reader.read(row, manifest);
  assert.equal(o.receipt!.canonical, false);
  assert.equal(o.finalizedNumber, null);
  missing = true;
  o = await reader.read(row, manifest);
  assert.equal(o.transaction, null);
  assert.equal(o.receipt, null);
  chainId = 8453;
  await assert.rejects(reader.read(row, manifest), /MAINNET_REFUSED/);
});
