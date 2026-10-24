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
  createContentService,
  createSuggestionService,
  authenticateIdentity,
} from "@blink/application";
import {
  identityCrypto,
  rpcSignatureVerifier,
  postgresIdentityStore,
  assertIdentityRuntimeRole,
  assertProductionClock,
  postgresForecastStore,
  fileObjectStore,
  verifiedArchive,
  postgresContentStore,
  postgresSuggestionStore,
  postgresMarketReadStore,
  postgresEvaluationStore,
  postgresHealthReader,
  postgresOperatorStatusStore,
} from "@blink/adapters";
import { apiConfig, modeAtLeast } from "./config.js";

// Task 5 replaces this with the reader over the indexed store. Until then the index counts as
// stale, so no key is issued and no upload or claim is accepted.
const protocolReaderFor = (_pool: pg.Pool) => ({
  health: async () => ({
    headBlock: 0,
    indexedBlock: 0,
    lagSeconds: 0,
    stale: true,
  }),
  account: async () => null,
  hasRole: async () => false,
  marketBySpecHash: async () => null,
});

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
    if (modeAtLeast(config.mode, "markets")) {
      await pool.query("SELECT hash FROM content.objects LIMIT 0");
      await pool.query("SELECT id FROM suggestions.items LIMIT 0");
    }
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
  const identity = pool
    ? createIdentityService(
        postgresIdentityStore(pool),
        identityCrypto,
        config.walletOrigin!,
        {
          verifier: rpcSignatureVerifier(config.rpcUrl),
          reader: protocolReaderFor(pool),
        },
      )
    : undefined;
  const app = buildApi(
    pool && identity
      ? {
          trustedProxies: config.trustedProxies,
          ...(health ? { health } : {}),
          assertReady: () => assertProductionClock(pool, false),
          identity,
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
                createContentService({
                  store: postgresContentStore(
                    pool,
                    fileObjectStore(config.specDirectory!),
                  ),
                  identity,
                  reader: protocolReaderFor(pool),
                  publicOrigin: config.specPublicOrigin!,
                }),
                createSuggestionService({
                  store: postgresSuggestionStore(pool),
                  identity,
                  reader: protocolReaderFor(pool),
                }),
                createForecastService({
                  store: postgresForecastStore(pool),
                  crypto: identityCrypto,
                }),
                createMarketReadService({
                  store: postgresMarketReadStore(pool),
                  archive: verifiedArchive(
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
