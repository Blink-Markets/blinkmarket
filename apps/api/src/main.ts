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
  createRfqService,
  createTxTrackingService,
} from "@blink/application";
import {
  identityCrypto,
  rpcSignatureVerifier,
  postgresProtocolReader,
  staleProtocolReader,
  loadProtocolDeployment,
  postgresIdentityStore,
  assertIdentityRuntimeRole,
  assertProductionClock,
  postgresForecastStore,
  fileObjectStore,
  postgresContentStore,
  postgresSuggestionStore,
  postgresRfqStore,
  postgresTxTrackingStore,
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
    if (modeAtLeast(config.mode, "markets")) {
      await pool.query("SELECT hash FROM content.objects LIMIT 0");
      await pool.query("SELECT id FROM suggestions.items LIMIT 0");
      await pool.query("SELECT id FROM rfq.requests LIMIT 0");
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
  const protocolReader =
    pool && config.deploymentId
      ? postgresProtocolReader(pool, config.deploymentId)
      : staleProtocolReader; // Without a deployment there is no index: no key, upload or claim is accepted.
  const verifier = rpcSignatureVerifier(config.rpcUrl);
  const contentStore =
    pool && modeAtLeast(config.mode, "markets")
      ? postgresContentStore(pool, fileObjectStore(config.specDirectory!))
      : undefined;
  const identity = pool
    ? createIdentityService(
        postgresIdentityStore(pool),
        identityCrypto,
        config.walletOrigin!,
        { verifier, reader: protocolReader },
      )
    : undefined;
  // The relay and transaction tracking belong to one registered generation.
  const generation =
    pool && identity && config.deploymentId && modeAtLeast(config.mode, "markets")
      ? await loadProtocolDeployment(pool, config.deploymentId)
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
                createMetricsService({
                  store: postgresEvaluationStore(pool, config.deploymentId!),
                }),
                createContentService({
                  store: contentStore!,
                  identity,
                  reader: protocolReader,
                  publicOrigin: config.specPublicOrigin!,
                }),
                createSuggestionService({
                  store: postgresSuggestionStore(pool),
                  identity,
                  reader: protocolReader,
                }),
                ...(generation && config.deploymentId
                  ? [
                      createRfqService({
                        store: postgresRfqStore(pool, config.deploymentId),
                        identity,
                        reader: protocolReader,
                        verifier,
                        deployment: {
                          markets: generation.generation.markets,
                          maxFillShares: generation.params.maxFillShares,
                        },
                      }),
                      createTxTrackingService({
                        store: postgresTxTrackingStore(pool),
                        identity,
                        reader: protocolReader,
                        deploymentId: config.deploymentId,
                      }),
                      createForecastService({
                        store: postgresForecastStore(pool, config.deploymentId),
                        identity,
                        reader: protocolReader,
                        verifier,
                        deployment: {
                          markets: generation.generation.markets,
                          anchor: generation.shared.anchor,
                        },
                      }),
                    ]
                  : []),
                createMarketReadService({
                  store: postgresMarketReadStore(pool),
                  reader: protocolReader,
                  content: contentStore!,
                  deployment: () =>
                    loadProtocolDeployment(pool, config.deploymentId!).catch(
                      () => null,
                    ),
                }),
              ]
            : [],
          ...(config.mode === "markets"
            ? {
                stage: `m2-${config.mode}` as const,
                publicReadLimit: config.publicReadLimit ?? { capacity: 60, refillPerSecond: 1 },
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
