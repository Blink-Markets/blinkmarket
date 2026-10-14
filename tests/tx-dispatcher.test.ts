import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, type Hex } from "viem";
import {
  createSignerService,
  createTxDispatchHandler,
  createTxDispatcher,
  TxDispatchError,
} from "../packages/application/src/index.js";
import { encodeAllowedCall } from "../packages/adapters/src/signing-calldata.js";
import {
  postgresDispatchStore,
  postgresSignerStore,
} from "../packages/adapters/src/signing-store.js";
import type {
  DispatchReceipt,
  DispatchRpc,
  RestrictedSigner,
  SendRawResult,
  SignerRpc,
  SignResult,
} from "../packages/ports/src/index.js";
import { createTestDatabase } from "./helpers/database.js";
import {
  prepareRequest,
  seedChain,
  seedDeployment,
  sha256Hex,
  testAccounts,
  testManifest,
  testMarket,
  testQuote,
} from "./helpers/signer-fixture.js";

const TOKEN = "dispatch-token";
// gas 100k -> limit 120k at maxFee 2_100_000: maxCost 252_000_000_000.
const MAX_COST = 252_000_000_000n;

async function harness(perTxCapWei = 200_000_000_000_000n) {
  const t = await createTestDatabase();
  const manifest = testManifest();
  await seedDeployment(t.db, manifest);
  await seedChain(t.db, { deploymentId: manifest.deploymentId });
  const signerRpc: SignerRpc = {
    chainId: async () => 84532,
    estimateGas: async () => 100_000n,
    baseFeePerGas: async () => 1_000_000n,
    maxPriorityFeePerGas: async () => 100_000n,
    pendingNonce: async () => 5n,
    l1Fee: async () => 0n,
  };
  const service = createSignerService({
    store: postgresSignerStore(t.pool),
    keys: { keeper: testAccounts.keeper },
    rpc: signerRpc,
    deployment: manifest,
    callers: [
      { name: "worker", tokenSha256: sha256Hex(TOKEN), roles: ["keeper"] },
    ],
    policy: {
      l1FeeMode: "local-none",
      perTxCapWei,
      dailyCapWei: 2_000_000_000_000_000n,
    },
    encodeCall: encodeAllowedCall,
  });
  const signerLog: SignResult[] = [];
  const signerMode = { unknown: false };
  const signer: RestrictedSigner = {
    async sign(input) {
      if (signerMode.unknown)
        return { state: "UNKNOWN", code: "SIGNER_TIMEOUT" };
      const response = await service.handle(TOKEN, input);
      const result: SignResult =
        response.status === 200
          ? (response.body as SignResult)
          : response.status === 422
            ? { state: "REJECTED", code: String(response.body.code) }
            : { state: "UNKNOWN", code: String(response.body.code) };
      signerLog.push(result);
      return result;
    },
  };
  const chain = {
    receipts: new Map<string, DispatchReceipt>(),
    canonical: new Map<bigint, Hex>(),
    finalized: null as bigint | null,
    send: [] as SendRawResult[] | "fail",
    sent: [] as Hex[],
  };
  const rpc: DispatchRpc = {
    async sendRawTransaction(raw) {
      chain.sent.push(raw);
      if (chain.send === "fail") throw new Error("RPC_UNAVAILABLE");
      return chain.send.shift() ?? { state: "ACCEPTED", hash: keccak256(raw) };
    },
    async getReceipt(hash) {
      return chain.receipts.get(hash.toLowerCase()) ?? null;
    },
    async blockHashAt(number) {
      return chain.canonical.get(number) ?? null;
    },
    async finalizedBlockNumber() {
      return chain.finalized;
    },
  };
  const dispatcher = createTxDispatcher({
    store: postgresDispatchStore(t.pool),
    rpc,
    signer,
    replaceAfterMs: 30_000,
  });
  const client = t.pool as unknown as Parameters<typeof prepareRequest>[0];
  const keeperIntent = (id = "3") =>
    prepareRequest(client, manifest, {
      kind: "FINALIZE_TIMEOUT",
      payload: { to: testMarket, functionName: "finalizeTimeout", args: [id] },
    });
  const rows = async (sql: string, params?: unknown[]) =>
    (await t.db.query(sql, params)).rows as Record<string, unknown>[];
  const hashOf = async () =>
    (
      await rows(
        "SELECT '0x' || encode(tx_hash, 'hex') AS h FROM signing.tx_attempts ORDER BY created_at",
      )
    ).map((r) => r.h as Hex);
  const mine = (
    hash: Hex,
    block: bigint,
    options: Partial<DispatchReceipt> = {},
  ) => {
    const blockHash = keccak256(
      ("0x" + block.toString(16).padStart(8, "0")) as Hex,
    );
    chain.canonical.set(block, blockHash);
    chain.receipts.set(hash.toLowerCase(), {
      status: "success",
      blockHash,
      blockNumber: block,
      gasSpentWei: 40_000_000_000n,
      ...options,
    });
  };
  return {
    t,
    manifest,
    dispatcher,
    chain,
    signerLog,
    signerMode,
    keeperIntent,
    rows,
    hashOf,
    mine,
    signer,
  };
}

