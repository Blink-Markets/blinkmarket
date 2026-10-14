import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTransaction,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  serializeTransaction,
  type Hex,
} from "viem";
import {
  assertSignerStartup,
  createSignerService,
  QuoteCheckRejection,
  quoteRequestHash,
  quoteTypedData,
  transactionRequestHash,
} from "../packages/application/src/signer.js";
import {
  minimumReplacementFees,
  parseQuoteMessage,
  SIGNING_POLICY_VERSION,
} from "../packages/domain/src/signing-policy.js";
import { encodeAllowedCall } from "../packages/adapters/src/signing-calldata.js";
import {
  assertSignerRuntimeRole,
  postgresSignerStore,
} from "../packages/adapters/src/signing-store.js";
import { readKeyFile } from "../packages/adapters/src/key-file.js";
import type {
  SignerRpc,
  SigningSqlClient,
} from "../packages/ports/src/index.js";
import { createTestDatabase } from "./helpers/database.js";
import {
  prepareRequest,
  privateKeyOf,
  seedChain,
  seedDeployment,
  sha256Hex,
  testAccounts,
  testManifest,
  testMarket,
  testQuote,
  testToken,
} from "./helpers/signer-fixture.js";

const tokens = { api: "api-token", worker: "worker-token" };
const callers = [
  {
    name: "quote-api",
    tokenSha256: sha256Hex(tokens.api),
    roles: ["maker" as const],
  },
  {
    name: "worker",
    tokenSha256: sha256Hex(tokens.worker),
    roles: ["keeper" as const, "faucet" as const, "trader" as const],
  },
];
const fullPolicy = {
  l1FeeMode: "local-none" as const,
  perTxCapWei: 200_000_000_000_000n,
  dailyCapWei: 2_000_000_000_000_000n,
};
// gas 100k -> limit 120k; maxFee = 2 * 1_000_000 + 100_000 = 2_100_000; maxCost = 252_000_000_000 wei.
const MAX_COST = 252_000_000_000n;

async function harness(
  options: {
    policy?:
      | typeof fullPolicy
      | {
          l1FeeMode: "oracle" | "local-none";
          perTxCapWei: bigint;
          dailyCapWei: bigint;
        };
    quoteCheck?: Parameters<typeof createSignerService>[0]["quoteCheck"];
  } = {},
) {
  const t = await createTestDatabase();
  const manifest = testManifest();
  await seedDeployment(t.db, manifest);
  await seedChain(t.db, { deploymentId: manifest.deploymentId });
  const state = {
    gas: 100_000n,
    baseFee: 1_000_000n,
    priority: 100_000n,
    pending: 5n,
    l1Fee: 7n,
    estimateFails: false,
    unavailable: false,
    nowMs: 1_010_000,
    estimateCalls: 0,
    l1Inputs: [] as Hex[],
    errors: [] as unknown[],
  };
  const guard = () => {
    if (state.unavailable) throw new Error("RPC_UNAVAILABLE");
  };
  const rpc: SignerRpc = {
    async chainId() {
      guard();
      return 84532;
    },
    async estimateGas() {
      guard();
      state.estimateCalls += 1;
      if (state.estimateFails) throw new Error("execution reverted");
      return state.gas;
    },
    async baseFeePerGas() {
      guard();
      return state.baseFee;
    },
    async maxPriorityFeePerGas() {
      guard();
      return state.priority;
    },
    async pendingNonce() {
      guard();
      return state.pending;
    },
    async l1Fee(serialized) {
      guard();
      state.l1Inputs.push(serialized);
      return state.l1Fee;
    },
  };
  const baseStore = postgresSignerStore(t.pool);
  const faults = { crashAfterArtifact: false };
  const insertedHashes: Hex[] = [];
  const store: typeof baseStore = {
    loadDeployment: (id) => baseStore.loadDeployment(id),
    run: (work) =>
      baseStore.run((tx) =>
        work({
          ...tx,
          async insertArtifact(input) {
            insertedHashes.push(input.artifactHash);
            await tx.insertArtifact(input);
          },
          async markSigned(signRequestId, intentId) {
            // The process dies after signing and persisting, before the transaction commits.
            if (faults.crashAfterArtifact) throw new Error("CRASH_AFTER_SIGN");
            await tx.markSigned(signRequestId, intentId);
          },
        }),
      ),
  };
  const service = createSignerService({
    store,
    keys: {
      maker: testAccounts.maker,
      faucet: testAccounts.minter,
      keeper: testAccounts.keeper,
      trader: testAccounts.trader,
    },
    rpc,
    deployment: manifest,
    callers,
    policy: options.policy ?? fullPolicy,
    encodeCall: encodeAllowedCall,
    now: () => state.nowMs,
    onError: (error) => state.errors.push(error),
    ...(options.quoteCheck ? { quoteCheck: options.quoteCheck } : {}),
  });
  const client = t.pool as unknown as SigningSqlClient;
  const scalar = async (sql: string, params?: unknown[]) =>
    (await t.db.query(sql, params)).rows[0] as Record<string, unknown>;
  const call = async (
    kind: Parameters<typeof prepareRequest>[2]["kind"],
    payload: Record<string, unknown>,
    options: { token?: string; intentId?: string; version?: number } = {},
  ) => {
    const prepared = await prepareRequest(client, manifest, {
      kind,
      payload,
      ...(options.intentId ? { intentId: options.intentId } : {}),
      ...(options.version ? { version: options.version } : {}),
    });
    const response = await service.handle(
      options.token ?? (kind === "MAKER_QUOTE" ? tokens.api : tokens.worker),
      {
        signRequestId: prepared.signRequestId,
        expectedRequestHash: prepared.requestHash,
      },
    );
    return { ...prepared, response };
  };
  return {
    t,
    manifest,
    state,
    rpc,
    service,
    store,
    client,
    scalar,
    call,
    faults,
    insertedHashes,
  };
}

const senderOf = async (raw: Hex) =>
  (
    await recoverTransactionAddress({
      serializedTransaction: raw as `0x02${string}`,
    })
  ).toLowerCase();

const redeem = (id = "3") => ({
  to: testMarket,
  functionName: "redeem",
  args: [id],
});
const finalizeTimeout = (id = "3") => ({
  to: testMarket,
  functionName: "finalizeTimeout",
  args: [id],
});
const mint = (amount = "1000000000") => ({
  to: testToken,
  functionName: "mint",
  args: [testAccounts.taker.address, amount],
});

test("callers are authenticated by token hash and limited to their roles", async () => {
  const h = await harness();
  try {
    const prepared = await prepareRequest(h.client, h.manifest, {
      kind: "FINALIZE_TIMEOUT",
      payload: finalizeTimeout(),
    });
    const body = {
      signRequestId: prepared.signRequestId,
      expectedRequestHash: prepared.requestHash,
    };
    for (const token of [undefined, "", "wrong-token", tokens.worker + " "]) {
      const response = await h.service.handle(token, body);
      assert.equal(response.status, 401);
      assert.equal(response.body.code, "UNAUTHORIZED");
    }
    // The quote API holds only the maker role.
    const denied = await h.service.handle(tokens.api, body);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "ROLE_DENIED");
    // A caller allowed some roles still cannot sign a role it lacks (worker has no maker role).
    const quote = await prepareRequest(h.client, h.manifest, {
      kind: "MAKER_QUOTE",
      payload: testQuote,
    });
    const quoteDenied = await h.service.handle(tokens.worker, {
      signRequestId: quote.signRequestId,
      expectedRequestHash: quote.requestHash,
    });
    assert.equal(quoteDenied.status, 403);
    assert.equal(quoteDenied.body.code, "ROLE_DENIED");
    // Nothing was signed or allocated by any denied attempt.
    assert.equal(
      (await h.scalar("SELECT count(*)::int AS n FROM signing.artifacts")).n,
      0,
    );
    assert.equal(h.state.estimateCalls, 0);
    // Strict body.
    for (const bad of [
      null,
      "x",
      {},
      { ...body, extra: 1 },
      {
        signRequestId: "not-a-uuid",
        expectedRequestHash: body.expectedRequestHash,
      },
      { signRequestId: body.signRequestId, expectedRequestHash: "0x12" },
      { signRequestId: body.signRequestId },
    ]) {
      const response = await h.service.handle(tokens.worker, bad);
      assert.equal(response.status, 400, JSON.stringify(bad));
      assert.equal(response.body.code, "INVALID_REQUEST");
    }
    const missing = await h.service.handle(tokens.worker, {
      signRequestId: "00000000-0000-4000-8000-000000000000",
      expectedRequestHash: body.expectedRequestHash,
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "SIGN_REQUEST_NOT_FOUND");
  } finally {
    await h.t.close();
  }
});

