import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, type Hex } from "viem";
import {
  createSignerService,
  createTxDispatchHandler,
  createTxDispatcher,
  TxDispatchError,
} from "../packages/application/src/index.js";
import { minimumReplacementFees } from "../packages/domain/src/signing-policy.js";
import { encodeAllowedCall } from "../packages/adapters/src/signing-calldata.js";
import {
  postgresDispatchStore,
  postgresSignerStore,
} from "../packages/adapters/src/signing-store.js";
import { postgresHealthReader } from "../packages/adapters/src/health-reader.js";
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
  const fees = { baseFee: 1_000_000n, priority: 100_000n };
  const signerRpc: SignerRpc = {
    chainId: async () => 84532,
    estimateGas: async () => 100_000n,
    baseFeePerGas: async () => fees.baseFee,
    maxPriorityFeePerGas: async () => fees.priority,
    pendingNonce: async () => 5n,
    l1Fee: async () => 0n,
  };
  // The signing transaction can be made to die after the artifact is written, before commit.
  const baseSignerStore = postgresSignerStore(t.pool);
  const faults = { crashAfterArtifact: false };
  const signerStore: typeof baseSignerStore = {
    loadDeployment: (id) => baseSignerStore.loadDeployment(id),
    run: (work) =>
      baseSignerStore.run((tx) =>
        work({
          ...tx,
          async markSigned(signRequestId, intentId) {
            if (faults.crashAfterArtifact) throw new Error("CRASH_AFTER_SIGN");
            await tx.markSigned(signRequestId, intentId);
          },
        }),
      ),
  };
  const service = createSignerService({
    store: signerStore,
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
    lookups: [] as string[],
  };
  const rpc: DispatchRpc = {
    async sendRawTransaction(raw) {
      chain.sent.push(raw);
      if (chain.send === "fail") throw new Error("RPC_UNAVAILABLE");
      return chain.send.shift() ?? { state: "ACCEPTED", hash: keccak256(raw) };
    },
    async getReceipt(hash) {
      chain.lookups.push(hash.toLowerCase());
      return chain.receipts.get(hash.toLowerCase()) ?? null;
    },
    async blockHashAt(number) {
      return chain.canonical.get(number) ?? null;
    },
    async finalizedBlockNumber() {
      return chain.finalized;
    },
  };
  const makeDispatcher = (view: DispatchRpc = rpc) =>
    createTxDispatcher({
      store: postgresDispatchStore(t.pool),
      rpc: view,
      signer,
      replaceAfterMs: 30_000,
    });
  const dispatcher = makeDispatcher();
  // The business clock moves forward for every query of the single PGlite session.
  const advance = (seconds: number) =>
    t.db.exec(`SET blink.test_clock_offset_seconds = '${seconds}'`);
  const attempts = async () =>
    await rows(
      `SELECT t.id, t.status, t.receipt_status, t.nonce::int AS nonce, t.max_cost_wei::text AS max_cost,
        t.gas_reserved_wei::text AS reserved, t.gas_spent_wei::text AS spent, t.replacement_of,
        t.max_fee_per_gas::text AS max_fee, t.max_priority_fee_per_gas::text AS tip,
        '0x' || encode(t.tx_hash, 'hex') AS hash
      FROM signing.tx_attempts t JOIN signing.artifacts a ON a.id = t.artifact_id
      JOIN signing.sign_requests r ON r.id = a.sign_request_id ORDER BY r.artifact_version`,
    );
  const ledger = async () =>
    (
      await rows(
        "SELECT reserved_wei::text AS reserved, spent_wei::text AS spent FROM signing.gas_spend",
      )
    )[0];
  const intentState = async () =>
    (await rows("SELECT state FROM signing.economic_intents"))[0]!.state;
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
    rpc,
    makeDispatcher,
    fees,
    advance,
    attempts,
    ledger,
    intentState,
    chain,
    signerLog,
    signerMode,
    faults,
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

test("submit-to-inclusion latency is measured on the business clock, also under a positive test-clock offset", async () => {
  const h = await harness();
  try {
    await h.advance(3600);
    const intent = await h.keeperIntent();
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
    const [hash] = await h.hashOf();
    h.mine(hash!, 10n);
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
    const metrics = await postgresHealthReader(
      h.t.pool,
      h.manifest.deploymentId,
    ).metrics();
    assert.equal(metrics.txInclusionLatency.samples, "1");
    assert.ok(
      metrics.txInclusionLatency.p50Ms! >= 0 &&
        metrics.txInclusionLatency.p50Ms! < 60_000,
      "the latency is real elapsed time, not the offset",
    );
  } finally {
    await h.t.close();
  }
});

test("a reverted receipt fails the intent only once its block is final", async () => {
  const h = await harness();
  try {
    const intent = await h.keeperIntent();
    await h.dispatcher.dispatch(intent.intentId);
    const [hash] = await h.hashOf();
    h.mine(hash!, 7n, { status: "reverted", gasSpentWei: 55_000_000_000n });

    // Mined and reverted, but not final (and no finality signal at all): still being watched.
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
    assert.equal(await h.intentState(), "INCLUDED");
    let [attempt] = await h.attempts();
    assert.deepEqual(
      { status: attempt!.status, receipt: attempt!.receipt_status },
      { status: "INCLUDED", receipt: "reverted" },
    );
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "55000000000" });
    h.chain.finalized = 6n;
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
    assert.equal(await h.intentState(), "INCLUDED");

    // Final: now it is REVERTED, the intent FAILED, and the job may stop.
    h.chain.finalized = 7n;
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "REVERTED");
    assert.equal(await h.intentState(), "FAILED");
    [attempt] = await h.attempts();
    assert.equal(attempt!.status, "REVERTED");
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "55000000000" });
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "REVERTED");
    assert.equal(h.chain.sent.length, 1);
  } finally {
    await h.t.close();
  }
});