test("a dispatched transaction is INCLUDED, then FINALIZED once the provider reports finality", async () => {
  const h = await harness();
  try {
    const intent = await h.keeperIntent();
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
    assert.equal(
      (await h.rows("SELECT state FROM signing.economic_intents"))[0]!.state,
      "SUBMITTED",
    );
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "PENDING");
    const [hash] = await h.hashOf();
    h.mine(hash!, 10n);
    assert.equal(
      await h.dispatcher.dispatch(intent.intentId),
      "INCLUDED",
      "no finality signal yet",
    );
    h.chain.finalized = 9n;
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
    h.chain.finalized = 10n;
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "FINALIZED");
    assert.equal(
      (await h.rows("SELECT state FROM signing.economic_intents"))[0]!.state,
      "FINALIZED",
    );
    const [gas] = await h.rows(
      "SELECT reserved_wei::text AS reserved, spent_wei::text AS spent FROM signing.gas_spend",
    );
    assert.deepEqual(gas, { reserved: "0", spent: "40000000000" });
    assert.equal(h.chain.sent.length, 1);
    // A settled intent is not touched again.
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "FINALIZED");
    assert.equal(h.chain.sent.length, 1);
  } finally {
    await h.t.close();
  }
});

test("a reverted transaction fails the intent, records its gas and is not retried", async () => {
  const h = await harness();
  try {
    const intent = await h.keeperIntent();
    await h.dispatcher.dispatch(intent.intentId);
    const [hash] = await h.hashOf();
    h.mine(hash!, 7n, { status: "reverted", gasSpentWei: 55_000_000_000n });
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "REVERTED");
    assert.equal(
      (await h.rows("SELECT state FROM signing.economic_intents"))[0]!.state,
      "FAILED",
    );
    assert.equal(
      (await h.rows("SELECT status FROM signing.tx_attempts"))[0]!.status,
      "REVERTED",
    );
    const [gas] = await h.rows(
      "SELECT reserved_wei::text AS reserved, spent_wei::text AS spent FROM signing.gas_spend",
    );
    assert.deepEqual(gas, { reserved: "0", spent: "55000000000" });
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "REVERTED");
    assert.equal(h.chain.sent.length, 1);
  } finally {
    await h.t.close();
  }
});

test("a receipt in a block that is no longer canonical does not count", async () => {
  const h = await harness();
  try {
    const intent = await h.keeperIntent();
    await h.dispatcher.dispatch(intent.intentId);
    const [hash] = await h.hashOf();
    h.mine(hash!, 10n);
    h.chain.canonical.set(10n, keccak256("0x1234"));
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "PENDING");
    assert.equal(
      (await h.rows("SELECT status FROM signing.tx_attempts"))[0]!.status,
      "SUBMITTED",
    );
    // Inclusion that disappears is REORGED and its bytes go out again.
    h.chain.canonical.set(
      10n,
      h.chain.receipts.get(hash!.toLowerCase())!.blockHash,
    );
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
    h.chain.receipts.delete(hash!.toLowerCase());
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
    assert.equal(h.chain.sent.length, 2);
    assert.equal(h.chain.sent[1], h.chain.sent[0]);
    assert.equal((await h.rows("SELECT 1 FROM signing.tx_attempts")).length, 1);
  } finally {
    await h.t.close();
  }
});

