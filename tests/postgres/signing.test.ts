import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { keccak256 } from "viem";
import { encodeAllowedCall } from "../../packages/adapters/src/signing-calldata.js";
import {
  assertSignerRuntimeRole,
  postgresDispatchStore,
  postgresSignerStore,
} from "../../packages/adapters/src/signing-store.js";
import {
  createSignerService,
  createTxDispatcher,
} from "../../packages/application/src/index.js";
import type {
  DispatchReceipt,
  DispatchRpc,
  RestrictedSigner,
  SendRawResult,
  SignerRpc,
  SignerStore,
  SignResult,
} from "../../packages/ports/src/index.js";
import { withDatabase } from "../helpers/postgres-database.js";
import {
  prepareRequest,
  seedChain,
  seedDeployment,
  sha256Hex,
  testAccounts,
  testManifest,
  testMarket,
} from "../helpers/signer-fixture.js";

const TOKEN = "pg-worker-token";

function fakeSignerRpc(pending = 5n): SignerRpc {
  return {
    chainId: async () => 84532,
    estimateGas: async () => 100_000n,
    baseFeePerGas: async () => 1_000_000n,
    maxPriorityFeePerGas: async () => 100_000n,
    pendingNonce: async () => pending,
    l1Fee: async () => 0n,
  };
}
function signerService(
  pool: pg.Pool,
  rpc = fakeSignerRpc(),
  store: SignerStore = postgresSignerStore(pool),
) {
  return createSignerService({
    store,
    keys: {
      maker: testAccounts.maker,
      keeper: testAccounts.keeper,
      faucet: testAccounts.minter,
    },
    rpc,
    deployment: testManifest(),
    callers: [
      {
        name: "worker",
        tokenSha256: sha256Hex(TOKEN),
        roles: ["keeper", "faucet", "maker"],
      },
    ],
    policy: {
      l1FeeMode: "local-none",
      perTxCapWei: 200_000_000_000_000n,
      dailyCapWei: 2_000_000_000_000_000n,
    },
    encodeCall: encodeAllowedCall,
  });
}
const finalize = (id: number) => ({
  to: testMarket,
  functionName: "finalizeTimeout",
  args: [String(id)],
});

test(
  "real PostgreSQL: two signer pools allocate distinct, consecutive nonces for one sender",
  { timeout: 60000 },
  async () => {
    await withDatabase(async ({ owner, pool, login }) => {
      const manifest = testManifest();
      await seedDeployment(owner, manifest);
      await seedChain(owner, { deploymentId: manifest.deploymentId });
      const worker = pool("blink_worker");
      const requests = [];
      for (let id = 1; id <= 12; id += 1)
        requests.push(
          await prepareRequest(worker, manifest, {
            kind: "FINALIZE_TIMEOUT",
            payload: finalize(id),
          }),
        );
      // Two separate signer processes' worth of connections, each an ordinary signer login.
      const poolA = await login({ max: 6 });
      const poolB = await login({ max: 6 });
      await assertSignerRuntimeRole(poolA);
      await assertSignerRuntimeRole(poolB);
      const services = [signerService(poolA), signerService(poolB)];
      const responses = await Promise.all(
        requests.map((request, index) =>
          services[index % 2]!.handle(TOKEN, {
            signRequestId: request.signRequestId,
            expectedRequestHash: request.requestHash,
          }),
        ),
      );
      assert.ok(
        responses.every((r) => r.body.state === "SIGNED"),
        JSON.stringify(responses.map((r) => r.body)),
      );
      const { rows } = await owner.query(
        "SELECT nonce::int AS nonce FROM signing.nonce_allocations ORDER BY nonce",
      );
      assert.deepEqual(
        rows.map((r) => r.nonce),
        Array.from({ length: 12 }, (_, i) => 5 + i),
        "distinct consecutive nonces from the pending nonce",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(DISTINCT intent_id)::int AS n FROM signing.nonce_allocations",
          )
        ).rows[0].n,
        12,
      );
      const gas = (
        await owner.query(
          "SELECT reserved_wei::text AS reserved FROM signing.gas_spend WHERE role = 'keeper'",
        )
      ).rows[0];
      assert.equal(gas.reserved, (12n * 252_000_000_000n).toString());
      // Every raw transaction carries its own allocated nonce, the intent's own call, and a unique hash.
      const hashes = (
        await owner.query(
          "SELECT DISTINCT encode(artifact_hash, 'hex') AS h FROM signing.artifacts",
        )
      ).rows;
      assert.equal(hashes.length, 12);
    });
  },
);