test("a request hash that differs from the stored one: a pending request is rejected for good, a finished one replays only to a caller that agrees", async () => {
  const h = await harness();
  try {
    // A request still waiting for its signature is rejected and stays rejected.
    const pending = await prepareRequest(h.client, h.manifest, {
      kind: "FINALIZE_TIMEOUT",
      payload: finalizeTimeout(),
    });
    const wrong = await h.service.handle(tokens.worker, {
      signRequestId: pending.signRequestId,
      expectedRequestHash: "0x" + "00".repeat(32),
    });
    assert.deepEqual(
      { status: wrong.status, state: wrong.body.state, code: wrong.body.code },
      { status: 422, state: "REJECTED", code: "REQUEST_HASH_MISMATCH" },
    );
    assert.deepEqual(
      await h.scalar(
        "SELECT state, reject_code FROM signing.sign_requests WHERE id = $1",
        [pending.signRequestId],
      ),
      { state: "REJECTED", reject_code: "REQUEST_HASH_MISMATCH" },
    );
    const afterwards = await h.service.handle(tokens.worker, {
      signRequestId: pending.signRequestId,
      expectedRequestHash: pending.requestHash
        .toUpperCase()
        .replace("0X", "0x"),
    });
    assert.deepEqual(afterwards.body, {
      state: "REJECTED",
      code: "REQUEST_HASH_MISMATCH",
    });
    assert.equal(
      (await h.scalar("SELECT count(*)::int AS n FROM signing.artifacts")).n,
      0,
    );
    assert.equal(
      (await h.scalar("SELECT count(*)::int AS n FROM signing.signing_plans"))
        .n,
      0,
    );

    // A signed request replays its artifact to a caller that names the same hash, and reveals
    // nothing to one that does not.
    const signed = await h.call("FINALIZE_TIMEOUT", finalizeTimeout("4"));
    assert.equal(signed.response.body.state, "SIGNED");
    const mismatch = await h.service.handle(tokens.worker, {
      signRequestId: signed.signRequestId,
      expectedRequestHash: "0x" + "11".repeat(32),
    });
    assert.deepEqual(
      { status: mismatch.status, body: mismatch.body },
      {
        status: 422,
        body: { state: "REJECTED", code: "REQUEST_HASH_MISMATCH" },
      },
    );
    assert.deepEqual(
      await h.scalar(
        "SELECT state, reject_code FROM signing.sign_requests WHERE id = $1",
        [signed.signRequestId],
      ),
      { state: "SIGNED", reject_code: null },
    );
    assert.equal(
      (await h.scalar("SELECT count(*)::int AS n FROM signing.artifacts")).n,
      1,
    );
    assert.deepEqual(
      await h.service.handle(tokens.worker, {
        signRequestId: signed.signRequestId,
        expectedRequestHash: signed.requestHash,
      }),
      signed.response,
    );

    // A rejected request replays its own code to a caller that agrees, never to one that does not.
    const bad = await h.call("REDEEM", { ...redeem(), data: "0xa9059cbb" });
    assert.equal(bad.response.body.code, "PAYLOAD_INVALID");
    const badMismatch = await h.service.handle(tokens.worker, {
      signRequestId: bad.signRequestId,
      expectedRequestHash: "0x" + "22".repeat(32),
    });
    assert.deepEqual(badMismatch.body, {
      state: "REJECTED",
      code: "REQUEST_HASH_MISMATCH",
    });
    assert.equal(
      (
        await h.scalar(
          "SELECT reject_code FROM signing.sign_requests WHERE id = $1",
          [bad.signRequestId],
        )
      ).reject_code,
      "PAYLOAD_INVALID",
    );
  } finally {
    await h.t.close();
  }
});

test("signing a transaction is deterministic, idempotent and uses the role's own key", async () => {
  const h = await harness();
  try {
    const first = await h.call("FINALIZE_TIMEOUT", finalizeTimeout());
    assert.equal(first.response.status, 200);
    assert.equal(first.response.body.state, "SIGNED");
    const artifactHash = first.response.body.artifactHash as Hex;
    assert.equal(first.response.body.txHash, artifactHash);
    const again = await h.service.handle(tokens.worker, {
      signRequestId: first.signRequestId,
      expectedRequestHash: first.requestHash,
    });
    assert.deepEqual(
      again,
      first.response,
      "a retry returns the one persisted artifact",
    );
    assert.equal(
      (await h.scalar("SELECT count(*)::int AS n FROM signing.artifacts")).n,
      1,
    );
    assert.equal(
      (
        await h.scalar(
          "SELECT count(*)::int AS n FROM signing.nonce_allocations",
        )
      ).n,
      1,
    );
    assert.equal(
      h.state.estimateCalls,
      1,
      "the retry did not estimate or sign again",
    );
    const gas = await h.scalar(
      "SELECT reserved_wei::text AS reserved, spent_wei::text AS spent FROM signing.gas_spend WHERE role = 'keeper'",
    );
    assert.deepEqual(gas, { reserved: MAX_COST.toString(), spent: "0" });

    const stored = await h.scalar(
      "SELECT raw_transaction, '0x' || encode(artifact_hash, 'hex') AS hash, max_cost_wei::text AS cost, signature FROM signing.artifacts",
    );
    assert.equal(stored.hash, artifactHash);
    assert.equal(stored.cost, MAX_COST.toString());
    assert.equal(stored.signature, null);
    const raw = stored.raw_transaction as Hex;
    const tx = parseTransaction(raw);
    assert.equal(tx.type, "eip1559");
    assert.equal(tx.chainId, 84532);
    assert.equal(
      tx.nonce,
      5,
      "first allocation starts at the RPC pending nonce",
    );
    assert.equal(tx.to?.toLowerCase(), testMarket);
    assert.equal(tx.value ?? 0n, 0n);
    assert.equal(tx.gas, 120_000n);
    assert.equal(tx.maxFeePerGas, 2_100_000n);
    assert.equal(tx.maxPriorityFeePerGas, 100_000n);
    assert.equal(
      tx.data,
      encodeAllowedCall({
        to: testMarket,
        functionName: "finalizeTimeout",
        args: [3n],
      }),
    );
    assert.equal(
      await senderOf(raw),
      testAccounts.keeper.address.toLowerCase(),
    );
    const states = await h.scalar(
      `SELECT (SELECT state FROM signing.economic_intents) AS intent, (SELECT state FROM signing.sign_requests) AS request`,
    );
    assert.deepEqual(states, { intent: "SIGNED", request: "SIGNED" });

    // Roles sign with their own keys.
    const minted = await h.call("MINT", mint());
    const rawMint = (
      await h.scalar(
        "SELECT raw_transaction FROM signing.artifacts a JOIN signing.sign_requests r ON r.id = a.sign_request_id WHERE r.role = 'faucet'",
      )
    ).raw_transaction as Hex;
    assert.equal(minted.response.body.state, "SIGNED");
    assert.equal(
      await senderOf(rawMint),
      testAccounts.minter.address.toLowerCase(),
    );
  } finally {
    await h.t.close();
  }
});

