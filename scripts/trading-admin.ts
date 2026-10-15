import { parseArgs } from "node:util";
import pg from "pg";
import {
  assertTradingAdminRole,
  tradingAdmin,
  type QuoteGateReason,
} from "../packages/adapters/src/trading-admin.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    deployment: { type: "string" },
    market: { type: "string" },
    reason: { type: "string" },
    note: { type: "string" },
  },
});
const connectionString = process.env.TRADING_ADMIN_DATABASE_URL;
if (!connectionString) throw new Error("TRADING_ADMIN_CONFIGURATION_REQUIRED");
const pool = new pg.Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
try {
  await assertTradingAdminRole(pool);
  const admin = tradingAdmin(pool);
  const [command] = positionals;
  if (
    positionals.length !== 1 ||
    !values.deployment ||
    !values.market ||
    !values.reason ||
    !values.note
  )
    throw new Error("INVALID_ARGUMENTS");
  const input = {
    deploymentId: values.deployment,
    marketId: values.market,
    reason: values.reason as QuoteGateReason,
    note: values.note,
  };
  if (command === "close-gate")
    console.log(JSON.stringify(await admin.closeGate(input)));
  else if (command === "reopen-gate")
    console.log(JSON.stringify(await admin.reopenGate(input)));
  else throw new Error("INVALID_ARGUMENTS");
} catch {
  console.error(
    "TRADING_ADMIN_FAILED: check arguments, reason, gate state and database role",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
