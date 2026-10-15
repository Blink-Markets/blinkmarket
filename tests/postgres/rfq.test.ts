import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { createRfqPool } from "../../apps/api/src/trading.js";
import { buildApi } from "../../apps/api/src/server.js";
import { createTokenBucket } from "../../apps/api/src/rate-limit.js";
import { identityAdmin } from "../../packages/adapters/src/identity-admin.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { postgresForecastStore } from "../../packages/adapters/src/forecast-store.js";
import { postgresSignerStore } from "../../packages/adapters/src/signing-store.js";
import { encodeAllowedCall } from "../../packages/adapters/src/signing-calldata.js";
import {
  postgresReservationReader,
  postgresTradingStore,
} from "../../packages/adapters/src/trading-store.js";
import { createSnapshotReader } from "../../packages/application/src/forecasts.js";
import { createQuoteReconciler } from "../../packages/application/src/quote-reconcile.js";
import { createRfqService } from "../../packages/application/src/rfq.js";
import {
  createReservationQuoteCheck,
  createSignerService,
} from "../../packages/application/src/signer.js";
import {
  seedDeployment,
  sha256Hex,
  testAccounts,
  testManifest,
} from "../helpers/signer-fixture.js";
import {
  DEPLOYMENT,
  HEAD_TS,
  SIGNER_TOKEN,
  bindWalletRows,
  fakeTradingChain,
  inProcessSigner,
  rfqBody,
  seedChainState,
  seedSnapshotRows,
} from "../helpers/trading.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;

/** Real roles on real connections: two API instances, one signer and the worker, as deployed. */
async function stack(
  pools: { owner: pg.Pool; pool: (role: string, max?: number) => pg.Pool },
  options: { free: bigint; isolatePool?: boolean },
) {
  const { owner, pool } = pools;
  const manifest = testManifest({ deploymentId: DEPLOYMENT });
  await seedDeployment(owner, manifest);
  await seedChainState(owner);
  const admin = identityAdmin(owner);
  const invite = (name: string, scope: "trade:quote" | "forecast:write") =>
    admin.invite({
      operatorName: "op-" + name,
      agentName: name,
      scopes: [scope],
      reason: "rfq race fixture",
    });
  await seedSnapshotRows(owner, {
    a: await invite("forecaster-a", "forecast:write"),
    b: await invite("forecaster-b", "forecast:write"),
  });
  const takers = [
    await invite("taker-a", "trade:quote"),
    await invite("taker-b", "trade:quote"),
  ];
  await bindWalletRows(owner, takers[0]!, testAccounts.taker.address);
  await bindWalletRows(owner, takers[1]!, testAccounts.taker2.address);

  const chain = fakeTradingChain();
  chain.state.view.makerFreeMicros = options.free;
  const signerPool = pool("blink_signer", 4);
  const signing = inProcessSigner(
    createSignerService({
      store: postgresSignerStore(signerPool),
      keys: { maker: testAccounts.maker },
      rpc: {
        chainId: async () => 84532,
        estimateGas: async () => 0n,
        baseFeePerGas: async () => 0n,
        maxPriorityFeePerGas: async () => 0n,
        pendingNonce: async () => 0n,
        l1Fee: async () => 0n,
      },
      deployment: manifest,
      callers: [
        {
          name: "quote-api",
          tokenSha256: sha256Hex(SIGNER_TOKEN),
          roles: ["maker"],
        },
      ],
      policy: {
        l1FeeMode: "local-none",
        perTxCapWei: 10n ** 15n,
        dailyCapWei: 10n ** 16n,
      },
      encodeCall: encodeAllowedCall,
      quoteCheck: createReservationQuoteCheck(postgresReservationReader()),
      now: () => Number(HEAD_TS) * 1000 + 1000,
    }),
  );
  let nonce = 1n;
  const rfqPools: pg.Pool[] = [];
  const instance = () => {
    const apiPool = pool("blink_api", options.isolatePool ? 2 : 6);
    const rfqPool = options.isolatePool ? createRfqPool(apiPool) : apiPool;
    if (rfqPool !== apiPool) rfqPools.push(rfqPool);
    const app = buildApi({
      services: [
        createRfqService({
          store: postgresTradingStore(rfqPool),
          crypto: identityCrypto,
          signer: signing.signer,
          chain: chain.reader,
          snapshots: createSnapshotReader(postgresForecastStore(rfqPool)),
          encodeCall: encodeAllowedCall,
          deploymentId: DEPLOYMENT,
          random: () => nonce++,
          limiter: createTokenBucket({ capacity: 1000, refillPerSecond: 1000 }),
        }),
      ],
    });
    app.get("/unrelated", async () => {
      await apiPool.query("SELECT 1");
      return { ready: true };
    });
    app.log.level = "silent";
    return app;
  };
  const apps = [instance(), instance()];
  const post = (
    app: (typeof apps)[number],
    taker: (typeof takers)[number],
    key: string,
    body = rfqBody,
  ) =>
    app.inject({
      method: "POST",
      url: "/v1/rfqs",
      headers: {
        authorization: "Bearer " + taker.apiKey,
        "idempotency-key": key,
      },
      payload: body,
    });
  const reconciler = createQuoteReconciler(
    postgresTradingStore(pool("blink_worker", 4)),
  );
  return {
    apps,
    takers,
    chain,
    post,
    reconciler,
    owner,
    signing,
    close: async () => {
      await Promise.all(apps.map((app) => app.close()));
      await Promise.all(rfqPools.map((pool) => pool.end()));
    },
  };
}

