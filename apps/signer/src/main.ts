import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { signRoles, signingLimits, type SignRole } from "@blink/domain";
import {
  assertProductionClock,
  assertSignerRuntimeRole,
  encodeAllowedCall,
  postgresReservationReader,
  postgresSignerStore,
  readKeyFile,
  viemSignerRpc,
} from "@blink/adapters";
import {
  assertSignerStartup,
  createReservationQuoteCheck,
  createSignerService,
} from "@blink/application";
import { DeploymentManifest } from "@blink/schemas";
import { createService, startService } from "@blink/runtime";
import { signerConfig } from "./config.js";
import { buildSignerServer } from "./server.js";

let pool: pg.Pool | null = null;
// Every failure, including an invalid configuration, leaves as a code only and exit status 1.
try {
  const config = signerConfig(process.env);
  if (!config.enabled) {
    // Without SIGNER_ENABLED=true the process is a health-only stub: no key is read, no route signs.
    await startService(createService("signer"), config.port, config.host);
  } else {
    pool = new pg.Pool({
      connectionString: config.databaseUrl!,
      max: 4,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      query_timeout: 10000,
      idle_in_transaction_session_timeout: 15000,
    });
    pool.on("error", () => console.error("SIGNER_DATABASE_CONNECTION_ERROR"));
    await assertSignerRuntimeRole(pool);
    // blink.now() dates the gas budget: a shifted test clock must never reach a real signer.
    await assertProductionClock(
      pool,
      process.env.BLINK_ALLOW_TEST_CLOCK === "1",
    );
    // The reservation check reads trading.*: a database without that migration cannot sign quotes.
    await pool.query("SELECT id FROM trading.quotes LIMIT 0");
    const store = postgresSignerStore(pool);
    const rpc = viemSignerRpc({
      url: config.rpcUrl!,
      timeoutMs: config.rpcTimeoutMs,
    });
    const row = await store.loadDeployment(config.deploymentId!);
    if (!row) throw new Error("DEPLOYMENT_NOT_FOUND");
    const manifest = DeploymentManifest.safeParse(row.manifest);
    if (!manifest.success) throw new Error("DEPLOYMENT_MANIFEST_INVALID");
    await assertSignerStartup({ store, rpc, deployment: manifest.data });
    // Keys are read from owner-only files and live in this process only.
    const keys: Partial<
      Record<SignRole, ReturnType<typeof privateKeyToAccount>>
    > = {};
    for (const role of signRoles) {
      const path = config.keyFiles[role];
      if (path) keys[role] = privateKeyToAccount(await readKeyFile(path));
    }
    const service = createSignerService({
      store,
      keys,
      rpc,
      deployment: manifest.data,
      callers: config.callers,
      policy: {
        l1FeeMode: config.l1FeeMode,
        perTxCapWei: signingLimits.perTxCapWei,
        dailyCapWei: signingLimits.dailyCapWei,
      },
      encodeCall: encodeAllowedCall,
      // A quote is signed only while a reservation of its maker cost is HELD (RFQ service, Task 9).
      quoteCheck: createReservationQuoteCheck(postgresReservationReader()),
      // Codes only: an error message must never carry a key, a token or a request body.
      onError: (error) =>
        console.error(
          "SIGNER_SIGN_ERROR:" +
            (error instanceof Error &&
            /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
              ? error.message
              : "UNEXPECTED"),
        ),
    });
    const database = pool;
    const app = buildSignerServer(service, async () => {
      // Startup checks passed; ready means the dependencies still answer right now: the database,
      // an enabled deployment, and an RPC that is still the 84532 chain.
      await database.query("SELECT 1");
      const current = await store.loadDeployment(manifest.data.deploymentId);
      return current?.enabled === true && (await rpc.chainId()) === 84532;
    });
    app.addHook("onClose", async () => {
      await pool?.end();
    });
    await startService(app, config.port, config.host);
  }
} catch (error) {
  await pool?.end().catch(() => undefined);
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
      ? error.message
      : "SIGNER_STARTUP_FAILED";
  console.error(code);
  process.exitCode = 1;
}