test("broadcast failures keep the signed attempt for a retry with the same bytes", async () => {
  const h = await harness();
  try {
    const intent = await h.keeperIntent();
    h.chain.send = "fail";
    await assert.rejects(
      h.dispatcher.dispatch(intent.intentId),
      (error: unknown) =>
        error instanceof TxDispatchError &&
        error.code === "RPC_UNAVAILABLE" &&
        error.retryable,
    );
    assert.equal(
      (await h.rows("SELECT status FROM signing.tx_attempts"))[0]!.status,
      "SIGNED",
    );
    h.chain.send = [];
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
    assert.equal(h.chain.sent.length, 2);
    assert.equal(h.chain.sent[0], h.chain.sent[1]);
    assert.equal(
      (await h.rows("SELECT 1 FROM signing.nonce_allocations")).length,
      1,
    );
  } finally {
    await h.t.close();
  }
});

test("nonce too low is UNKNOWN, not a failure, and the receipt lookup settles it", async () => {
  const h = await harness();
  try {
    const intent = await h.keeperIntent();
    h.chain.send = [{ state: "NONCE_TOO_LOW" }];
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "UNKNOWN");
    assert.equal(
      (await h.rows("SELECT state FROM signing.economic_intents"))[0]!.state,
      "UNKNOWN",
    );
    assert.equal(
      await h.dispatcher.dispatch(intent.intentId),
      "UNKNOWN",
      "a restart changes nothing",
    );
    assert.equal(
      h.chain.sent.length,
      1,
      "an UNKNOWN attempt is not blindly resent",
    );
    const [hash] = await h.hashOf();
    h.mine(hash!, 4n);
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
    assert.equal(
      (await h.rows("SELECT 1 FROM signing.nonce_allocations")).length,
      1,
    );
  } finally {
    await h.t.close();
  }
});

test("signer outcomes: UNKNOWN waits, REJECTED fails the intent for good", async () => {
  const h = await harness();
  try {
    const waiting = await h.keeperIntent("1");
    h.signerMode.unknown = true;
    assert.equal(await h.dispatcher.dispatch(waiting.intentId), "UNKNOWN");
    assert.equal(h.chain.sent.length, 0);
    h.signerMode.unknown = false;
    assert.equal(await h.dispatcher.dispatch(waiting.intentId), "SUBMITTED");

    const hostile = await prepareRequest(
      h.t.pool as unknown as Parameters<typeof prepareRequest>[0],
      h.manifest,
      {
        kind: "FINALIZE_TIMEOUT",
        payload: { to: testMarket, functionName: "withdrawMaker", args: ["1"] },
      },
    );
    await assert.rejects(
      h.dispatcher.dispatch(hostile.intentId),
      (error: unknown) =>
        error instanceof TxDispatchError &&
        error.code === "SIGN_REJECTED:SELECTOR_NOT_ALLOWED" &&
        !error.retryable,
    );
    assert.equal(
      (
        await h.rows(
          "SELECT state FROM signing.economic_intents WHERE id = $1",
          [hostile.intentId],
        )
      )[0]!.state,
      "FAILED",
    );
    // A failed intent is never dispatched later, and nothing was broadcast for it.
    await assert.rejects(
      h.dispatcher.dispatch(hostile.intentId),
      /INTENT_NOT_DISPATCHABLE/,
    );
    assert.equal(h.chain.sent.length, 1);
  } finally {
    await h.t.close();
  }
});