test(
  "real PostgreSQL: competing RFQs from separate pools admit exactly what the maker's collateral covers",
  { skip: !adminUrl, timeout: 90_000 },
  async () => {
    const { withDatabase } = await import("../helpers/postgres-database.js");
    await withDatabase(async (pools) => {
      // 11.5 bUSD of collateral is enough for three 3.8 bUSD quotes and not a fourth.
      const s = await stack(pools, { free: 11_500_000n });
      try {
        for (let round = 0; round < 3; round++) {
          const results = await Promise.all(
            [0, 1, 2, 3, 4, 5].map((i) =>
              s.post(s.apps[i % 2]!, s.takers[i % 2]!, `r${round}-${i}`),
            ),
          );
          const codes = results
            .map((res) => (res.statusCode === 200 ? 200 : res.json().code))
            .sort();
          assert.deepEqual(
            codes,
            [
              200,
              200,
              200,
              "INSUFFICIENT_MAKER_BALANCE",
              "INSUFFICIENT_MAKER_BALANCE",
              "INSUFFICIENT_MAKER_BALANCE",
            ],
            `round ${round}`,
          );
          const [held] = (
            await pools.owner.query(
              "SELECT count(*)::int AS n, COALESCE(sum(amount_micros),0)::text AS micros FROM trading.collateral_reservations WHERE state='HELD'",
            )
          ).rows;
          assert.deepEqual(held, { n: 3, micros: "11400000" });
          // Free the collateral for the next round.
          await pools.owner.query(
            "UPDATE trading.collateral_reservations SET state='RELEASED'; UPDATE trading.quotes SET status='EXPIRED'",
          );
        }
        // The two takers' last-collateral race on the final slot alone.
        s.chain.state.view.makerFreeMicros = 5_000_000n;
        const [x, y] = await Promise.all([
          s.post(s.apps[0]!, s.takers[0]!, "last-a"),
          s.post(s.apps[1]!, s.takers[1]!, "last-b"),
        ]);
        assert.deepEqual([x.statusCode, y.statusCode].sort(), [200, 409]);
        assert.equal(
          [x, y].find((res) => res.statusCode === 409)!.json().code,
          "INSUFFICIENT_MAKER_BALANCE",
        );
      } finally {
        await s.close();
      }
    });
  },
);

test(
  "real PostgreSQL: concurrent retries of one Idempotency-Key create one quote, one reservation and one signature",
  { skip: !adminUrl, timeout: 60_000 },
  async () => {
    const { withDatabase } = await import("../helpers/postgres-database.js");
    await withDatabase(async (pools) => {
      const s = await stack(pools, { free: 1_000_000_000n });
      try {
        for (let round = 0; round < 3; round++) {
          const key = "same-" + round;
          const results = await Promise.all(
            [0, 1, 2, 3].map((i) => s.post(s.apps[i % 2]!, s.takers[0]!, key)),
          );
          for (const res of results)
            assert.ok(
              res.statusCode === 200 ||
                (res.statusCode === 409 &&
                  res.json().code === "REQUEST_IN_PROGRESS"),
              res.body,
            );
          const done = results.filter((res) => res.statusCode === 200);
          assert.ok(done.length >= 1);
          for (const res of done) assert.deepEqual(res.json(), done[0]!.json());
          // Once finished, every retry gets that same envelope.
          assert.deepEqual(
            (await s.post(s.apps[1]!, s.takers[0]!, key)).json(),
            done[0]!.json(),
          );
        }
        const [totals] = (
          await pools.owner.query(
            `SELECT (SELECT count(*) FROM trading.quotes)::int AS quotes,
              (SELECT count(*) FROM trading.collateral_reservations)::int AS reservations,
              (SELECT count(*) FROM signing.artifacts)::int AS artifacts`,
          )
        ).rows;
        assert.deepEqual(totals, { quotes: 3, reservations: 3, artifacts: 3 });
      } finally {
        await s.close();
      }
    });
  },
);

