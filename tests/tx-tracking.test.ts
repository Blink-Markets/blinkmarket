import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeFunctionData,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type PublicClient,
  type Hex,
} from "viem";
import { buildApi } from "../apps/api/src/server.js";
import { identityCrypto } from "../packages/adapters/src/identity-crypto.js";
import { postgresIdentityStore } from "../packages/adapters/src/identity-store.js";
import { postgresMarketReadStore } from "../packages/adapters/src/market-read-store.js";
import { protocolAbi } from "../packages/adapters/src/protocol-abi.js";
import { txReceiptReader } from "../packages/adapters/src/tx-receipt-reader.js";
import { postgresTxTrackingStore } from "../packages/adapters/src/tx-tracking-store.js";
import { createIdentityService } from "../packages/application/src/identity.js";
import { createMarketReadService } from "../packages/application/src/market-read.js";
import {
  createTxTracker,
  createTxTrackingService,
} from "../packages/application/src/tx-tracking.js";
import { apiContracts } from "../packages/schemas/src/index.js";
import type {
  TrackedTransaction,
  TxObservation,
} from "../packages/ports/src/index.js";
import { bindWallet, createTestDatabase, inviteAgent } from "./helpers/database.js";
import { address, hash, protocolManifest, seedProtocolDeployment } from "./helpers/protocol-index.js";

const manifest = protocolManifest("d1");
const WALLET = "0x" + "11".repeat(20);
const STRANGER = "0x" + "22".repeat(20);
const parse = (method: string, path: string, body: unknown) =>
  apiContracts.find((c) => c.method === method && c.path === path)!.response.parse(body) as any;

async function setup() {
  const t = await createTestDatabase();
  await seedProtocolDeployment(t.pool, "d1", manifest);
  await t.db.query(
    `INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,finalized_number,synced_at)
     VALUES ('d1',10,decode($1,'hex'),1000,10,3,blink.now())`,
    [hash(10).slice(2)],
  );
  const a = await inviteAgent(t, { name: "taker", scopes: ["forecast:write"] });
  const identity = createIdentityService(
    postgresIdentityStore(t.pool),
    identityCrypto,
    "https://blink.example",
  );
  // GET /v1/transactions/:txHash is served by the read service; POST by the tracking service.
  const app = buildApi({
    services: [
      createTxTrackingService({
        store: postgresTxTrackingStore(t.pool),
        identity,
        deploymentId: "d1",
      }),
      createMarketReadService({
        store: postgresMarketReadStore(t.pool),
        archive: { read: async () => new Uint8Array() },
        identity: {
          authenticate: async () => {
            throw new Error("UNUSED");
          },
        },
      }),
    ],
  });
  app.log.level = "silent";
  const post = (body: unknown, token = a.apiKey) =>
    app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: { authorization: "Bearer " + token },
      payload: body as object,
    });
  const get = async (txHash = hash(50)) => {
    const r = await app.inject(
      "/v1/transactions/" + txHash + "?deploymentId=d1",
    );
    assert.equal(r.statusCode, 200, r.body);
    return parse("GET", "/v1/transactions/:txHash", r.json());
  };
  return {
    ...t,
    a,
    post,
    get,
    app,
    async close() {
      await app.close();
      await t.close();
    },
  };
}
const observation = (patch: Partial<TxObservation> = {}): TxObservation => ({
  chainId: 84532,
  transaction: null,
  receipt: null,
  previousCanonical: null,
  finalizedNumber: null,
  ...patch,
});
const included = {
  blockHash: hash(10),
  blockNumber: "10",
  success: true,
  canonical: true,
};
const sent = (patch: Record<string, unknown> = {}) => ({
  from: WALLET,
  to: manifest.generation.markets,
  contract: "markets" as const,
  action: "redeem",
  marketId: "3",
  ...patch,
});