test("nonces are allocated consecutively and an unknown occupant is never skipped over", async () => {
  const h = await harness();
  try {
    const a = await h.call("REDEEM", redeem("1"));
    const b = await h.call("REDEEM", redeem("2"));
    const nonces = (
      await h.t.db.query(
        "SELECT nonce::int AS nonce FROM signing.nonce_allocations ORDER BY nonce",
      )
    ).rows.map((row) => (row as { nonce: number }).nonce);
    assert.deepEqual(nonces, [5, 6], "pending nonce 5, then the next DB nonce");
    assert.equal(a.response.body.state, "SIGNED");
    assert.equal(b.response.body.state, "SIGNED");

    // Someone else used nonces 7 and 8 with the trader key: the DB would hand out 7.
    h.state.pending = 9n;
    const c = await h.call("REDEEM", redeem("3"));
    assert.deepEqual(
      {
        status: c.response.status,
        state: c.response.body.state,
        code: c.response.body.code,
      },
      { status: 422, state: "REJECTED", code: "NONCE_UNKNOWN_OCCUPANT" },
    );
    assert.equal(
      (
        await h.scalar(
          "SELECT count(*)::int AS n FROM signing.nonce_allocations",
        )
      ).n,
      2,
    );
    assert.equal(
      (await h.scalar("SELECT count(*)::int AS n FROM signing.artifacts")).n,
      2,
    );
    const alert = await h.scalar(
      "SELECT action, resource FROM operations.audit_log WHERE action = 'signer.nonce_unknown_occupant'",
    );
    assert.equal(alert.action, "signer.nonce_unknown_occupant");
    assert.match(String(alert.resource), /^0x[0-9a-f]{40}$/);
    // The rejection is persisted: a retry returns the same answer and never re-nonces.
    const retry = await h.service.handle(tokens.worker, {
      signRequestId: c.signRequestId,
      expectedRequestHash: c.requestHash,
    });
    assert.deepEqual(retry, c.response);
    assert.equal(
      (
        await h.scalar(
          "SELECT count(*)::int AS n FROM signing.nonce_allocations",
        )
      ).n,
      2,
    );
    // The intent stays unsigned; no new nonce or intent was invented for it.
    assert.equal(
      (
        await h.scalar(
          "SELECT state FROM signing.economic_intents WHERE id = $1",
          [c.intentId],
        )
      ).state,
      "PREPARED",
    );
  } finally {
    await h.t.close();
  }
});

test("gas caps: per transaction, per role and day, and the L1 fee counts", async () => {
  const h = await harness();
  try {
    h.state.gas = 1_000_000_000n;
    const tooBig = await h.call("FINALIZE_TIMEOUT", finalizeTimeout("1"));
    assert.equal(tooBig.response.body.code, "GAS_CAP_EXCEEDED");
    assert.equal(
      (
        await h.scalar(
          "SELECT count(*)::int AS n FROM signing.nonce_allocations",
        )
      ).n,
      0,
    );
    assert.equal(
      (
        await h.scalar(
          "SELECT coalesce(sum(reserved_wei), 0)::text AS n FROM signing.gas_spend",
        )
      ).n,
      "0",
      "a rejected request reserves nothing",
    );
    // Exactly at the cap is allowed; one wei over is not. maxCost = limit * 2_100_000.
    h.state.gas = 100_000n;
    const exact = await harness({
      policy: { ...fullPolicy, perTxCapWei: MAX_COST },
    });
    try {
      assert.equal(
        (await exact.call("REDEEM", redeem())).response.body.state,
        "SIGNED",
      );
    } finally {
      await exact.t.close();
    }
    const over = await harness({
      policy: { ...fullPolicy, perTxCapWei: MAX_COST - 1n },
    });
    try {
      assert.equal(
        (await over.call("REDEEM", redeem())).response.body.code,
        "GAS_CAP_EXCEEDED",
      );
    } finally {
      await over.t.close();
    }

    // Daily: reserved + spent + maxCost must stay within the role's cap for the UTC day.
    await h.t.db.query(
      `INSERT INTO signing.gas_spend(role, day, reserved_wei, spent_wei)
      VALUES ('keeper', (blink.now() AT TIME ZONE 'UTC')::date, $1, 0)
      ON CONFLICT (role, day) DO UPDATE SET reserved_wei = EXCLUDED.reserved_wei`,
      [(fullPolicy.dailyCapWei - MAX_COST + 1n).toString()],
    );
    const daily = await h.call("FINALIZE_TIMEOUT", finalizeTimeout("2"));
    assert.equal(daily.response.body.code, "GAS_DAILY_CAP_EXCEEDED");
    await h.t.db.query(
      "UPDATE signing.gas_spend SET reserved_wei = $1, spent_wei = 0 WHERE role = 'keeper'",
      [(fullPolicy.dailyCapWei - MAX_COST).toString()],
    );
    const fits = await h.call("FINALIZE_TIMEOUT", finalizeTimeout("3"));
    assert.equal(fits.response.body.state, "SIGNED");
    assert.equal(
      (
        await h.scalar(
          "SELECT reserved_wei::text AS r FROM signing.gas_spend WHERE role = 'keeper'",
        )
      ).r,
      fullPolicy.dailyCapWei.toString(),
      "the reservation is added on success",
    );
    // Another role has its own day budget.
    assert.equal((await h.call("MINT", mint())).response.body.state, "SIGNED");
  } finally {
    await h.t.close();
  }
});

test("oracle mode adds the L1 data fee over the unsigned serialized transaction; failures reject or stay unknown", async () => {
  const h = await harness({ policy: { ...fullPolicy, l1FeeMode: "oracle" } });
  try {
    const signed = await h.call("MINT", mint());
    assert.equal(signed.response.body.state, "SIGNED");
    assert.equal(h.state.l1Inputs.length, 1);
    const raw = (
      await h.scalar("SELECT raw_transaction FROM signing.artifacts")
    ).raw_transaction as Hex;
    const tx = parseTransaction(raw);
    assert.equal(
      h.state.l1Inputs[0],
      serializeTransaction({
        type: "eip1559",
        chainId: 84532,
        to: tx.to!,
        data: tx.data!,
        value: 0n,
        nonce: tx.nonce!,
        gas: tx.gas!,
        maxFeePerGas: tx.maxFeePerGas!,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas!,
      }),
    );
    assert.equal(
      (await h.scalar("SELECT max_cost_wei::text AS c FROM signing.artifacts"))
        .c,
      (MAX_COST + 7n).toString(),
    );

    // Estimation failure is a persisted rejection, and nothing was allocated or reserved.
    h.state.estimateFails = true;
    const failed = await h.call("REDEEM", redeem());
    assert.equal(failed.response.body.code, "GAS_ESTIMATE_FAILED");
    assert.equal(
      (
        await h.scalar(
          "SELECT count(*)::int AS n FROM signing.nonce_allocations",
        )
      ).n,
      1,
    );

    // An unreachable RPC says nothing about the request: UNKNOWN, nothing persisted, retryable.
    h.state.estimateFails = false;
    h.state.unavailable = true;
    const down = await h.call("REDEEM", redeem("9"));
    assert.deepEqual(
      {
        status: down.response.status,
        state: down.response.body.state,
        code: down.response.body.code,
      },
      { status: 503, state: "UNKNOWN", code: "RPC_UNAVAILABLE" },
    );
    assert.equal(
      (
        await h.scalar(
          "SELECT state FROM signing.sign_requests WHERE id = $1",
          [down.signRequestId],
        )
      ).state,
      "REQUESTED",
    );
    assert.deepEqual(
      h.state.errors.map((e) => (e as Error).message),
      ["RPC_UNAVAILABLE"],
    );
    h.state.unavailable = false;
    const recovered = await h.service.handle(tokens.worker, {
      signRequestId: down.signRequestId,
      expectedRequestHash: down.requestHash,
    });
    assert.equal(recovered.body.state, "SIGNED");
  } finally {
    await h.t.close();
  }
});