test("an orphaned reverted receipt is REORGED and rebroadcast with the same bytes, not left FAILED", async () => {
  const h = await harness();
  try {
    const intent = await h.keeperIntent();
    await h.dispatcher.dispatch(intent.intentId);
    const [hash] = await h.hashOf();
    h.mine(hash!, 7n, { status: "reverted", gasSpentWei: 55_000_000_000n });
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
    const maxCost = (await h.attempts())[0]!.max_cost as string;

    // A shallow reorg removes the revert (finality unknown the whole time).
    h.chain.receipts.delete(hash!.toLowerCase());
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
    assert.equal((await h.attempts())[0]!.status, "SUBMITTED");
    assert.equal(await h.intentState(), "SUBMITTED");
    assert.equal(h.chain.sent.length, 2);
    assert.equal(
      h.chain.sent[1],
      h.chain.sent[0],
      "the same raw bytes, the same nonce",
    );
    assert.equal((await h.attempts()).length, 1);
    // Pending again: its reservation is back and the orphaned spend is gone.
    assert.deepEqual(await h.ledger(), { reserved: maxCost, spent: "0" });

    // On the new branch the same transaction succeeds, and that is what finalizes.
    h.mine(hash!, 9n, { gasSpentWei: 41_000_000_000n });
    h.chain.finalized = 9n;
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "FINALIZED");
    assert.equal(await h.intentState(), "FINALIZED");
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "41000000000" });
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

// v1 is signed and broadcast, the business clock moves past replaceAfterMs, and the dispatcher
// asks the signer for the higher-fee v2 and broadcasts it.
async function withReplacement(h: Awaited<ReturnType<typeof harness>>) {
  const intent = await h.keeperIntent();
  assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
  await h.advance(120);
  assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
  const attempts = await h.attempts();
  assert.equal(attempts.length, 2);
  return { intent, v1: attempts[0]!, v2: attempts[1]! };
}

