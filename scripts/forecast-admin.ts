import { parseArgs } from "node:util";
import pg from "pg";
import {
  forecastAdmin,
  assertForecastAdminRole,
} from "../packages/adapters/src/forecast-admin.js";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "submission-id": { type: "string" },
    kind: { type: "string" },
    reason: { type: "string" },
  },
});
const connectionString = process.env.FORECAST_ADMIN_DATABASE_URL;
if (!connectionString) throw new Error("FORECAST_ADMIN_CONFIGURATION_REQUIRED");
const pool = new pg.Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
try {
  await assertForecastAdminRole(pool);
  const admin = forecastAdmin(pool);
  if (positionals.length !== 1 || !values.reason)
    throw new Error("INVALID_ARGUMENTS");
  if (
    positionals[0] === "annotate" &&
    values["submission-id"] &&
    values.kind
  ) {
    console.log(
      JSON.stringify(
        await admin.annotate({
          submissionId: values["submission-id"],
          kind: values.kind as
            "WITHDRAWN" | "OUTCOME_ALREADY_PUBLIC" | "WINDOW_CONTAMINATED",
          reason: values.reason,
        }),
      ),
    );
  } else throw new Error("INVALID_ARGUMENTS");
} catch {
  console.error(
    "FORECAST_ADMIN_FAILED: check arguments, reason and database role",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