test("hostile payloads are rejected before gas, nonce or signature work", async () => {
  const h = await harness();
  try {
    const cases: [
      Parameters<typeof prepareRequest>[2]["kind"],
      Record<string, unknown>,
      string,
    ][] = [
      ["REDEEM", { ...redeem(), data: "0xa9059cbb" }, "PAYLOAD_INVALID"],
      ["REDEEM", { ...redeem(), value: "1" }, "PAYLOAD_INVALID"],
      [
        "FINALIZE_TIMEOUT",
        { ...finalizeTimeout(), functionName: "withdrawMaker" },
        "SELECTOR_NOT_ALLOWED",
      ],
      [
        "FINALIZE_TIMEOUT",
        { ...finalizeTimeout(), to: testToken },
        "TARGET_NOT_ALLOWED",
      ],
      ["MINT", mint("1000000001"), "AMOUNT_NOT_ALLOWED"],
      [
        "APPROVE",
        {
          to: testToken,
          functionName: "approve",
          args: [testMarket, (2n ** 256n - 1n).toString()],
        },
        "AMOUNT_NOT_ALLOWED",
      ],
      [
        "FILL",
        {
          to: testMarket,
          functionName: "fillQuote",
          args: [
            { ...testQuote, taker: testAccounts.taker.address },
            "0x" + "ab".repeat(65),
          ],
        },
        "TAKER_NOT_ALLOWED",
      ],
    ];
    for (const [kind, payload, code] of cases) {
      const result = await h.call(kind, payload);
      assert.equal(result.response.body.code, code, JSON.stringify(payload));
    }
    assert.equal(h.state.estimateCalls, 0);
    assert.equal(
      (await h.scalar("SELECT count(*)::int AS n FROM signing.artifacts")).n,
      0,
    );
    assert.equal(
      (
        await h.scalar(
          "SELECT count(*)::int AS n FROM signing.nonce_allocations",
        )
      ).n,
      0,
    );

    // A stored hash that does not match the payload (tampered row) is refused.
    const prepared = await prepareRequest(h.client, h.manifest, {
      kind: "REDEEM",
      payload: redeem("4"),
    });
    await h.t.db.query(
      "UPDATE signing.sign_requests SET request_hash = decode($2, 'hex') WHERE id = $1",
      [prepared.signRequestId, "ab".repeat(32)],
    );
    const tampered = await h.service.handle(tokens.worker, {
      signRequestId: prepared.signRequestId,
      expectedRequestHash: "0x" + "ab".repeat(32),
    });
    assert.equal(tampered.body.code, "PAYLOAD_HASH_MISMATCH");

    // A signer policy version it does not run is refused.
    const odd = await prepareRequest(h.client, h.manifest, {
      kind: "REDEEM",
      payload: redeem("5"),
    });
    await h.t.db.query(
      "UPDATE signing.sign_requests SET policy_version = 'other' WHERE id = $1",
      [odd.signRequestId],
    );
    const refused = await h.service.handle(tokens.worker, {
      signRequestId: odd.signRequestId,
      expectedRequestHash: odd.requestHash,
    });
    assert.equal(refused.body.code, "POLICY_VERSION_UNSUPPORTED");

    // Intents that can no longer be signed.
    const cancelled = await prepareRequest(h.client, h.manifest, {
      kind: "REDEEM",
      payload: redeem("6"),
    });
    await h.t.db.query(
      "UPDATE signing.economic_intents SET state = 'CANCELLED' WHERE id = $1",
      [cancelled.intentId],
    );
    const refusedCancelled = await h.service.handle(tokens.worker, {
      signRequestId: cancelled.signRequestId,
      expectedRequestHash: cancelled.requestHash,
    });
    assert.equal(refusedCancelled.body.code, "INTENT_NOT_SIGNABLE");

    // A disabled deployment signs nothing.
    await h.t.db.query("UPDATE markets.deployments SET enabled = false");
    const disabled = await h.call("REDEEM", redeem("7"));
    assert.equal(disabled.response.body.code, "DEPLOYMENT_DISABLED");
  } finally {
    await h.t.close();
  }
});

test("a replacement reuses the nonce and calldata, only raises fees by 12.5 percent, and reserves its own gas", async () => {
  const h = await harness();
  try {
    const first = await h.call("FINALIZE_TIMEOUT", finalizeTimeout("8"));
    const rawOf = async (version: number) =>
      (
        await h.scalar(
          `SELECT a.raw_transaction FROM signing.artifacts a JOIN signing.sign_requests r ON r.id = a.sign_request_id
        WHERE r.artifact_version = $1`,
          [version],
        )
      ).raw_transaction as Hex;
    const v1 = parseTransaction(await rawOf(1));
    assert.equal(v1.maxFeePerGas, 2_100_000n);
    const bump = (n: bigint) => (n * 1125n + 999n) / 1000n;
    const replacementPayload = {
      ...finalizeTimeout("8"),
      maxFeePerGas: bump(v1.maxFeePerGas!).toString(),
      maxPriorityFeePerGas: bump(v1.maxPriorityFeePerGas!).toString(),
    };
    // The replacement signs the same intent under the next artifact version.
    const second = await h.call("FINALIZE_TIMEOUT", replacementPayload, {
      intentId: first.intentId,
      version: 2,
    });
    assert.equal(second.response.body.state, "SIGNED");
    assert.notEqual(
      second.response.body.artifactHash,
      first.response.body.artifactHash,
    );
    const v2 = parseTransaction(await rawOf(2));
    assert.equal(v2.nonce, v1.nonce, "same nonce");
    assert.equal(v2.data, v1.data, "same calldata");
    assert.equal(v2.to, v1.to);
    assert.equal(v2.gas, v1.gas);
    assert.equal(v2.maxFeePerGas, bump(v1.maxFeePerGas!));
    assert.equal(v2.maxPriorityFeePerGas, bump(v1.maxPriorityFeePerGas!));
    assert.equal(
      (
        await h.scalar(
          "SELECT count(*)::int AS n FROM signing.nonce_allocations",
        )
      ).n,
      1,
    );
    assert.equal(
      h.state.estimateCalls,
      1,
      "a replacement does not re-estimate",
    );
    const reserved = (
      await h.scalar(
        "SELECT reserved_wei::text AS r FROM signing.gas_spend WHERE role = 'keeper'",
      )
    ).r;
    assert.equal(
      reserved,
      (MAX_COST + 120_000n * bump(v1.maxFeePerGas!)).toString(),
    );

    // A third version below +12.5 percent over the second is refused and persisted as such.
    const lowPayload = {
      ...replacementPayload,
      maxFeePerGas: (bump(v2.maxFeePerGas!) - 1n).toString(),
      maxPriorityFeePerGas: bump(v2.maxPriorityFeePerGas!).toString(),
    };
    const low = await h.call("FINALIZE_TIMEOUT", lowPayload, {
      intentId: first.intentId,
      version: 3,
    });
    assert.equal(low.response.body.code, "REPLACEMENT_FEE_TOO_LOW");
  } finally {
    await h.t.close();
  }
});

test("a replacement may not change the calldata or skip a version", async () => {
  const h = await harness();
  try {
    const first = await h.call("FINALIZE_TIMEOUT", finalizeTimeout("8"));
    const fees = { maxFeePerGas: "5000000", maxPriorityFeePerGas: "500000" };
    const changed = await h.call(
      "FINALIZE_TIMEOUT",
      { ...finalizeTimeout("9"), ...fees },
      { intentId: first.intentId, version: 2 },
    );
    assert.equal(changed.response.body.code, "REPLACEMENT_CALLDATA_CHANGED");
    const other = await h.call("FINALIZE_TIMEOUT", finalizeTimeout("12"));
    const skipped = await h.call(
      "FINALIZE_TIMEOUT",
      { ...finalizeTimeout("12"), ...fees },
      { intentId: other.intentId, version: 3 },
    );
    assert.equal(skipped.response.body.code, "REPLACEMENT_BASE_MISSING");
    // A replacement payload without fee fields (or a first version with them) is malformed.
    const noFees = await h.call("FINALIZE_TIMEOUT", finalizeTimeout("12"), {
      intentId: other.intentId,
      version: 2,
    });
    assert.equal(noFees.response.body.code, "PAYLOAD_INVALID");
    assert.equal(
      (
        await h.scalar(
          "SELECT count(*)::int AS n FROM signing.nonce_allocations",
        )
      ).n,
      2,
    );
  } finally {
    await h.t.close();
  }
});