test("a reorg after a replacement recovers the included version, moves the intent back to pending and may be replaced again", async () => {
  const h = await harness();
  try {
    const { intent, v1, v2 } = await withReplacement(h);
    assert.equal(v2.replacement_of, v1.id);
    h.mine(v1.hash as Hex, 10n, { gasSpentWei: 10n });
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
    assert.deepEqual(
      (await h.attempts()).map((a) => a.status),
      ["INCLUDED", "REPLACED"],
    );
    assert.equal(await h.intentState(), "INCLUDED");

    // v1's block is orphaned and v2 was never mined: v1 comes back with its persisted bytes.
    h.chain.receipts.delete((v1.hash as string).toLowerCase());
    const sentBefore = h.chain.sent.length;
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
    assert.deepEqual(
      (await h.attempts()).map((a) => a.status),
      ["SUBMITTED", "REPLACED"],
    );
    assert.equal(await h.intentState(), "SUBMITTED", "no longer INCLUDED");
    assert.equal(h.chain.sent.length, sentBefore + 1);
    assert.equal(h.chain.sent.at(-1), h.chain.sent[0], "v1's raw bytes");
    assert.equal(
      (await h.rows("SELECT 1 FROM signing.nonce_allocations")).length,
      1,
    );
    assert.equal(
      (await h.rows("SELECT 1 FROM signing.economic_intents")).length,
      1,
    );
    assert.deepEqual(await h.ledger(), {
      reserved: v1.max_cost,
      spent: "0",
    });

    // Still unmined for too long: a third version can be signed because the intent is pending.
    await h.advance(600);
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
    const after = await h.attempts();
    assert.equal(after.length, 3);
    assert.equal(after[2]!.nonce, v1.nonce, "never a new nonce");
    assert.equal(after[2]!.replacement_of, v2.id);
    assert.deepEqual(
      (
        await h.rows(
          "SELECT artifact_version AS v, state FROM signing.sign_requests ORDER BY artifact_version",
        )
      ).map((r) => r.state),
      ["SIGNED", "SIGNED", "SIGNED"],
    );
    assert.equal(await h.intentState(), "SUBMITTED");
  } finally {
    await h.t.close();
  }
});

test("gas follows the canonical receipt: a replaced sibling that wins after a reorg is charged, an orphan is refunded", async () => {
  const h = await harness();
  try {
    const { intent, v1, v2 } = await withReplacement(h);
    const c1 = BigInt(v1.max_cost as string);
    const c2 = BigInt(v2.max_cost as string);
    assert.deepEqual(await h.ledger(), {
      reserved: (c1 + c2).toString(),
      spent: "0",
    });

    // v1 is mined and costs 10; v2 releases its reservation as REPLACED.
    h.mine(v1.hash as Hex, 10n, { gasSpentWei: 10n });
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "10" });
    assert.deepEqual(
      (await h.attempts()).map((a) => [a.status, a.reserved, a.spent]),
      [
        ["INCLUDED", "0", "10"],
        ["REPLACED", "0", "0"],
      ],
    );

    // The chain reorganizes: v1 is gone and v2 is mined with an actual cost of 25.
    h.chain.receipts.delete((v1.hash as string).toLowerCase());
    h.mine(v2.hash as Hex, 11n, { gasSpentWei: 25n });
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "25" });
    assert.deepEqual(
      (await h.attempts()).map((a) => [a.status, a.reserved, a.spent]),
      [
        ["REPLACED", "0", "0"],
        ["INCLUDED", "0", "25"],
      ],
    );

    // The same transaction is re-included elsewhere at another actual cost: replaced, not added.
    h.mine(v2.hash as Hex, 12n, { gasSpentWei: 30n });
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "30" });
    assert.equal((await h.attempts())[1]!.spent, "30");
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
    assert.deepEqual(
      await h.ledger(),
      { reserved: "0", spent: "30" },
      "idempotent",
    );

    // Orphaned with nothing else mined: the spend is reversed and the pending v2 reserves again.
    h.chain.receipts.delete((v2.hash as string).toLowerCase());
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
    assert.deepEqual(await h.ledger(), { reserved: c2.toString(), spent: "0" });
    assert.deepEqual(
      (await h.attempts()).map((a) => [a.status, a.reserved, a.spent]),
      [
        ["REPLACED", "0", "0"],
        ["SUBMITTED", c2.toString(), "0"],
      ],
    );

    h.mine(v2.hash as Hex, 14n, { gasSpentWei: 31n });
    h.chain.finalized = 14n;
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "FINALIZED");
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "31" });
  } finally {
    await h.t.close();
  }
});

test("a zero-priority-fee transaction dispatches and is replaced with the 1 gwei minimum tip", async () => {
  const h = await harness();
  try {
    h.fees.priority = 0n;
    const intent = await h.keeperIntent();
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
    const [v1] = await h.attempts();
    assert.equal(v1!.tip, "0");
    assert.equal(v1!.max_fee, "2000000");

    await h.advance(120);
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
    const [, v2] = await h.attempts();
    const wanted = minimumReplacementFees({
      maxFeePerGas: 2_000_000n,
      maxPriorityFeePerGas: 0n,
    });
    assert.deepEqual(
      { fee: v2!.max_fee, tip: v2!.tip, nonce: v2!.nonce },
      {
        fee: wanted.maxFeePerGas.toString(),
        tip: "1000000000",
        nonce: v1!.nonce,
      },
    );
    assert.equal(
      (
        await h.rows(
          "SELECT state FROM signing.sign_requests WHERE artifact_version = 2",
        )
      )[0]!.state,
      "SIGNED",
      "the signer accepts exactly what the dispatcher asks for",
    );
  } finally {
    await h.t.close();
  }
});