test(
  "real PostgreSQL: reconciliation, quoting and signer rejections share the pool without deadlocks",
  { skip: !adminUrl, timeout: 90_000 },
  async () => {
    const { withDatabase } = await import("../helpers/postgres-database.js");
    await withDatabase(async (pools) => {
      const s = await stack(pools, { free: 1_000_000_000n });
      try {
        // The indexer saw the maker bump its epoch, but the RPC view the RFQ reads still says 3:
        // the signer rejects every quote while reconciliation releases the same reservations.
        await pools.owner.query("UPDATE chain.maker_state SET epoch=4");
        for (let round = 0; round < 8; round++) {
          const work = [
            ...[0, 1, 2, 3].map((i) =>
              s.post(s.apps[i % 2]!, s.takers[i % 2]!, `d${round}-${i}`, {
                ...rfqBody,
                quantity: "1",
                maxCostMicros: "1000000",
              }),
            ),
            ...[0, 1, 2, 3].map(() => s.reconciler.reconcileOnce(DEPLOYMENT)),
          ];
          const results = await Promise.all(work);
          for (const res of results.slice(0, 4) as {
            statusCode: number;
            json(): { code: string };
          }[])
            assert.equal(res.statusCode, 409, JSON.stringify(res.json()));
        }
        await s.reconciler.reconcileOnce(DEPLOYMENT);
        const { rows } = await pools.owner.query(
          "SELECT state, count(*)::int AS n FROM trading.collateral_reservations GROUP BY state",
        );
        assert.deepEqual(rows, [{ state: "RELEASED", n: 32 }]);
        const quotes = await pools.owner.query(
          "SELECT DISTINCT status FROM trading.quotes ORDER BY status",
        );
        assert.ok(
          quotes.rows.every((row) =>
            ["CANCELLED", "SIGN_REJECTED"].includes(row.status),
          ),
          JSON.stringify(quotes.rows),
        );
      } finally {
        await s.close();
      }
    });
  },
);

for (const quoteStatus of ["SIGN_UNKNOWN", "EXPIRED"]) {
  test(
    `real PostgreSQL: a different RFQ payload conflicts while the key lock is busy (${quoteStatus})`,
    { skip: !adminUrl, timeout: 60_000 },
    async () => {
      const { withDatabase } = await import("../helpers/postgres-database.js");
      await withDatabase(async (pools) => {
        const s = await stack(pools, { free: 1_000_000_000n });
        const lock = await pools.owner.connect();
        try {
          s.signing.faults.loseRequest = true;
          assert.equal(
            (await s.post(s.apps[0]!, s.takers[0]!, "busy")).statusCode,
            503,
          );
          await pools.owner.query("UPDATE trading.quotes SET status=$1", [
            quoteStatus,
          ]);
          await lock.query("BEGIN");
          await lock.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [
              JSON.stringify([
                "idempotency",
                s.takers[0]!.operatorId,
                "POST /v1/rfqs",
                "busy",
              ]),
            ],
          );
          s.signing.faults.loseRequest = false;
          const beforeCalls = s.signing.calls.length;
          const response = await s.post(s.apps[1]!, s.takers[0]!, "busy", {
            ...rfqBody,
            quantity: "11",
          });
          assert.equal(response.statusCode, 409, response.body);
          assert.equal(response.json().code, "IDEMPOTENCY_CONFLICT");
          assert.equal(s.signing.calls.length, beforeCalls);
          const record = await lock.query(
            "SELECT state FROM operations.idempotency_records",
          );
          assert.equal(record.rows[0].state, "IN_PROGRESS");
        } finally {
          await lock.query("ROLLBACK");
          lock.release();
          await s.close();
        }
      });
    },
  );
}

test(
  "real PostgreSQL: slow RFQ RPC calls cannot starve unrelated API routes",
  { skip: !adminUrl, timeout: 60_000 },
  async () => {
    const { withDatabase } = await import("../helpers/postgres-database.js");
    await withDatabase(async (pools) => {
      const s = await stack(pools, { free: 1_000_000_000n, isolatePool: true });
      let release!: () => void;
      let entered!: () => void;
      const bothReading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reads = 0;
      s.chain.state.onRead = async () => {
        if (++reads === 2) entered();
        await gate;
      };
      const requests = ["slow-a", "slow-b"].map((key) =>
        s.post(s.apps[0]!, s.takers[0]!, key),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await bothReading;
        const probe = await Promise.race([
          s.apps[0]!.inject({ method: "GET", url: "/unrelated" }),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 1000);
          }),
        ]);
        assert.ok(
          probe,
          "unrelated route was starved by RFQ admission connections",
        );
        assert.equal(probe.statusCode, 200);
        assert.deepEqual(probe.json(), { ready: true });
      } finally {
        clearTimeout(timer);
        release();
        const responses = await Promise.all(requests);
        await s.close();
        for (const response of responses)
          assert.equal(response.statusCode, 200, response.body);
      }
    });
  },
);