test("transaction hints need a key and a wallet, replay by hash, and cannot set status", async () => {
  const t = await setup();
  try {
    const body = { txHash: hash(50) };
    await t.setRole("blink_api");
    assert.equal((await t.post(body, "invalid")).statusCode, 401);
    const unbound = await t.post(body);
    assert.equal(unbound.statusCode, 403);
    assert.equal(unbound.json().code, "NOT_REGISTERED");
    await bindWallet(t, t.a.agentId, WALLET);
    const first = await t.post(body);
    assert.equal(first.statusCode, 202, first.body);
    parse("POST", "/v1/transactions", first.json());
    assert.equal(first.json().status, "UNKNOWN");
    // The same hash by the same key (in any case) is the same tracking row.
    assert.deepEqual(
      (await t.post({ txHash: body.txHash.toUpperCase().replace("0X", "0x") })).json(),
      first.json(),
    );
    const another = await t.post({ txHash: hash(51) });
    assert.notEqual(another.json().trackingId, first.json().trackingId);
    // Another key cannot take over a tracked hash.
    const other = await inviteAgent(t, { name: "other", scopes: ["rfq:write"] });
    await bindWallet(t, other.agentId, STRANGER);
    const taken = await t.post(body, other.apiKey);
    assert.equal(taken.statusCode, 409);
    assert.equal(taken.json().code, "TX_ALREADY_TRACKED");
    // The caller cannot say what the transaction is or what happened to it.
    for (const bad of [
      { ...body, status: "FINALIZED" },
      { ...body, action: "FILL" },
      { txHash: "0x12" },
      {},
    ])
      assert.equal((await t.post(bad)).statusCode, 400, JSON.stringify(bad));
    const row = await t.get();
    assert.equal(row.status, "UNKNOWN");
    assert.equal(row.rejectReason, null);
    for (const url of [
      "/v1/transactions/" + hash(99) + "?deploymentId=d1",
      "/v1/transactions/" + hash(50) + "?deploymentId=wrong",
    ])
      assert.equal((await t.app.inject(url)).statusCode, 404);
  } finally {
    await t.close();
  }
});