test("two observers with different views cannot overwrite a newer intent state", async () => {
  const h = await harness();
  try {
    const intent = await h.keeperIntent();
    await h.dispatcher.dispatch(intent.intentId);
    const blockA = keccak256("0xaa");
    const blockB = keccak256("0xbb");
    const viewB: DispatchRpc = {
      ...h.rpc,
      getReceipt: async () => ({
        status: "success",
        blockHash: blockB,
        blockNumber: 6n,
        gasSpentWei: 40n,
      }),
      blockHashAt: async (number) => (number === 6n ? blockB : null),
      finalizedBlockNumber: async () => 6n,
    };
    const observerB = h.makeDispatcher(viewB);
    let bRan = false;
    // Observer A has read the attempt and is waiting on its receipt lookup when observer B
    // completes. A saw a final revert; B saw a final success.
    const viewA: DispatchRpc = {
      ...h.rpc,
      async getReceipt() {
        if (!bRan) {
          bRan = true;
          assert.equal(await observerB.dispatch(intent.intentId), "FINALIZED");
        }
        return {
          status: "reverted",
          blockHash: blockA,
          blockNumber: 5n,
          gasSpentWei: 10n,
        };
      },
      blockHashAt: async (number) => (number === 5n ? blockA : null),
      finalizedBlockNumber: async () => 5n,
    };
    const result = await h.makeDispatcher(viewA).dispatch(intent.intentId);
    assert.equal(result, "FINALIZED");
    assert.equal(
      await h.intentState(),
      "FINALIZED",
      "not FAILED by the stale observer",
    );
    const [attempt] = await h.attempts();
    assert.deepEqual(
      {
        status: attempt!.status,
        receipt: attempt!.receipt_status,
        spent: attempt!.spent,
      },
      { status: "FINALIZED", receipt: "success", spent: "40" },
    );
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "40" });
  } finally {
    await h.t.close();
  }
});

test("a signer outage never stops the dispatcher from observing versions that are already signed", async () => {
  const h = await harness();
  try {
    const intent = await h.keeperIntent();
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
    const [v1] = await h.attempts();
    await h.advance(120);
    h.signerMode.unknown = true;
    // The replacement is requested but the signer does not answer; v1 is still pending.
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "PENDING");
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "PENDING");
    assert.equal(
      (
        await h.rows(
          "SELECT state FROM signing.sign_requests WHERE artifact_version = 2",
        )
      )[0]!.state,
      "REQUESTED",
    );

    // Meanwhile v1 is mined: it is found, charged and tracked although the signer is down.
    h.chain.lookups.length = 0;
    h.mine(v1!.hash as Hex, 10n, { gasSpentWei: 10n });
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
    assert.ok(h.chain.lookups.includes((v1!.hash as string).toLowerCase()));
    assert.equal(await h.intentState(), "INCLUDED");
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "10" });
    h.chain.finalized = 10n;
    // Finality is recorded although the signer is down; only the unsigned replacement is left
    // to reconcile, so the job is not done yet.
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "PENDING");
    assert.equal(await h.intentState(), "FINALIZED");
    assert.equal((await h.attempts())[0]!.status, "FINALIZED");
    h.signerMode.unknown = false;
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "FINALIZED");
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "10" });
  } finally {
    await h.t.close();
  }
});

test("a send that loses to a higher-priced pooled version is UNKNOWN, not a failure", async () => {
  const h = await harness();
  try {
    const intent = await h.keeperIntent();
    h.chain.send = [{ state: "UNDERPRICED" }];
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "UNKNOWN");
    assert.equal((await h.attempts())[0]!.status, "UNKNOWN");
    assert.equal(await h.intentState(), "UNKNOWN");
    assert.equal(h.chain.sent.length, 1, "not blindly resent");
  } finally {
    await h.t.close();
  }
});