test(
  "real PostgreSQL: the same sign request signed from two pools at once yields one artifact",
  { timeout: 60000 },
  async () => {
    await withDatabase(async ({ owner, pool, login }) => {
      const manifest = testManifest();
      await seedDeployment(owner, manifest);
      await seedChain(owner, { deploymentId: manifest.deploymentId });
      const request = await prepareRequest(pool("blink_worker"), manifest, {
        kind: "FINALIZE_TIMEOUT",
        payload: finalize(1),
      });
      const services = [
        signerService(await login({ max: 4 })),
        signerService(await login({ max: 4 })),
      ];
      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          services[i % 2]!.handle(TOKEN, {
            signRequestId: request.signRequestId,
            expectedRequestHash: request.requestHash,
          }),
        ),
      );
      assert.equal(
        new Set(responses.map((r) => JSON.stringify(r.body))).size,
        1,
      );
      assert.equal(responses[0]!.body.state, "SIGNED");
      assert.equal(
        (await owner.query("SELECT 1 FROM signing.artifacts")).rows.length,
        1,
      );
      assert.equal(
        (await owner.query("SELECT 1 FROM signing.nonce_allocations")).rows
          .length,
        1,
      );
    });
  },
);

test(
  "real PostgreSQL S07: a restarted dispatcher with an UNKNOWN attempt creates no new nonce, intent or attempt",
  { timeout: 60000 },
  async () => {
    await withDatabase(async ({ owner, pool, login }) => {
      const manifest = testManifest();
      await seedDeployment(owner, manifest);
      await seedChain(owner, { deploymentId: manifest.deploymentId });
      const worker = pool("blink_worker");
      const intent = await prepareRequest(worker, manifest, {
        kind: "FINALIZE_TIMEOUT",
        payload: finalize(9),
      });
      const service = signerService(await login());
      const signer: RestrictedSigner = {
        async sign(input) {
          const response = await service.handle(TOKEN, input);
          return response.status === 200
            ? (response.body as SignResult)
            : { state: "UNKNOWN", code: String(response.body.code) };
        },
      };
      const receipts = new Map<string, DispatchReceipt>();
      const sent: string[] = [];
      const sendResult: SendRawResult = { state: "NONCE_TOO_LOW" };
      const rpc: DispatchRpc = {
        async sendRawTransaction(raw) {
          sent.push(raw);
          return sendResult;
        },
        getReceipt: async (hash) => receipts.get(hash.toLowerCase()) ?? null,
        blockHashAt: async (number) =>
          keccak256(
            ("0x" + number.toString(16).padStart(2, "0")) as `0x${string}`,
          ),
        finalizedBlockNumber: async () => null,
      };
      const start = () =>
        createTxDispatcher({
          store: postgresDispatchStore(pool("blink_worker", 4)),
          rpc,
          signer,
          replaceAfterMs: 60_000,
        });
      const counts = async () =>
        (
          await owner.query(
            `SELECT (SELECT count(*) FROM signing.economic_intents)::int AS intents,
            (SELECT count(*) FROM signing.nonce_allocations)::int AS nonces,
            (SELECT count(*) FROM signing.tx_attempts)::int AS attempts,
            (SELECT count(*) FROM signing.artifacts)::int AS artifacts`,
          )
        ).rows[0];

      assert.equal(await start().dispatch(intent.intentId), "UNKNOWN");
      const before = await counts();
      assert.deepEqual(before, {
        intents: 1,
        nonces: 1,
        attempts: 1,
        artifacts: 1,
      });
      // The process restarts: a fresh dispatcher, fresh pools. Same answer, same rows.
      for (let restart = 0; restart < 3; restart += 1)
        assert.equal(await start().dispatch(intent.intentId), "UNKNOWN");
      assert.deepEqual(await counts(), before);
      assert.equal(
        sent.length,
        1,
        "an UNKNOWN attempt is looked up by hash, not re-sent blindly",
      );
      assert.equal(
        (await owner.query("SELECT state FROM signing.economic_intents"))
          .rows[0].state,
        "UNKNOWN",
      );

      // Concurrent dispatchers find the receipt once it exists and settle it exactly once.
      const hash = (
        await owner.query(
          "SELECT '0x' || encode(tx_hash, 'hex') AS h FROM signing.tx_attempts",
        )
      ).rows[0].h as string;
      const blockHash = keccak256("0x0a");
      receipts.set(hash, {
        status: "success",
        blockHash,
        blockNumber: 10n,
        gasSpentWei: 40_000_000_000n,
      });
      const results = await Promise.all([
        start().dispatch(intent.intentId),
        start().dispatch(intent.intentId),
        start().dispatch(intent.intentId),
      ]);
      assert.ok(
        results.every((r) => r === "INCLUDED"),
        results.join(),
      );
      assert.deepEqual(await counts(), before);
      const gas = (
        await owner.query(
          "SELECT reserved_wei::text AS reserved, spent_wei::text AS spent FROM signing.gas_spend",
        )
      ).rows[0];
      assert.deepEqual(
        gas,
        { reserved: "0", spent: "40000000000" },
        "gas settled once despite racing dispatchers",
      );
    });
  },
);