test("a crash after signing re-signs the same bytes even if the base fee moved, and nobody takes the nonce in between", async () => {
  const h = await harness();
  try {
    const first = await prepareRequest(h.client, h.manifest, {
      kind: "FINALIZE_TIMEOUT",
      payload: finalizeTimeout("8"),
    });
    const body = {
      signRequestId: first.signRequestId,
      expectedRequestHash: first.requestHash,
    };
    h.faults.crashAfterArtifact = true;
    const lost = await h.service.handle(tokens.worker, body);
    assert.deepEqual(
      { status: lost.status, code: lost.body.code },
      { status: 503, code: "SIGNER_ERROR" },
    );
    assert.equal(
      h.insertedHashes.length,
      1,
      "a signature existed in the dying process",
    );
    // The plan, the nonce allocation and the gas reservation were committed before signing.
    assert.deepEqual(
      await h.scalar(
        `SELECT nonce::int AS nonce, gas_limit::text AS gas, max_fee_per_gas::text AS fee,
          max_priority_fee_per_gas::text AS tip, max_cost_wei::text AS cost FROM signing.signing_plans`,
      ),
      {
        nonce: 5,
        gas: "120000",
        fee: "2100000",
        tip: "100000",
        cost: MAX_COST.toString(),
      },
    );
    assert.equal(
      (
        await h.scalar(
          "SELECT nonce::int AS nonce FROM signing.nonce_allocations",
        )
      ).nonce,
      5,
    );
    assert.equal(
      (
        await h.scalar(
          "SELECT reserved_wei::text AS r FROM signing.gas_spend WHERE role = 'keeper'",
        )
      ).r,
      MAX_COST.toString(),
    );
    assert.equal(
      (await h.scalar("SELECT count(*)::int AS n FROM signing.artifacts")).n,
      0,
    );
    assert.equal(
      (
        await h.scalar(
          "SELECT state FROM signing.sign_requests WHERE id = $1",
          [first.signRequestId],
        )
      ).state,
      "REQUESTED",
    );

    // Between the crash and the retry the fee market moves and another intent is signed.
    h.faults.crashAfterArtifact = false;
    h.state.baseFee = 9_000_000n;
    h.state.pending = 5n;
    const other = await h.call("FINALIZE_TIMEOUT", finalizeTimeout("7"));
    assert.equal(other.response.body.state, "SIGNED");
    assert.equal(
      (
        await h.scalar(
          "SELECT nonce::int AS nonce FROM signing.nonce_allocations WHERE intent_id = $1",
          [other.intentId],
        )
      ).nonce,
      6,
      "the crashed request's nonce was not reused by anyone else",
    );
    const estimates = h.state.estimateCalls;

    const again = await h.service.handle(tokens.worker, body);
    assert.equal(again.body.state, "SIGNED");
    assert.equal(
      again.body.txHash,
      h.insertedHashes[0],
      "same bytes, same hash",
    );
    assert.equal(h.insertedHashes.at(-1), h.insertedHashes[0]);
    assert.equal(
      h.state.estimateCalls,
      estimates,
      "a planned request never asks the chain again",
    );
    const raw = (
      await h.scalar(
        "SELECT raw_transaction FROM signing.artifacts WHERE sign_request_id = $1",
        [first.signRequestId],
      )
    ).raw_transaction as Hex;
    const tx = parseTransaction(raw);
    assert.equal(tx.nonce, 5);
    assert.equal(
      tx.maxFeePerGas,
      2_100_000n,
      "the planned fee, not the new market",
    );
    assert.equal(tx.gas, 120_000n);
    // The reservation was made once per request, not again by the retry.
    const otherCost = 120_000n * (2n * 9_000_000n + 100_000n);
    assert.equal(
      (
        await h.scalar(
          "SELECT reserved_wei::text AS r FROM signing.gas_spend WHERE role = 'keeper'",
        )
      ).r,
      (MAX_COST + otherCost).toString(),
    );
    assert.equal(
      (await h.scalar("SELECT count(*)::int AS n FROM signing.signing_plans"))
        .n,
      2,
    );
  } finally {
    await h.t.close();
  }
});

test("a planned request that is rejected afterwards gives its gas back and raises a nonce-hole alert", async () => {
  const h = await harness();
  try {
    const request = await prepareRequest(h.client, h.manifest, {
      kind: "FINALIZE_TIMEOUT",
      payload: finalizeTimeout("8"),
    });
    const body = {
      signRequestId: request.signRequestId,
      expectedRequestHash: request.requestHash,
    };
    h.faults.crashAfterArtifact = true;
    await h.service.handle(tokens.worker, body);
    h.faults.crashAfterArtifact = false;
    const reserved = async () =>
      (
        await h.scalar(
          "SELECT reserved_wei::text AS r FROM signing.gas_spend WHERE role = 'keeper'",
        )
      ).r;
    assert.equal(await reserved(), MAX_COST.toString());

    // The deployment is switched off between the plan and the signature: nothing is signed.
    await h.t.db.query("UPDATE markets.deployments SET enabled = false");
    const rejected = await h.service.handle(tokens.worker, body);
    assert.deepEqual(rejected.body, {
      state: "REJECTED",
      code: "DEPLOYMENT_DISABLED",
    });
    assert.equal(await reserved(), "0", "the reservation was released");
    assert.equal(
      (await h.scalar("SELECT count(*)::int AS n FROM signing.artifacts")).n,
      0,
    );
    const alert = await h.scalar(
      "SELECT resource, reason FROM operations.audit_log WHERE action = 'signer.plan_abandoned'",
    );
    assert.equal(alert.resource, testAccounts.keeper.address.toLowerCase());
    assert.match(
      String(alert.reason),
      /nonce=5 version=1 code=DEPLOYMENT_DISABLED/,
    );

    // A caller that disagrees about the hash also abandons a planned request, once.
    await h.t.db.query("UPDATE markets.deployments SET enabled = true");
    const second = await prepareRequest(h.client, h.manifest, {
      kind: "FINALIZE_TIMEOUT",
      payload: finalizeTimeout("9"),
    });
    h.faults.crashAfterArtifact = true;
    await h.service.handle(tokens.worker, {
      signRequestId: second.signRequestId,
      expectedRequestHash: second.requestHash,
    });
    h.faults.crashAfterArtifact = false;
    assert.equal(await reserved(), MAX_COST.toString());
    const mismatch = await h.service.handle(tokens.worker, {
      signRequestId: second.signRequestId,
      expectedRequestHash: "0x" + "33".repeat(32),
    });
    assert.equal(mismatch.body.code, "REQUEST_HASH_MISMATCH");
    assert.equal(await reserved(), "0");
    await h.service.handle(tokens.worker, {
      signRequestId: second.signRequestId,
      expectedRequestHash: "0x" + "33".repeat(32),
    });
    assert.equal(
      await reserved(),
      "0",
      "replaying the rejection releases nothing twice",
    );
  } finally {
    await h.t.close();
  }
});