// v1 is signed and broadcast, then the business clock moves and the dispatcher asks for v2, whose
// plan (and gas reservation) commits but whose signing transaction dies before it commits.
async function withCrashedReplacementPlan(
  h: Awaited<ReturnType<typeof harness>>,
) {
  const intent = await h.keeperIntent();
  assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
  const [v1] = await h.attempts();
  await h.advance(120);
  h.faults.crashAfterArtifact = true;
  assert.equal(await h.dispatcher.dispatch(intent.intentId), "PENDING");
  h.faults.crashAfterArtifact = false;
  const [plan] = await h.rows(
    `SELECT p.sign_request_id AS id, p.nonce::int AS nonce, p.max_cost_wei::text AS cost,
      p.max_fee_per_gas::text AS fee, p.max_priority_fee_per_gas::text AS tip
    FROM signing.signing_plans p JOIN signing.sign_requests r ON r.id = p.sign_request_id
    WHERE r.artifact_version = 2`,
  );
  assert.ok(plan, "v2's plan was committed");
  return { intent, v1: v1!, plan: plan! };
}
const requestStates = (h: Awaited<ReturnType<typeof harness>>) =>
  h.rows(
    "SELECT artifact_version AS v, state, reject_code FROM signing.sign_requests ORDER BY artifact_version",
  );

test("a replacement planned but never signed returns its reservation once the original is final, exactly once", async () => {
  const h = await harness();
  try {
    const { intent, v1, plan } = await withCrashedReplacementPlan(h);
    const c1 = BigInt(v1.max_cost as string);
    const c2 = BigInt(plan.cost as string);
    assert.deepEqual(await h.ledger(), {
      reserved: (c1 + c2).toString(),
      spent: "0",
    });
    // The signing retry crashes again; the plan is reused, never duplicated.
    h.faults.crashAfterArtifact = true;
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "PENDING");
    h.faults.crashAfterArtifact = false;
    assert.equal(
      (await h.rows("SELECT 1 FROM signing.signing_plans")).length,
      2,
    );
    assert.deepEqual(await h.ledger(), {
      reserved: (c1 + c2).toString(),
      spent: "0",
    });

    // v1 becomes canonical and final at cost 10.
    h.mine(v1.hash as Hex, 7n, { gasSpentWei: 10n });
    h.chain.finalized = 7n;
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "FINALIZED");
    assert.equal(await h.intentState(), "FINALIZED");
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "10" });
    assert.deepEqual(await requestStates(h), [
      { v: 1, state: "SIGNED", reject_code: null },
      { v: 2, state: "REJECTED", reject_code: "SUPERSEDED_BY_FINAL" },
    ]);
    assert.equal((await h.rows("SELECT 1 FROM signing.artifacts")).length, 1);
    assert.equal((await h.attempts()).length, 1);
    // The plan row is immutable evidence: still there, unchanged.
    const [kept] = await h.rows(
      `SELECT p.nonce::int AS nonce, p.max_cost_wei::text AS cost, p.max_fee_per_gas::text AS fee,
        p.max_priority_fee_per_gas::text AS tip
      FROM signing.signing_plans p WHERE p.sign_request_id = $1`,
      [plan.id],
    );
    assert.deepEqual(kept, {
      nonce: plan.nonce,
      cost: plan.cost,
      fee: plan.fee,
      tip: plan.tip,
    });

    // Repeating the dispatch changes nothing and never asks the signer again.
    const asked = h.signerLog.length;
    for (let i = 0; i < 3; i += 1)
      assert.equal(await h.dispatcher.dispatch(intent.intentId), "FINALIZED");
    assert.equal(h.signerLog.length, asked);
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "10" });
    assert.equal(
      (
        await h.rows(
          "SELECT 1 FROM operations.audit_log WHERE action = 'signer.plan_abandoned'",
        )
      ).length,
      1,
      "released and reported once",
    );
  } finally {
    await h.t.close();
  }
});