test(
  "real PostgreSQL: the runtime guard accepts an ordinary signer login and refuses privileged sessions",
  { timeout: 60000 },
  async () => {
    await withDatabase(async ({ owner, pool, login }) => {
      // The one accepted shape: a login of its own that belongs to blink_signer only.
      await assertSignerRuntimeRole(await login());

      // The administrator is refused, and so is the administrator that merely starts with
      // role=blink_signer: the effective role looks right, the authenticated login does not.
      await assert.rejects(
        assertSignerRuntimeRole(owner),
        /UNSAFE_SIGNER_DATABASE_ROLE/,
      );
      await assert.rejects(
        assertSignerRuntimeRole(pool("blink_signer", 1)),
        /UNSAFE_SIGNER_DATABASE_ROLE/,
      );
      // A signer login that is also a worker (or API) login, can create databases, or owns the
      // database is not an ordinary signer.
      for (const options of [
        { memberOf: ["blink_signer", "blink_worker"] },
        { memberOf: ["blink_signer", "blink_api"] },
        { createdb: true },
        { ownsDatabase: true },
        { memberOf: ["blink_worker"] },
      ])
        await assert.rejects(
          assertSignerRuntimeRole(await login(options)),
          /UNSAFE_SIGNER_DATABASE_ROLE/,
          JSON.stringify(options),
        );
    });
  },
);

