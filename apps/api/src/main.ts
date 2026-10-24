import { buildApi } from "./server.js";
import { startService } from "@blink/runtime";
import pg from "pg";
import {
  createIdentityService,
  createHealthService,
  createOperatorStatusService,
  createForecastService,
  createMarketReadService,
  createMetricsService,
  authenticateIdentity,
} from "@blink/application";
import {
  identityCrypto,
  postgresIdentityStore,
  assertIdentityRuntimeRole,
  assertProductionClock,
  postgresForecastStore,
  fileObjectStore,
  createSpecArchive,
  postgresMarketReadStore,
  postgresEvaluationStore,
  postgresHealthReader,
  postgresOperatorStatusStore,
} from "@blink/adapters";
import { apiConfig, modeAtLeast } from "./config.js";

const config = apiConfig(process.env);
const pool =
  config.mode !== "scaffold"
    ? new pg.Pool({
        connectionString: config.databaseUrl,
        max: 10,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        idle_in_transaction_session_timeout: 10000,
      })
    : null;
pool?.on("error", () => {
  console.error("API_DATABASE_CONNECTION_ERROR");
});
try {
  // Deployment runs migrations separately. Startup never creates tables or credentials.
  if (pool) {
    await assertIdentityRuntimeRole(pool);
    await assertProductionClock(pool, false);
    if (modeAtLeast(config.mode, "markets"))
      await pool.query("SELECT id FROM chain.transactions LIMIT 0");
    await pool.query("SELECT id FROM identity.api_keys LIMIT 0");
    if (modeAtLeast(config.mode, "markets"))
      await pool.query("SELECT id FROM forecasts.windows LIMIT 0");
  }
  const health =
    pool && config.mode === "markets"
      ? createHealthService({
          reader: postgresHealthReader(pool, config.deploymentId!),
          authenticateAdmin: (authorization) =>
            createIdentityService(
              postgresIdentityStore(pool),
              identityCrypto,
              config.walletOrigin!,
            ).authenticate(authorization, "admin"),
        })
      : undefined;
  const app = buildApi(
    pool
      ? {
          trustedProxies: config.trustedProxies,
          ...(health ? { health } : {}),
          assertReady: () => assertProductionClock(pool, false),
          identity: createIdentityService(
            postgresIdentityStore(pool),
            identityCrypto,
            config.walletOrigin!,
          ),
          services: modeAtLeast(config.mode, "markets")
            ? [
                ...(health
                  ? [
                      health,
                      createOperatorStatusService({
                        store: postgresOperatorStatusStore(
                          pool,
                          config.deploymentId!,
                        ),
                        health,
                        authenticateAdmin: (authorization) =>
                          createIdentityService(
                            postgresIdentityStore(pool),
                            identityCrypto,
                            config.walletOrigin!,
                          ).authenticate(authorization, "admin"),
                      }),
                    ]
                  : []),
                createMetricsService({ store: postgresEvaluationStore(pool) }),
                createForecastService({
                  store: postgresForecastStore(pool),
                  crypto: identityCrypto,
                }),
                createMarketReadService({
                  store: postgresMarketReadStore(pool),
                  archive: createSpecArchive(
                    fileObjectStore(config.specDirectory!),
                  ),
                  identity: {
                    authenticate: (authorization) =>
                      postgresIdentityStore(pool).run(async (tx) => {
                        const principal = await authenticateIdentity(
                          tx,
                          identityCrypto,
                          authorization,
                        );
                        return {
                          ...principal,
                          wallet: await tx.wallet(principal.agentId),
                        };
                      }),
                  },
                }),
              ]
            : [],
          ...(config.mode === "markets"
            ? {
                stage: `m2-${config.mode}` as const,
                publicReadLimit: { capacity: 60, refillPerSecond: 1 },
              }
            : {}),
        }
      : { trustedProxies: config.trustedProxies },
  );
  if (pool)
    app.addHook("onClose", async () => {
      await pool.end();
    });
  await startService(app, config.port, config.host);
} catch {
  await pool?.end();
  console.error(
    "API_STARTUP_FAILED: check mode, origin, database permissions and migrations",
  );
  process.exitCode = 1;
}