test("the replacement's reservation is kept while the original is only included, and whatever is left is reconciled when it is final", async () => {
  const h = await harness();
  try {
    const { intent, v1, plan } = await withCrashedReplacementPlan(h);
    const c1 = BigInt(v1.max_cost as string);
    const c2 = BigInt(plan.cost as string);
    h.mine(v1.hash as Hex, 7n, { gasSpentWei: 10n });
    const asked = h.signerLog.length;
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
    // Not final: the inclusion can still reorg and v2 may still be needed.
    assert.deepEqual(await h.ledger(), {
      reserved: c2.toString(),
      spent: "10",
    });
    assert.equal((await requestStates(h))[1]!.state, "REQUESTED");
    assert.equal(h.signerLog.length, asked, "the signer is not asked yet");

    // The inclusion reorgs: v1 is pending again and holds its reservation next to v2's. The
    // healthy signer now finishes the replacement it had planned.
    h.chain.receipts.delete((v1.hash as string).toLowerCase());
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
    assert.deepEqual(await h.ledger(), {
      reserved: (c1 + c2).toString(),
      spent: "0",
    });
    assert.equal((await requestStates(h))[1]!.state, "SIGNED");
    assert.equal((await h.attempts()).length, 2);

    // v1 is mined again and final: the signed v2 is REPLACED and gives its reservation back.
    h.mine(v1.hash as Hex, 9n, { gasSpentWei: 12n });
    h.chain.finalized = 9n;
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "FINALIZED");
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "12" });
    assert.deepEqual(
      (await h.attempts()).map((a) => [a.status, a.reserved, a.spent]),
      [
        ["FINALIZED", "0", "12"],
        ["REPLACED", "0", "0"],
      ],
    );
  } finally {
    await h.t.close();
  }
});

test("a final outcome observed during a signer outage is recorded, and the job only stops after the reconciliation", async () => {
  const h = await harness();
  try {
    const { intent, v1, plan } = await withCrashedReplacementPlan(h);
    const c2 = BigInt(plan.cost as string);
    h.mine(v1.hash as Hex, 7n, { gasSpentWei: 10n });
    h.chain.finalized = 7n;
    h.signerMode.unknown = true;
    // The receipt is observed, charged and finalized regardless of the signer...
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "PENDING");
    assert.equal(await h.intentState(), "FINALIZED");
    assert.equal((await h.attempts())[0]!.status, "FINALIZED");
    // ...but the unsigned replacement still holds gas, so the job must come back.
    assert.deepEqual(await h.ledger(), {
      reserved: c2.toString(),
      spent: "10",
    });
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "PENDING");
    h.signerMode.unknown = false;
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "FINALIZED");
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "10" });

    // The handler agrees: pending while unreconciled, done afterwards.
    const handler = createTxDispatchHandler(h.dispatcher);
    await handler({
      job: { id: "j", payload: { intentId: intent.intentId } },
      signal: new AbortController().signal,
    });
  } finally {
    await h.t.close();
  }
});

test("a version signed just before the outcome became final still gets its attempt and is replaced", async () => {
  const h = await harness();
  try {
    const intent = await h.keeperIntent();
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
    const [v1] = await h.attempts();
    // v2 is signed by a retry that won the race, before the dispatcher has an attempt for it.
    const fees = minimumReplacementFees({
      maxFeePerGas: BigInt(v1!.max_fee as string),
      maxPriorityFeePerGas: BigInt(v1!.tip as string),
    });
    const second = await prepareRequest(
      h.t.pool as unknown as Parameters<typeof prepareRequest>[0],
      h.manifest,
      {
        kind: "FINALIZE_TIMEOUT",
        payload: {
          to: testMarket,
          functionName: "finalizeTimeout",
          args: ["3"],
          maxFeePerGas: fees.maxFeePerGas.toString(),
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
        },
        intentId: intent.intentId,
        version: 2,
      },
    );
    assert.equal(
      (
        await h.signer.sign({
          signRequestId: second.signRequestId,
          expectedRequestHash: second.requestHash,
        })
      ).state,
      "SIGNED",
    );
    // Another observer finalized v1 meanwhile (state set directly: this is the interleaving).
    await h.t.db.exec(`
      UPDATE signing.tx_attempts SET status = 'FINALIZED', receipt_status = 'success', gas_reserved_wei = 0, gas_spent_wei = 10;
      UPDATE signing.gas_spend SET reserved_wei = reserved_wei - ${v1!.max_cost}, spent_wei = 10;
      UPDATE signing.economic_intents SET state = 'FINALIZED';
    `);
    assert.equal((await h.attempts()).length, 1);
    assert.equal(await h.dispatcher.dispatch(intent.intentId), "FINALIZED");
    assert.deepEqual(
      (await h.attempts()).map((a) => [a.status, a.reserved, a.spent]),
      [
        ["FINALIZED", "0", "10"],
        ["REPLACED", "0", "0"],
      ],
    );
    assert.deepEqual(await h.ledger(), { reserved: "0", spent: "10" });
    assert.equal(
      h.chain.sent.length,
      1,
      "the late version is never broadcast after the outcome is final",
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