test(
  "real PostgreSQL: observers with conflicting views leave one coherent final state",
  { timeout: 120000 },
  async () => {
    await withDatabase(async ({ owner, pool, login }) => {
      const manifest = testManifest();
      await seedDeployment(owner, manifest);
      await seedChain(owner, { deploymentId: manifest.deploymentId });
      const worker = pool("blink_worker", 4);
      const service = signerService(await login());
      const signer: RestrictedSigner = {
        async sign(input) {
          const response = await service.handle(TOKEN, input);
          return response.status === 200
            ? (response.body as SignResult)
            : { state: "UNKNOWN", code: String(response.body.code) };
        },
      };
      const blockA = keccak256("0x0a");
      const blockB = keccak256("0x0b");
      const base: DispatchRpc = {
        sendRawTransaction: async (raw) => ({
          state: "ACCEPTED",
          hash: keccak256(raw),
        }),
        getReceipt: async () => null,
        blockHashAt: async () => null,
        finalizedBlockNumber: async () => null,
      };
      // One observer sees a final revert, the other a final success of the same transaction.
      const reverted: DispatchRpc = {
        ...base,
        getReceipt: async () => ({
          status: "reverted",
          blockHash: blockA,
          blockNumber: 5n,
          gasSpentWei: 10n,
        }),
        blockHashAt: async (number) => (number === 5n ? blockA : null),
        finalizedBlockNumber: async () => 5n,
      };
      const success: DispatchRpc = {
        ...base,
        getReceipt: async () => ({
          status: "success",
          blockHash: blockB,
          blockNumber: 6n,
          gasSpentWei: 40n,
        }),
        blockHashAt: async (number) => (number === 6n ? blockB : null),
        finalizedBlockNumber: async () => 6n,
      };
      const observer = (rpc: DispatchRpc) =>
        createTxDispatcher({
          store: postgresDispatchStore(pool("blink_worker", 4)),
          rpc,
          signer,
          replaceAfterMs: 60_000,
        });
      for (let round = 1; round <= 6; round += 1) {
        const intent = await prepareRequest(worker, manifest, {
          kind: "FINALIZE_TIMEOUT",
          payload: finalize(round),
        });
        assert.equal(
          await observer(base).dispatch(intent.intentId),
          "SUBMITTED",
        );
        const results = await Promise.all([
          observer(reverted).dispatch(intent.intentId),
          observer(success).dispatch(intent.intentId),
        ]);
        const { rows } = await owner.query(
          `SELECT t.status, t.gas_spent_wei::text AS spent, t.gas_reserved_wei::text AS reserved, i.state
          FROM signing.tx_attempts t JOIN signing.economic_intents i ON i.id = t.intent_id WHERE t.intent_id = $1`,
          [intent.intentId],
        );
        const only = rows[0];
        // Either outcome is fine; a mixed one (attempt FINALIZED, intent FAILED, ...) is not.
        const ok =
          (only.status === "FINALIZED" &&
            only.state === "FINALIZED" &&
            only.spent === "40") ||
          (only.status === "REVERTED" &&
            only.state === "FAILED" &&
            only.spent === "10");
        assert.ok(ok, JSON.stringify({ round, only, results }));
        assert.equal(only.reserved, "0");
        assert.ok(
          results.every((r) => r === "FINALIZED" || r === "REVERTED"),
          results.join(),
        );
        // Each result is the persisted final state, never the loser's view.
        assert.deepEqual(
          [...new Set(results)],
          only.status === "FINALIZED" ? ["FINALIZED"] : ["REVERTED"],
        );
      }
      // The ledger holds exactly the sum of the winners' actual costs.
      const { rows: ledger } = await owner.query(
        `SELECT spent_wei::text AS spent, reserved_wei::text AS reserved FROM signing.gas_spend WHERE role = 'keeper'`,
      );
      const { rows: attempts } = await owner.query(
        `SELECT sum(gas_spent_wei)::text AS spent FROM signing.tx_attempts`,
      );
      assert.deepEqual(ledger[0], {
        spent: attempts[0].spent,
        reserved: "0",
      });
    });
  },
);