test("a replacement the signer refuses on gas leaves the live version alone and is not retried", async () => {
  // The cap fits the first version exactly; +12.5 percent of fee cannot fit.
  const h = await harness(MAX_COST);
  try {
    const intent = await h.keeperIntent();
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
    await h.t.db.exec("SET blink.test_clock_offset_seconds = '120'");
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "PENDING");
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "PENDING");
    assert.deepEqual(
      await h.rows(
        "SELECT artifact_version AS v, state, reject_code FROM signing.sign_requests ORDER BY artifact_version",
      ),
      [
        { v: 1, state: "SIGNED", reject_code: null },
        { v: 2, state: "REJECTED", reject_code: "GAS_CAP_EXCEEDED" },
      ],
    );
    assert.equal((await h.rows("SELECT 1 FROM signing.tx_attempts")).length, 1);
    assert.equal(h.chain.sent.length, 1);
    // The original can still be mined and finishes the intent.
    const [hash] = await h.hashOf();
    h.mine(hash!, 3n);
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
  } finally {
    await h.t.close();
  }
});

test("two dispatchers racing on one intent leave one attempt, one nonce and one artifact", async () => {
  const h = await harness();
  try {
    const intent = await h.keeperIntent();
    const results = await Promise.all([
      h.dispatcher.dispatch(intent.intentId),
      h.dispatcher.dispatch(intent.intentId),
      h.dispatcher.dispatch(intent.intentId),
    ]);
    assert.ok(
      results.every(
        (r) => r === "SUBMITTED" || r === "PENDING" || r === "UNKNOWN",
      ),
      results.join(),
    );
    assert.equal((await h.rows("SELECT 1 FROM signing.tx_attempts")).length, 1);
    assert.equal((await h.rows("SELECT 1 FROM signing.artifacts")).length, 1);
    assert.equal(
      (await h.rows("SELECT 1 FROM signing.nonce_allocations")).length,
      1,
    );
    assert.equal(
      new Set(h.chain.sent).size,
      1,
      "every broadcast carried the same bytes",
    );
  } finally {
    await h.t.close();
  }
});

test("the tx.dispatch handler validates its payload and retries until the end state", async () => {
  const calls: string[] = [];
  let next: Awaited<
    ReturnType<ReturnType<typeof createTxDispatcher>["dispatch"]>
  > = "PENDING";
  const handler = createTxDispatchHandler({
    async dispatch(intentId, signal) {
      calls.push(intentId + ":" + String(signal instanceof AbortSignal));
      return next;
    },
  });
  const id = "11111111-1111-4111-8111-111111111111";
  const ctx = (payload: Record<string, unknown>) => ({
    job: { id: "job", payload },
    signal: new AbortController().signal,
  });
  for (const bad of [{}, { intentId: 7 }, { intentId: "not-a-uuid" }])
    await assert.rejects(handler(ctx(bad)), (error: unknown) => {
      assert.ok(error instanceof TxDispatchError);
      assert.deepEqual(
        [error.code, error.retryable],
        ["INVALID_JOB_PAYLOAD", false],
      );
      return true;
    });
  assert.equal(calls.length, 0);
  for (const pending of [
    "PENDING",
    "SUBMITTED",
    "UNKNOWN",
    "INCLUDED",
  ] as const) {
    next = pending;
    await assert.rejects(handler(ctx({ intentId: id })), (error: unknown) => {
      assert.ok(error instanceof TxDispatchError);
      assert.deepEqual([error.code, error.retryable], ["TX_PENDING", true]);
      return true;
    });
  }
  for (const done of ["FINALIZED", "REVERTED"] as const) {
    next = done;
    await handler(ctx({ intentId: id }));
  }
  assert.equal(calls[0], id + ":true");
});

test("quote intents and missing intents are not dispatchable", async () => {
  const h = await harness();
  try {
    const quote = await prepareRequest(
      h.t.pool as unknown as Parameters<typeof prepareRequest>[0],
      h.manifest,
      { kind: "MAKER_QUOTE", payload: testQuote },
    );
    await assert.rejects(
      h.dispatcher.dispatch(quote.intentId),
      /INTENT_NOT_DISPATCHABLE/,
    );
    await assert.rejects(
      h.dispatcher.dispatch("00000000-0000-4000-8000-000000000000"),
      /INTENT_NOT_FOUND/,
    );
    const controller = new AbortController();
    controller.abort();
    const intent = await h.keeperIntent();
    await assert.rejects(
      h.dispatcher.dispatch(intent.intentId, controller.signal),
      /DISPATCH_ABORTED/,
    );
  } finally {
    await h.t.close();
  }
});
