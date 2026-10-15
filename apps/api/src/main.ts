import { buildApi } from "./server.js";
import { startService } from "@blink/runtime";
import pg from "pg";
import {
  createIdentityService,
  createFaucetService,
  createPreparationService,
  createApprovalService,
  createForecastService,
  createResolutionService,
  createMarketReadService,
  createMetricsService,
  authenticateIdentity,
} from "@blink/application";
import {
  identityCrypto,
  postgresFaucetStore,
  postgresIdentityStore,
  assertIdentityRuntimeRole,
  assertProductionClock,
  postgresPreparationStore,
  postgresApprovalStore,
  postgresForecastStore,
  postgresResolutionStore,
  fileObjectStore,
  createSpecArchive,
  encodeMarketCreation,
  evidenceIntegrity,
  postgresMarketReadStore,
  postgresEvaluationStore,
  postgresBudgetLedger,
} from "@blink/adapters";
import { apiConfig, modeAtLeast } from "./config.js";
import { tradingServices } from "./trading.js";

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
    if (config.mode === "trading") {
      await assertProductionClock(pool, false);
      await pool.query("SELECT id FROM faucet.claims LIMIT 0");
    }
    if (modeAtLeast(config.mode, "markets"))
      await pool.query("SELECT id FROM chain.transactions LIMIT 0");
    await pool.query("SELECT id FROM identity.api_keys LIMIT 0");
    if (modeAtLeast(config.mode, "preparation"))
      await pool.query("SELECT id FROM discovery.candidates LIMIT 0");
    if (modeAtLeast(config.mode, "approval"))
      await pool.query("SELECT id FROM markets.creation_intents LIMIT 0");
    if (modeAtLeast(config.mode, "approval"))
      await pool.query(
        "SELECT intent_id FROM chain.creation_projections LIMIT 0",
      );
    if (modeAtLeast(config.mode, "markets"))
      await pool.query("SELECT id FROM forecasts.windows LIMIT 0");
  }
  // Trading mode adds the RFQ service, a truthful /v1/config and the canTrade hook of market reads.
  const trading =
    pool && config.mode === "trading"
      ? await tradingServices(pool, {
          deploymentId: config.deploymentId!,
          signerUrl: config.signerUrl!,
          signerToken: config.signerToken!,
          rpcUrl: config.rpcUrl!,
        })
      : null;
  const app = buildApi(
    pool
      ? {
          ...(modeAtLeast(config.mode, "approval")
            ? {
                approval: createApprovalService({
                  store: postgresApprovalStore(pool),
                  crypto: identityCrypto,
                  archive: createSpecArchive(
                    fileObjectStore(config.specDirectory!),
                  ),
                  publicOrigin: config.specOrigin!,
                  verifyEvidence: evidenceIntegrity(
                    fileObjectStore(config.evidenceDirectory!),
                  ),
                  encodeCreation: encodeMarketCreation,
                }),
              }
            : {}),
          ...(modeAtLeast(config.mode, "preparation")
            ? {
                preparation: createPreparationService(
                  postgresPreparationStore(pool),
                  identityCrypto,
                ),
              }
            : {}),
          identity: createIdentityService(
            postgresIdentityStore(pool),
            identityCrypto,
            config.walletOrigin!,
          ),
          services: modeAtLeast(config.mode, "markets")
            ? [
                ...(config.mode === "trading"
                  ? [
                      createFaucetService({
                        store: postgresFaucetStore(pool),
                        crypto: identityCrypto,
                        deploymentId: config.deploymentId!,
                      }),
                    ]
                  : []),
                createMetricsService({
                  store: postgresEvaluationStore(pool),
                  budgets: postgresBudgetLedger(pool),
                }),
                createResolutionService({
                  store: postgresResolutionStore(pool),
                  crypto: identityCrypto,
                }),
                createForecastService({
                  store: postgresForecastStore(pool),
                  crypto: identityCrypto,
                }),
                ...(trading ? [trading.rfq] : []),
                createMarketReadService({
                  store: postgresMarketReadStore(pool),
                  archive: createSpecArchive(
                    fileObjectStore(config.specDirectory!),
                  ),
                  ...(trading
                    ? { hooks: { canTrade: trading.readiness.canTrade } }
                    : {}),
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
          ...(config.mode === "markets" || config.mode === "trading"
            ? {
                stage: `m2-${config.mode}` as const,
                ...(trading ? { config: trading.readiness.config } : {}),
                publicReadLimit: { capacity: 60, refillPerSecond: 1 },
              }
            : {}),
        }
      : {},
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