test(
  "real PostgreSQL: a replacement plan left behind by a final outcome is released exactly once, against racing signing retries",
  { timeout: 180000 },
  async () => {
    await withDatabase(async ({ owner, pool, login }) => {
      const manifest = testManifest();
      await seedDeployment(owner, manifest);
      await seedChain(owner, { deploymentId: manifest.deploymentId });
      const worker = pool("blink_worker", 4);
      // Signer A can die after a plan commits; signer B is a second, healthy signer process.
      const crash = { on: false };
      const poolA = await login({ max: 4 });
      const baseStoreA = postgresSignerStore(poolA);
      const serviceA = signerService(poolA, fakeSignerRpc(), {
        loadDeployment: (id) => baseStoreA.loadDeployment(id),
        run: (work) =>
          baseStoreA.run((tx) =>
            work({
              ...tx,
              async markSigned(signRequestId, intentId) {
                if (crash.on) throw new Error("CRASH_AFTER_SIGN");
                await tx.markSigned(signRequestId, intentId);
              },
            }),
          ),
      });
      const serviceB = signerService(await login({ max: 4 }));
      const asSigner = (
        service: ReturnType<typeof signerService>,
      ): RestrictedSigner => ({
        async sign(input) {
          const response = await service.handle(TOKEN, input);
          return response.status === 200
            ? (response.body as SignResult)
            : response.status === 422
              ? { state: "REJECTED", code: String(response.body.code) }
              : { state: "UNKNOWN", code: String(response.body.code) };
        },
      });
      const unreachable: RestrictedSigner = {
        sign: async () => ({ state: "UNKNOWN", code: "SIGNER_TIMEOUT" }),
      };

      // The chain: whatever is in `mined` is canonical, successful and final at block 7.
      const mined = new Map<string, bigint>();
      const blockHash = keccak256("0x07");
      const chainRpc: DispatchRpc = {
        sendRawTransaction: async (raw) => ({
          state: "ACCEPTED",
          hash: keccak256(raw),
        }),
        getReceipt: async (hash) =>
          mined.has(hash.toLowerCase())
            ? {
                status: "success",
                blockHash,
                blockNumber: 7n,
                gasSpentWei: mined.get(hash.toLowerCase())!,
              }
            : null,
        blockHashAt: async (number) => (number === 7n ? blockHash : null),
        finalizedBlockNumber: async () => 7n,
      };
      const dispatcher = (signer: RestrictedSigner, replaceAfterMs = 60_000) =>
        createTxDispatcher({
          store: postgresDispatchStore(pool("blink_worker", 4)),
          rpc: chainRpc,
          signer,
          replaceAfterMs,
        });
      const ledger = async () =>
        (
          await owner.query(
            "SELECT reserved_wei::text AS reserved, spent_wei::text AS spent FROM signing.gas_spend WHERE role = 'keeper'",
          )
        ).rows[0];

      // Three unrelated reservations stay held for the whole test, so one release too many
      // would show up in the total instead of being clamped at zero.
      for (const id of [31, 32, 33]) {
        const other = await prepareRequest(worker, manifest, {
          kind: "FINALIZE_TIMEOUT",
          payload: finalize(id),
        });
        const response = await serviceB.handle(TOKEN, {
          signRequestId: other.signRequestId,
          expectedRequestHash: other.requestHash,
        });
        assert.equal(response.body.state, "SIGNED");
      }
      const held = (await ledger()).reserved;
      assert.equal(held, (3n * 252_000_000_000n).toString());

      for (let round = 1; round <= 4; round += 1) {
        const intent = await prepareRequest(worker, manifest, {
          kind: "FINALIZE_TIMEOUT",
          payload: finalize(round),
        });
        assert.equal(
          await dispatcher(asSigner(serviceA)).dispatch(intent.intentId),
          "SUBMITTED",
        );
        // v2's plan and reservation commit; its signing transaction dies.
        crash.on = true;
        assert.equal(
          await dispatcher(asSigner(serviceA), 0).dispatch(intent.intentId),
          "PENDING",
        );
        crash.on = false;
        const [v2] = (
          await owner.query(
            `SELECT r.id, '0x' || encode(r.request_hash, 'hex') AS hash FROM signing.sign_requests r
            JOIN signing.signing_plans p ON p.sign_request_id = r.id
            WHERE r.intent_id = $1 AND r.artifact_version = 2`,
            [intent.intentId],
          )
        ).rows;
        assert.ok(v2, "v2's plan was committed");
        const v1Hash = (
          await owner.query(
            `SELECT '0x' || encode(a.artifact_hash, 'hex') AS h FROM signing.artifacts a
            JOIN signing.sign_requests r ON r.id = a.sign_request_id
            WHERE r.intent_id = $1 AND r.artifact_version = 1`,
            [intent.intentId],
          )
        ).rows[0].h as string;
        mined.set(v1Hash.toLowerCase(), 10n);

        // v1 is final and charged, observed while the signer is unreachable: the unsigned
        // replacement still holds its reservation and the job is told to come back.
        assert.equal(
          await dispatcher(unreachable).dispatch(intent.intentId),
          "PENDING",
        );
        assert.equal(
          (
            await owner.query(
              "SELECT state FROM signing.economic_intents WHERE id = $1",
              [intent.intentId],
            )
          ).rows[0].state,
          "FINALIZED",
        );
        assert.notEqual((await ledger()).reserved, held);

        // The cleanup races signing retries of the very request it is rejecting.
        const body = { signRequestId: v2.id, expectedRequestHash: v2.hash };
        const [result, ...retries] = await Promise.all([
          dispatcher(asSigner(serviceB)).dispatch(intent.intentId),
          serviceA.handle(TOKEN, body),
          serviceB.handle(TOKEN, body),
          serviceB.handle(TOKEN, body),
        ]);
        assert.equal(result, "FINALIZED");
        for (const retry of retries)
          assert.deepEqual(retry.body, {
            state: "REJECTED",
            code: "SUPERSEDED_BY_FINAL",
          });
        assert.deepEqual(await ledger(), {
          reserved: held,
          spent: String(10 * round),
        });
        assert.deepEqual(
          (
            await owner.query(
              "SELECT state, reject_code FROM signing.sign_requests WHERE id = $1",
              [v2.id],
            )
          ).rows[0],
          { state: "REJECTED", reject_code: "SUPERSEDED_BY_FINAL" },
        );
        assert.equal(
          (
            await owner.query(
              `SELECT count(*)::int AS n FROM signing.artifacts a JOIN signing.sign_requests r ON r.id = a.sign_request_id
              WHERE r.intent_id = $1`,
              [intent.intentId],
            )
          ).rows[0].n,
          1,
          "v2 was never signed",
        );
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int AS n FROM operations.audit_log WHERE action = 'signer.plan_abandoned'",
            )
          ).rows[0].n,
          round,
          "one release per abandoned plan",
        );
        // And the job is now genuinely done, repeatedly.
        assert.equal(
          await dispatcher(asSigner(serviceB)).dispatch(intent.intentId),
          "FINALIZED",
        );
        assert.deepEqual(await ledger(), {
          reserved: held,
          spent: String(10 * round),
        });
      }
    });
  },
);