test("tracker decodes the action and projects a fill's market id", async () => {
  const t = await setup();
  try {
    await bindWallet(t, t.a.agentId, WALLET);
    await t.post({ txHash: hash(50) });
    const tracker = createTxTracker({
      store: postgresTxTrackingStore(t.pool),
      reader: {
        async read() {
          return observation({
            transaction: sent({ action: "fillQuote", marketId: "7" }),
            receipt: included,
          });
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
    const row = await t.db.query<{ market_id: string; action: string }>(
      "SELECT market_id::text,action FROM chain.transactions",
    );
    assert.deepEqual(row.rows[0], { market_id: "7", action: "fillQuote" });
  } finally {
    await t.close();
  }
});

test("tracker rejects sender, target and action mismatches and stops polling rejected hints", async () => {
  const t = await setup();
  try {
    await bindWallet(t, t.a.agentId, WALLET);
    const cases = [
      { reason: "SENDER_MISMATCH", change: { from: STRANGER } },
      // Not the generation, faucet or anchor (for instance the bUSD token): no contract name.
      { reason: "TARGET_MISMATCH", change: { to: manifest.shared.busd, contract: null } },
      // A contract of the generation, but calldata that matches no function of its ABI.
      { reason: "ACTION_MISMATCH", change: { action: null } },
    ];
    for (const [i] of cases.entries()) await t.post({ txHash: hash(70 + i) });
    let calls = 0;
    const tracker = createTxTracker({
      store: postgresTxTrackingStore(t.pool),
      reader: {
        async read(row) {
          calls++;
          const c = cases[Number(BigInt(row.txHash)) - 70]!;
          return observation({ transaction: sent(c.change) });
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
    await bindWallet(t, t.a.agentId, WALLET);
    await t.post({ txHash: hash(50) });
    let current = observation();
    const tracker = createTxTracker({
      store: postgresTxTrackingStore(t.pool),
      reader: {
        async read() {
          return current;
        },
      },
      async manifest() {
        return manifest;
      },
    });
    const run = async (hashOf = hash(50)) => {
      await t.setRole("blink_indexer");
      await tracker.trackOnce();
      await t.setRole("blink_api");
      return t.get(hashOf);
    };
    assert.equal((await run()).status, "UNKNOWN");
    current = observation({ transaction: sent() });
    assert.equal((await run()).status, "UNKNOWN");
    current = observation({ transaction: sent(), receipt: included });
    assert.equal((await run()).status, "INCLUDED");
    current = observation({ previousCanonical: false });
    const reorged = await run();
    assert.equal(reorged.status, "REORGED");
    assert.equal(reorged.chainCursor.finality, "UNKNOWN");
    assert.equal((await run()).status, "REORGED");
    current = observation({
      transaction: sent(),
      receipt: { ...included, blockHash: hash(11), blockNumber: "11" },
      previousCanonical: false,
    });
    assert.equal((await run()).status, "INCLUDED");
    current = observation({
      transaction: sent(),
      receipt: { ...included, blockHash: hash(11), blockNumber: "11" },
      previousCanonical: true,
      finalizedNumber: "11",
    });
    const final = await run();
    assert.equal(final.status, "FINALIZED");
    assert.equal(final.chainCursor.blockHash, hash(11));
    assert.equal(final.chainCursor.finality, "FINALIZED");
    await t.setRole("blink_api");
    await t.post({ txHash: hash(51) });
    current = observation({
      transaction: sent(),
      receipt: { ...included, success: false },
    });
    assert.equal((await run(hash(51))).status, "REVERTED");
  } finally {
    await t.close();
  }
});

test("tracker refuses mainnet and wrong-chain observations without changing the hint", async () => {
  const t = await setup();
  try {
    await bindWallet(t, t.a.agentId, WALLET);
    await t.post({ txHash: hash(50) });
    for (const chainId of [8453, 1]) {
      const tracker = createTxTracker({
        store: postgresTxTrackingStore(t.pool),
        reader: {
          async read() {
            return observation({ chainId });
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
    await bindWallet(t, t.a.agentId, WALLET);
    await t.post({ txHash: hash(50) });
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
        "UPDATE chain.transactions SET wallet=decode('" + "44".repeat(20) + "','hex')",
      ),
      /permission denied/,
    );
    await assert.rejects(
      t.db.exec("DELETE FROM chain.transactions"),
      /permission denied/,
    );
    const row = (await store.pending(50))[0]!;
    assert.equal(
      await store.update(row, { ...row, action: "redeem", status: "INCLUDED" }),
      true,
    );
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

// The receipt adapter is exercised against deterministic RPC data, including real ABI bytes.
test("receipt reader decodes calldata by contract from the protocol ABI and checks canonical hashes", async () => {
  const q = {
    marketId: 123n,
    specHash: hash(1) as Hex,
    maker: address(5) as Hex,
    taker: WALLET as Hex,
    side: 0,
    quantity: 2n,
    priceBps: 5000,
    validAfter: 10n,
    expiresAt: 40n,
    nonce: 1n,
    epoch: 0n,
  };
  const row: TrackedTransaction = {
    id: "test",
    deploymentId: "d1",
    txHash: hash(50),
    agentId: "agent",
    wallet: WALLET,
    action: null,
    marketId: null,
    status: "UNKNOWN",
    rejectReason: null,
    receiptBlockHash: hash(9),
    receiptBlockNumber: "9",
    version: "0",
  };
  let to: string = manifest.generation.markets;
  let input: Hex = encodeFunctionData({
    abi: protocolAbi.markets,
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
      return { hash: row.txHash, chainId, from: WALLET, to, input };
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
  assert.deepEqual(
    [o.transaction!.contract, o.transaction!.action, o.transaction!.marketId],
    ["markets", "fillQuote", "123"],
  );
  assert.equal(o.receipt!.canonical, true);
  assert.equal(o.previousCanonical, false);
  assert.equal(o.finalizedNumber, "5");
  input = encodeFunctionData({ abi: protocolAbi.markets, functionName: "redeem", args: [456n] });
  o = await reader.read(row, manifest);
  assert.deepEqual([o.transaction!.action, o.transaction!.marketId], ["redeem", "456"]);
  // Every contract of the generation, the faucet and the anchor is recognized by its address...
  const cases: [string, "registry" | "faucet" | "anchor" | "resolution", Hex, string][] = [
    [
      manifest.generation.registry,
      "registry",
      encodeFunctionData({ abi: protocolAbi.registry, functionName: "joinRole", args: [2, 100n] } as never),
      "joinRole",
    ],
    [manifest.shared.faucet, "faucet", encodeFunctionData({ abi: protocolAbi.faucet, functionName: "claim" }), "claim"],
    [
      manifest.shared.anchor,
      "anchor",
      encodeFunctionData({ abi: protocolAbi.anchor, functionName: "anchor", args: [hash(3) as Hex] }),
      "anchor",
    ],
  ];
  for (const [target, contract, data, action] of cases) {
    to = target.toUpperCase().replace("0X", "0x");
    input = data;
    o = await reader.read(row, manifest);
    assert.deepEqual([o.transaction!.contract, o.transaction!.action], [contract, action]);
    assert.equal(o.transaction!.marketId, undefined);
  }
  // ...calldata of another contract's ABI matches nothing here...
  to = manifest.generation.markets;
  input = encodeFunctionData({ abi: protocolAbi.faucet, functionName: "claim" });
  assert.equal((await reader.read(row, manifest)).transaction!.action, null);
  input = "0x12345678";
  assert.equal((await reader.read(row, manifest)).transaction!.action, null);
  // ...and any other target (here bUSD) is not a tracked contract at all.
  to = manifest.shared.busd;
  o = await reader.read(row, manifest);
  assert.deepEqual([o.transaction!.contract, o.transaction!.action], [null, null]);
  to = manifest.generation.markets;
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
