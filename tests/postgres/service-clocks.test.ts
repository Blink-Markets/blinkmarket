import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { withDatabase } from "../helpers/postgres-database.js";

function start(service: string, env: Record<string, string>) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", `apps/${service}/src/main.ts`],
    {
      env: { PATH: process.env.PATH!, ...env },
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    stderr: () => stderr,
    exited: new Promise<number | null>((resolve) => child.on("exit", resolve)),
  };
}

test(
  "real PostgreSQL: markets API, worker and each independent indexer refuse a shifted clock",
  { timeout: 180000 },
  async () => {
    await withDatabase(async ({ name, owner, login }) => {
      await owner.query(
        `ALTER DATABASE "${name}" SET blink.test_clock_offset_seconds = '3600'`,
      );
      for (const [service, role, env] of [
        [
          "api",
          "blink_api",
          {
            BLINK_API_MODE: "markets",
            WALLET_BINDING_ORIGIN: "https://blink.example",
            SPEC_OBJECT_DIRECTORY: "/tmp",
            BLINK_DEPLOYMENT_ID: "test",
          },
        ],
        ["worker", "blink_worker", { WORKER_ENABLED: "true" }],
        [
          "indexer",
          "blink_indexer",
          { CHAIN_INDEXER_ENABLED: "true", INDEXER_DEPLOYMENT_ID: "test" },
        ],
        ["indexer", "blink_indexer", { INDEXER_TX_TRACKING_ENABLED: "true" }],
      ] as const) {
        const db = await login({ memberOf: [role] });
        const process = start(service, {
          ...env,
          [`${service.toUpperCase()}_DATABASE_URL`]:
            db.options.connectionString!,
          BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:1",
        });
        try {
          assert.equal(
            await Promise.race([
              process.exited,
              new Promise((resolve) => {
                const timer = setTimeout(() => resolve("still running"), 30000);
                timer.unref();
              }),
            ]),
            1,
            service,
          );
          assert.match(
            process.stderr(),
            service === "api" ? /API_STARTUP_FAILED/ : /TEST_CLOCK_FORBIDDEN/,
          );
        } finally {
          process.child.kill("SIGTERM");
          await process.exited;
        }
      }
    });
  },
);

test(
  "real PostgreSQL: worker readiness re-checks the clock on replacement pool sessions",
  { timeout: 180000 },
  async () => {
    await withDatabase(async ({ name, owner, login }) => {
      for (const [service, role, port, env, path] of [
        [
          "worker",
          "blink_worker",
          3002,
          { WORKER_ENABLED: "true" },
          "/health/ready",
        ],
      ] as const) {
        const db = await login({ memberOf: [role] });
        const child = start(service, {
          ...env,
          [`${service.toUpperCase()}_DATABASE_URL`]:
            db.options.connectionString!,
          BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:1",
        });
        const url = `http://127.0.0.1:${port}${path}`;
        const status = async () => {
          try {
            return (await fetch(url)).status;
          } catch {
            return 0;
          }
        };
        try {
          for (let i = 0; i < 600 && (await status()) !== 200; i++)
            await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(await status(), 200, child.stderr());
          const user = new URL(db.options.connectionString!).username;
          await owner.query(
            `ALTER ROLE "${user}" SET blink.test_clock_offset_seconds = '3600'`,
          );
          await owner.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND pid<>pg_backend_pid()",
            [name, user],
          );
          assert.equal(
            await status(),
            503,
            `${service} clock changed after startup`,
          );
        } finally {
          child.child.kill("SIGTERM");
          await child.exited;
        }
      }
    });
  },
);

test("real PostgreSQL: both API readiness routes check the clock despite a cached ready health snapshot", async () => {
  const { buildApi } = await import("../../apps/api/src/server.js");
  const { assertProductionClock } =
    await import("../../packages/adapters/src/business-clock.js");
  await withDatabase(async ({ owner, login, name }) => {
    const database = await login({ memberOf: ["blink_api"] });
    database.on("error", () => {});
    const app = buildApi({
      health: {
        read: async () => ({
          status: "ready",
          tradingEnabled: true,
          reasons: [],
        }),
      },
      assertReady: () => assertProductionClock(database, false),
    });
    app.log.level = "silent";
    try {
      assert.equal((await app.inject("/health/ready")).statusCode, 200);
      assert.equal((await app.inject("/v1/health")).statusCode, 200);
      const user = new URL(database.options.connectionString!).username;
      await owner.query(
        `ALTER ROLE "${user}" SET blink.test_clock_offset_seconds = '3600'`,
      );
      await owner.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND pid<>pg_backend_pid()",
        [name, user],
      );
      assert.equal((await app.inject("/health/ready")).statusCode, 503);
      assert.equal((await app.inject("/v1/health")).statusCode, 503);
    } finally {
      await app.close();
    }
  });
});