test(
  "real PostgreSQL: grants hold for the real roles",
  { timeout: 60000 },
  async () => {
    await withDatabase(async ({ owner, pool }) => {
      const manifest = testManifest();
      await seedDeployment(owner, manifest);
      await seedChain(owner, { deploymentId: manifest.deploymentId });
      const api = pool("blink_api", 2);
      const worker = pool("blink_worker", 2);
      // The API asks for a maker quote and can read its signature, never raw bytes.
      await prepareRequest(api, manifest, {
        kind: "MAKER_QUOTE",
        payload: {
          marketId: "1",
          specHash: "0x" + "11".repeat(32),
          maker: testAccounts.maker.address,
          taker: testAccounts.taker.address,
          side: "0",
          quantity: "10",
          priceBps: "6000",
          validAfter: "1000",
          expiresAt: "1030",
          nonce: "7",
          epoch: "3",
        },
      });
      await assert.rejects(
        api.query("SELECT raw_transaction FROM signing.artifacts"),
        /permission denied/,
      );
      await api.query(
        "SELECT id, sign_request_id, artifact_hash, signature, created_at FROM signing.artifacts",
      );
      await assert.rejects(
        prepareRequest(api, manifest, {
          kind: "MINT",
          payload: { to: "0x00", functionName: "mint", args: [] },
        }),
        /MAKER_QUOTE intents only/,
      );
      // The worker can create any intent; the guard rows and artifacts stay signer-only.
      await prepareRequest(worker, manifest, {
        kind: "FINALIZE_TIMEOUT",
        payload: finalize(1),
      });
      await assert.rejects(
        worker.query("SELECT * FROM signing.sender_guards"),
        /permission denied/,
      );
      await assert.rejects(
        worker.query("UPDATE signing.sign_requests SET state = 'SIGNED'"),
        /permission denied/,
      );
    });
  },
);
