import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { keccak256 } from "viem";
import { migrate } from "../../packages/adapters/src/migrations.js";
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
  SignResult,
} from "../../packages/ports/src/index.js";
import {
  prepareRequest,
  seedChain,
  seedDeployment,
  sha256Hex,
  testAccounts,
  testManifest,
  testMarket,
} from "../helpers/signer-fixture.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
if (!adminUrl)
  throw new Error(
    "TEST_POSTGRES_ADMIN_URL_REQUIRED: dedicated local/CI PostgreSQL with CREATEDB and CREATEROLE privileges",
  );

const TOKEN = "pg-worker-token";

// Each test creates and drops its own random database; the supplied database is never touched.
async function withDatabase(
  run: (pools: {
    owner: pg.Pool;
    pool: (role: string, max?: number) => pg.Pool;
  }) => Promise<void>,
) {
  const name = "blink_t8_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^blink_t8_[a-f0-9]{32}$/);
  const control = new pg.Client({ connectionString: adminUrl });
  await control.connect();
  let created = false;
  const url = new URL(adminUrl!);
  url.pathname = "/" + name;
  const owner = new pg.Pool({ connectionString: url.toString(), max: 2 });
  const opened: pg.Pool[] = [];
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    const client = await owner.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
    await run({
      owner,
      pool(role, max = 8) {
        const pool = new pg.Pool({
          connectionString: url.toString(),
          options: "-c role=" + role,
          max,
        });
        opened.push(pool);
        return pool;
      },
    });
  } finally {
    await Promise.all(opened.map((pool) => pool.end()));
    await owner.end();
    if (created) {
      // pool.end() resolves before the sockets are fully closed: let the sessions leave on their
      // own so DROP ... FORCE never kills a client that is still shutting down.
      for (let i = 0; i < 100; i += 1) {
        const { rows } = await control.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
          [name],
        );
        if (rows[0].n === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    }
    await control.end();
  }
}

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
function signerService(pool: pg.Pool, rpc = fakeSignerRpc()) {
  return createSignerService({
    store: postgresSignerStore(pool),
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
    await withDatabase(async ({ owner, pool }) => {
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
      // Two separate signer processes' worth of connections, both as the signer runtime role.
      const poolA = pool("blink_signer", 6);
      const poolB = pool("blink_signer", 6);
      await assertSignerRuntimeRole(poolA);
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
    await withDatabase(async ({ owner, pool }) => {
      const manifest = testManifest();
      await seedDeployment(owner, manifest);
      await seedChain(owner, { deploymentId: manifest.deploymentId });
      const request = await prepareRequest(pool("blink_worker"), manifest, {
        kind: "FINALIZE_TIMEOUT",
        payload: finalize(1),
      });
      const services = [
        signerService(pool("blink_signer", 4)),
        signerService(pool("blink_signer", 4)),
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
    await withDatabase(async ({ owner, pool }) => {
      const manifest = testManifest();
      await seedDeployment(owner, manifest);
      await seedChain(owner, { deploymentId: manifest.deploymentId });
      const worker = pool("blink_worker");
      const intent = await prepareRequest(worker, manifest, {
        kind: "FINALIZE_TIMEOUT",
        payload: finalize(9),
      });
      const service = signerService(pool("blink_signer"));
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
