import { buildApi } from "./server.js";
import { startService } from "@blink/runtime";
import pg from "pg";
import {
  createIdentityService,
  createPreparationService,
  createApprovalService,
  createForecastService,
} from "@blink/application";
import {
  identityCrypto,
  postgresIdentityStore,
  assertIdentityRuntimeRole,
  postgresPreparationStore,
  postgresApprovalStore,
  postgresForecastStore,
  fileObjectStore,
  createSpecArchive,
  encodeMarketCreation,
  evidenceIntegrity,
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
                createForecastService({
                  store: postgresForecastStore(pool),
                  crypto: identityCrypto,
                }),
              ]
            : [],
          ...(config.mode === "markets" || config.mode === "trading"
            ? { stage: `m2-${config.mode}` as const }
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