test("a zero priority fee is a valid transaction and is replaced with a positive minimum tip", async () => {
  const h = await harness();
  try {
    h.state.priority = 0n;
    const first = await h.call("FINALIZE_TIMEOUT", finalizeTimeout("8"));
    assert.equal(first.response.body.state, "SIGNED");
    const rawOf = async (version: number) =>
      (
        await h.scalar(
          `SELECT a.raw_transaction FROM signing.artifacts a JOIN signing.sign_requests r ON r.id = a.sign_request_id
          WHERE r.artifact_version = $1`,
          [version],
        )
      ).raw_transaction as Hex;
    const v1 = parseTransaction(await rawOf(1));
    // viem decodes a zero RLP field as undefined.
    assert.equal(v1.maxPriorityFeePerGas ?? 0n, 0n, "the tip really is zero");
    assert.equal(v1.maxFeePerGas, 2_000_000n);

    // A replacement that keeps the tip at zero is refused.
    const stuck = await h.call(
      "FINALIZE_TIMEOUT",
      {
        ...finalizeTimeout("8"),
        maxFeePerGas: "2250000",
        maxPriorityFeePerGas: "0",
      },
      { intentId: first.intentId, version: 2 },
    );
    assert.equal(stuck.response.body.code, "REPLACEMENT_FEE_TOO_LOW");
  } finally {
    await h.t.close();
  }

  const g = await harness();
  try {
    g.state.priority = 0n;
    const first = await g.call("FINALIZE_TIMEOUT", finalizeTimeout("8"));
    const fees = minimumReplacementFees({
      maxFeePerGas: 2_000_000n,
      maxPriorityFeePerGas: 0n,
    });
    assert.deepEqual(fees, {
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const second = await g.call(
      "FINALIZE_TIMEOUT",
      {
        ...finalizeTimeout("8"),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      },
      { intentId: first.intentId, version: 2 },
    );
    assert.equal(second.response.body.state, "SIGNED");
    const raw = (
      await g.scalar(
        `SELECT a.raw_transaction FROM signing.artifacts a JOIN signing.sign_requests r ON r.id = a.sign_request_id
        WHERE r.artifact_version = 2`,
      )
    ).raw_transaction as Hex;
    const v2 = parseTransaction(raw);
    assert.equal(v2.maxPriorityFeePerGas, 1_000_000_000n);
    assert.equal(v2.maxFeePerGas, 1_000_000_000n);
    assert.equal(v2.nonce, 5);
  } finally {
    await g.t.close();
  }
});

test("maker quotes: the signature recovers to the maker and the artifact is the EIP-712 digest", async () => {
  const h = await harness();
  try {
    const result = await h.call("MAKER_QUOTE", testQuote);
    assert.equal(result.response.status, 200);
    assert.equal(result.response.body.state, "SIGNED");
    const typed = quoteTypedData(h.manifest, parseQuoteMessage(testQuote)!);
    const signature = result.response.body.signature as Hex;
    assert.equal(
      (await recoverTypedDataAddress({ ...typed, signature })).toLowerCase(),
      testAccounts.maker.address.toLowerCase(),
    );
    assert.equal(
      result.response.body.artifactHash,
      quoteRequestHash(h.manifest, testQuote),
    );
    assert.equal(result.response.body.artifactHash, result.requestHash);
    const stored = await h.scalar(
      "SELECT signature, raw_transaction, max_cost_wei FROM signing.artifacts",
    );
    assert.deepEqual(stored, {
      signature,
      raw_transaction: null,
      max_cost_wei: null,
    });
    // A maker quote consumes no transaction nonce, gas or RPC work.
    assert.equal(
      (
        await h.scalar(
          "SELECT count(*)::int AS n FROM signing.nonce_allocations",
        )
      ).n,
      0,
    );
    assert.equal(
      (await h.scalar("SELECT count(*)::int AS n FROM signing.gas_spend")).n,
      0,
    );
    assert.equal(h.state.estimateCalls, 0);
    // Idempotent: the same request returns the same signature.
    const again = await h.service.handle(tokens.api, {
      signRequestId: result.signRequestId,
      expectedRequestHash: result.requestHash,
    });
    assert.deepEqual(again, result.response);
    assert.equal(
      (await h.scalar("SELECT count(*)::int AS n FROM signing.artifacts")).n,
      1,
    );
  } finally {
    await h.t.close();
  }
});

test("maker quote policy is enforced against the chain projection and the signer clock", async () => {
  const h = await harness();
  try {
    h.state.nowMs = 1_028_000;
    assert.equal(
      (await h.call("MAKER_QUOTE", testQuote)).response.body.code,
      "QUOTE_EXPIRED",
    );
    h.state.nowMs = 1_010_000;
    assert.equal(
      (await h.call("MAKER_QUOTE", { ...testQuote, epoch: "4" })).response.body
        .code,
      "EPOCH_MISMATCH",
    );
    assert.equal(
      (await h.call("MAKER_QUOTE", { ...testQuote, marketId: "2" })).response
        .body.code,
      "MARKET_NOT_FOUND",
    );
    assert.equal(
      (
        await h.call("MAKER_QUOTE", {
          ...testQuote,
          expiresAt: "2001",
          validAfter: "1990",
        })
      ).response.body.code,
      "QUOTE_AFTER_CLOSE",
    );
    assert.equal(
      (
        await h.call("MAKER_QUOTE", {
          ...testQuote,
          specHash: "0x" + "33".repeat(32),
        })
      ).response.body.code,
      "SPEC_HASH_MISMATCH",
    );
    assert.equal(
      (
        await h.call("MAKER_QUOTE", {
          ...testQuote,
          maker: testAccounts.keeper.address,
        })
      ).response.body.code,
      "MAKER_NOT_ALLOWED",
    );
    await h.t.db.query("UPDATE chain.markets SET state = 'PROPOSED'");
    assert.equal(
      (await h.call("MAKER_QUOTE", testQuote)).response.body.code,
      "MARKET_NOT_OPEN",
    );

    // A request whose stored hash is not the digest of its payload signs nothing.
    await h.t.db.query("UPDATE chain.markets SET state = 'OPEN'");
    const other = quoteRequestHash(h.manifest, {
      ...testQuote,
      quantity: "11",
    });
    const prepared = await prepareRequest(h.client, h.manifest, {
      kind: "MAKER_QUOTE",
      payload: testQuote,
    });
    await h.t.db.query(
      "UPDATE signing.sign_requests SET request_hash = decode($2, 'hex') WHERE id = $1",
      [prepared.signRequestId, other.slice(2)],
    );
    const mismatch = await h.service.handle(tokens.api, {
      signRequestId: prepared.signRequestId,
      expectedRequestHash: other,
    });
    assert.equal(mismatch.body.code, "PAYLOAD_HASH_MISMATCH");

    // Trading disabled in the manifest closes quoting.
    const disabled = await harness();
    try {
      const closedManifest = testManifest({ tradingEnabled: false });
      const closed = createSignerService({
        store: postgresSignerStore(disabled.t.pool),
        keys: { maker: testAccounts.maker },
        rpc: disabled.rpc,
        deployment: closedManifest,
        callers,
        policy: fullPolicy,
        encodeCall: encodeAllowedCall,
        now: () => 1_010_000,
      });
      const prepared = await prepareRequest(disabled.client, closedManifest, {
        kind: "MAKER_QUOTE",
        payload: testQuote,
      });
      const response = await closed.handle(tokens.api, {
        signRequestId: prepared.signRequestId,
        expectedRequestHash: prepared.requestHash,
      });
      assert.equal(response.body.code, "TRADING_DISABLED");
    } finally {
      await disabled.t.close();
    }
  } finally {
    await h.t.close();
  }
});

test("quoteCheck runs last: it can reject, and an unexpected failure leaves the request retryable", async () => {
  const seen: { requestId: string; kind: string; hasClient: boolean }[] = [];
  let mode: "pass" | "reject" | "crash" = "pass";
  const h = await harness({
    quoteCheck: async ({ signRequest, intent, client }) => {
      seen.push({
        requestId: signRequest.id,
        kind: intent.kind,
        hasClient: client !== undefined,
      });
      if (mode === "reject")
        throw new QuoteCheckRejection("RESERVATION_MISSING");
      if (mode === "crash") throw new Error("reservation store down");
    },
  });
  try {
    // Fails an earlier policy check: the hook is never reached.
    await h.call("MAKER_QUOTE", { ...testQuote, epoch: "9" });
    assert.equal(seen.length, 0);

    mode = "reject";
    const rejected = await h.call("MAKER_QUOTE", testQuote);
    assert.equal(rejected.response.body.code, "RESERVATION_MISSING");
    assert.equal(
      (await h.scalar("SELECT count(*)::int AS n FROM signing.artifacts")).n,
      0,
    );

    mode = "crash";
    const crashed = await h.call("MAKER_QUOTE", { ...testQuote, nonce: "8" });
    assert.deepEqual(
      { status: crashed.response.status, state: crashed.response.body.state },
      { status: 503, state: "UNKNOWN" },
    );
    assert.equal(
      (
        await h.scalar(
          "SELECT state FROM signing.sign_requests WHERE id = $1",
          [crashed.signRequestId],
        )
      ).state,
      "REQUESTED",
    );
    mode = "pass";
    const retried = await h.service.handle(tokens.api, {
      signRequestId: crashed.signRequestId,
      expectedRequestHash: crashed.requestHash,
    });
    assert.equal(retried.body.state, "SIGNED");
    assert.deepEqual(seen.at(-1), {
      requestId: crashed.signRequestId,
      kind: "MAKER_QUOTE",
      hasClient: true,
    });
  } finally {
    await h.t.close();
  }
});

test("key files must be owner-only, and startup refuses keys that are not the manifest's", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blink-keys-"));
  try {
    const key = privateKeyOf(testAccounts.maker);
    const write = async (name: string, mode: number, content = key + "\n") => {
      const path = join(directory, name);
      await writeFile(path, content);
      await chmod(path, mode);
      return path;
    };
    assert.equal(await readKeyFile(await write("ok-0600", 0o600)), key);
    assert.equal(await readKeyFile(await write("ok-0400", 0o400)), key);
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666, 0o700, 0o755])
      await assert.rejects(
        readKeyFile(await write("bad-" + mode.toString(8), mode)),
        /KEY_FILE_PERMISSIONS/,
        mode.toString(8),
      );
    await assert.rejects(
      readKeyFile(await write("short", 0o600, "0x1234")),
      /KEY_FILE_INVALID/,
    );
    await assert.rejects(
      readKeyFile(join(directory, "missing")),
      /KEY_FILE_UNREADABLE/,
    );
    await assert.rejects(readKeyFile(directory), /KEY_FILE_INVALID/);
    // The error names a code, never key material.
    await assert.rejects(
      readKeyFile(await write("leak", 0o644)),
      (error: Error) => {
        assert.ok(!error.message.includes(key.slice(2)));
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const h = await harness();
  try {
    const base = {
      store: h.store,
      rpc: h.rpc,
      deployment: h.manifest,
      callers,
      policy: fullPolicy,
      encodeCall: encodeAllowedCall,
    };
    createSignerService({ ...base, keys: { maker: testAccounts.maker } });
    const refuses = (
      keys: Parameters<typeof createSignerService>[0]["keys"],
      pattern: RegExp,
    ) => assert.throws(() => createSignerService({ ...base, keys }), pattern);
    refuses({ maker: testAccounts.keeper }, /MAKER_KEY_MISMATCH/);
    refuses({ faucet: testAccounts.maker }, /FAUCET_KEY_MISMATCH/);
    refuses({ keeper: testAccounts.admin }, /KEEPER_KEY_ADDRESS_FORBIDDEN/);
    refuses({ trader: testAccounts.proposer }, /TRADER_KEY_ADDRESS_FORBIDDEN/);
    refuses(
      { keeper: testAccounts.keeper, trader: testAccounts.keeper },
      /ROLE_KEYS_NOT_DISTINCT/,
    );
    assert.throws(
      () =>
        createSignerService({
          ...base,
          keys: {},
          callers: [{ name: "x", tokenSha256: "not-a-hash", roles: ["maker"] }],
        }),
      /INVALID_SIGNER_CALLER/,
    );
    assert.throws(
      () =>
        createSignerService({
          ...base,
          keys: {},
          callers: [
            {
              name: "x",
              tokenSha256: sha256Hex("t"),
              roles: ["admin" as never],
            },
          ],
        }),
      /INVALID_SIGNER_CALLER/,
    );

    // Startup also needs the 84532 RPC and an enabled, identical deployment row.
    const rpcFor = (chainId: number): SignerRpc => ({
      ...h.rpc,
      chainId: async () => chainId,
    });
    await assertSignerStartup({
      store: h.store,
      rpc: rpcFor(84532),
      deployment: h.manifest,
    });
    await assert.rejects(
      assertSignerStartup({
        store: h.store,
        rpc: rpcFor(8453),
        deployment: h.manifest,
      }),
      /MAINNET_REFUSED/,
    );
    await assert.rejects(
      assertSignerStartup({
        store: h.store,
        rpc: rpcFor(1),
        deployment: h.manifest,
      }),
      /RPC_CHAIN_MISMATCH/,
    );
    await assert.rejects(
      assertSignerStartup({
        store: h.store,
        rpc: rpcFor(84532),
        deployment: testManifest({ deploymentId: "other" }),
      }),
      /DEPLOYMENT_NOT_FOUND/,
    );
    await assert.rejects(
      assertSignerStartup({
        store: h.store,
        rpc: rpcFor(84532),
        deployment: testManifest({ deploymentBlock: "2" }),
      }),
      /DEPLOYMENT_MISMATCH/,
    );
    await h.t.db.query("UPDATE markets.deployments SET enabled = false");
    await assert.rejects(
      assertSignerStartup({
        store: h.store,
        rpc: rpcFor(84532),
        deployment: h.manifest,
      }),
      /DEPLOYMENT_DISABLED/,
    );
  } finally {
    await h.t.close();
  }
});

test("the database confines each role: blink_api never reads raw_transaction and may only ask for maker quotes", async () => {
  const h = await harness();
  try {
    const signed = await h.call("MINT", mint());
    assert.equal(signed.response.body.state, "SIGNED");
    const quote = await h.call("MAKER_QUOTE", testQuote);
    const intentInsert = (kind: string, role: string) =>
      h.t.db.query(
        `INSERT INTO signing.economic_intents(id, deployment_id, kind, role, dedupe_key, payload, payload_hash, created_by)
        VALUES (gen_random_uuid(), $1, $2, $3, gen_random_uuid()::text, '{}', decode($4, 'hex'), 'role-test')`,
        [h.manifest.deploymentId, kind, role, "00".repeat(32)],
      );
    await h.t.setRole("blink_api");
    try {
      await assert.rejects(
        h.t.db.query("SELECT raw_transaction FROM signing.artifacts"),
        /permission denied/,
      );
      await assert.rejects(
        h.t.db.query("SELECT * FROM signing.artifacts"),
        /permission denied/,
      );
      await assert.rejects(
        h.t.db.query("SELECT max_cost_wei FROM signing.artifacts"),
        /permission denied/,
      );
      const visible = await h.t.db.query(
        "SELECT id, sign_request_id, artifact_hash, signature, created_at FROM signing.artifacts WHERE sign_request_id = $1",
        [quote.signRequestId],
      );
      assert.equal(visible.rows.length, 1);
      await assert.rejects(
        intentInsert("MINT", "faucet"),
        /MAKER_QUOTE intents only/,
      );
      await assert.rejects(
        intentInsert("FILL", "trader"),
        /MAKER_QUOTE intents only/,
      );
      await assert.rejects(
        intentInsert("FINALIZE_TIMEOUT", "keeper"),
        /MAKER_QUOTE intents only/,
      );
      await intentInsert("MAKER_QUOTE", "maker");
      // It cannot add a later version, request for a non-quote intent, or touch anything it made.
      await assert.rejects(
        h.t.db.query(
          `INSERT INTO signing.sign_requests(id, intent_id, artifact_version, role, request_hash, unsigned_payload, policy_version)
          VALUES (gen_random_uuid(), $1, 1, 'faucet', decode($2, 'hex'), '{}', 'p')`,
          [signed.intentId, "00".repeat(32)],
        ),
        /maker quotes only/,
      );
      await assert.rejects(
        h.t.db.query(
          `INSERT INTO signing.sign_requests(id, intent_id, artifact_version, role, request_hash, unsigned_payload, policy_version)
          VALUES (gen_random_uuid(), $1, 2, 'maker', decode($2, 'hex'), '{}', 'p')`,
          [quote.intentId, "00".repeat(32)],
        ),
        /first-version maker quotes only/,
      );
      await assert.rejects(
        h.t.db.query(
          "UPDATE signing.sign_requests SET state = 'REJECTED', reject_code = 'x'",
        ),
        /permission denied/,
      );
      await assert.rejects(
        h.t.db.query("UPDATE signing.economic_intents SET state = 'CANCELLED'"),
        /permission denied/,
      );
      await assert.rejects(
        h.t.db.query("SELECT * FROM signing.tx_attempts"),
        /permission denied/,
      );
    } finally {
      await h.t.setRole(null);
    }

    // The worker creates any intent and reads raw bytes, but cannot forge artifacts or nonces.
    await h.t.setRole("blink_worker");
    try {
      await intentInsert("MINT", "faucet");
      const raw = await h.t.db.query(
        "SELECT raw_transaction FROM signing.artifacts WHERE raw_transaction IS NOT NULL",
      );
      assert.equal(raw.rows.length, 1);
      await assert.rejects(
        h.t.db.query(
          "INSERT INTO signing.artifacts(id, sign_request_id, artifact_hash, signature) VALUES (gen_random_uuid(), $1, decode($2, 'hex'), '0x')",
          [quote.signRequestId, "00".repeat(32)],
        ),
        /permission denied/,
      );
      await assert.rejects(
        h.t.db.query("UPDATE signing.sign_requests SET state = 'SIGNED'"),
        /permission denied/,
      );
      await assert.rejects(
        h.t.db.query("SELECT * FROM signing.sender_guards"),
        /permission denied/,
      );
    } finally {
      await h.t.setRole(null);
    }

    // Even the signer cannot rewrite what it signed.
    await h.t.setRole("blink_signer");
    try {
      await assert.rejects(
        h.t.db.query("UPDATE signing.artifacts SET signature = 'x'"),
        /permission denied/,
      );
      await assert.rejects(
        h.t.db.query("DELETE FROM signing.nonce_allocations"),
        /permission denied/,
      );
      await assert.rejects(
        h.t.db.query("UPDATE signing.economic_intents SET payload = '{}'"),
        /permission denied/,
      );
    } finally {
      await h.t.setRole(null);
    }
    // A request must carry its intent's role, whoever inserts it.
    await assert.rejects(
      h.t.db.query(
        `INSERT INTO signing.sign_requests(id, intent_id, artifact_version, role, request_hash, unsigned_payload, policy_version)
        VALUES (gen_random_uuid(), $1, 2, 'maker', decode($2, 'hex'), '{}', 'p')`,
        [signed.intentId, "00".repeat(32)],
      ),
      /role must match/,
    );
    // And append-only holds for the owner too.
    await assert.rejects(
      h.t.db.query("UPDATE signing.artifacts SET signature = 'x'"),
      /append-only/,
    );
    await assert.rejects(
      h.t.db.query("DELETE FROM signing.nonce_allocations"),
      /append-only/,
    );
  } finally {
    await h.t.close();
  }
});

test("the signer runtime accepts only an ordinary signer login and judges the session, not the effective role", async () => {
  const t = await createTestDatabase();
  try {
    const exec = (sql: string) => t.db.exec(sql);
    await exec(`
      CREATE ROLE signer_login LOGIN IN ROLE blink_signer;
      CREATE ROLE signer_also_worker LOGIN IN ROLE blink_signer, blink_worker;
      CREATE ROLE signer_creator LOGIN CREATEROLE IN ROLE blink_signer;
      CREATE ROLE signer_createdb LOGIN CREATEDB IN ROLE blink_signer;
      CREATE ROLE signer_bypass LOGIN BYPASSRLS IN ROLE blink_signer;
      CREATE ROLE signer_builder LOGIN IN ROLE blink_signer;
      GRANT CREATE ON SCHEMA signing TO signer_builder;
      CREATE ROLE signer_extra LOGIN IN ROLE blink_signer;
      CREATE ROLE harmless_group NOLOGIN;
      GRANT harmless_group TO signer_extra;
      CREATE ROLE not_a_signer LOGIN;
    `);
    const accepted = async (session: string) => {
      await exec(`SET SESSION AUTHORIZATION ${session}`);
      try {
        await assertSignerRuntimeRole(t.pool);
      } finally {
        await exec("SET SESSION AUTHORIZATION postgres");
      }
    };
    const refused = async (session: string) => {
      await exec(`SET SESSION AUTHORIZATION ${session}`);
      try {
        await assert.rejects(
          assertSignerRuntimeRole(t.pool),
          /UNSAFE_SIGNER_DATABASE_ROLE/,
          session,
        );
      } finally {
        await exec("SET SESSION AUTHORIZATION postgres");
      }
    };
    // The one accepted shape: a login that is a member of blink_signer and nothing else.
    await accepted("signer_login");

    // The owner and a superuser are refused outright...
    await assert.rejects(
      assertSignerRuntimeRole(t.pool),
      /UNSAFE_SIGNER_DATABASE_ROLE/,
    );
    // ...and so are they when they merely start with role=blink_signer (or SET ROLE): the
    // effective role looks right, the authenticated login does not.
    for (const role of ["blink_signer", "signer_login"]) {
      await exec(`SET ROLE ${role}`);
      try {
        await assert.rejects(
          assertSignerRuntimeRole(t.pool),
          /UNSAFE_SIGNER_DATABASE_ROLE/,
          "SET ROLE " + role,
        );
      } finally {
        await exec("RESET ROLE");
      }
    }
    // A login that can switch to another runtime role, or holds any other privilege, is refused.
    for (const session of [
      "signer_also_worker",
      "signer_creator",
      "signer_createdb",
      "signer_bypass",
      "signer_builder",
      "signer_extra",
      "not_a_signer",
      // The NOLOGIN group role is not a login either.
      "blink_signer",
      "blink_worker",
      "blink_api",
    ])
      await refused(session);
    // A signer login that has switched its effective role away from itself is refused too.
    await exec("SET SESSION AUTHORIZATION signer_login");
    try {
      await exec("SET ROLE blink_signer");
      await assert.rejects(
        assertSignerRuntimeRole(t.pool),
        /UNSAFE_SIGNER_DATABASE_ROLE/,
      );
    } finally {
      await exec("RESET ROLE");
      await exec("SET SESSION AUTHORIZATION postgres");
    }
  } finally {
    await t.close();
  }
});

test("the real runtime role signs end to end under blink_signer grants", async () => {
  const h = await harness();
  try {
    const tx = await prepareRequest(h.client, h.manifest, {
      kind: "FINALIZE_UNCHALLENGED",
      payload: {
        ...finalizeTimeout("2"),
        functionName: "finalizeUnchallenged",
      },
    });
    const quote = await prepareRequest(h.client, h.manifest, {
      kind: "MAKER_QUOTE",
      payload: testQuote,
    });
    const bad = await prepareRequest(h.client, h.manifest, {
      kind: "REDEEM",
      payload: { ...redeem(), data: "0x" },
    });
    await h.t.setRole("blink_signer");
    try {
      const sign = (
        token: string,
        r: { signRequestId: string; requestHash: string },
      ) =>
        h.service.handle(token, {
          signRequestId: r.signRequestId,
          expectedRequestHash: r.requestHash,
        });
      assert.equal((await sign(tokens.worker, tx)).body.state, "SIGNED");
      assert.equal((await sign(tokens.api, quote)).body.state, "SIGNED");
      // A rejection is written by the same runtime role.
      assert.equal(
        (await sign(tokens.worker, bad)).body.code,
        "PAYLOAD_INVALID",
      );
    } finally {
      await h.t.setRole(null);
    }
  } finally {
    await h.t.close();
  }
});

test("transaction request hashes bind the whole payload", () => {
  const a = transactionRequestHash(redeem("3"));
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.equal(
    a,
    transactionRequestHash({
      args: ["3"],
      functionName: "redeem",
      to: testMarket,
    }),
  );
  assert.notEqual(a, transactionRequestHash(redeem("4")));
  assert.notEqual(
    a,
    transactionRequestHash({
      ...redeem("3"),
      maxFeePerGas: "1",
      maxPriorityFeePerGas: "1",
    }),
  );
  assert.equal(SIGNING_POLICY_VERSION, "signer-policy-v1");
});
