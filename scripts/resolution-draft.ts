import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  resolutionDraft,
  type ResolutionDraftInput,
} from "../packages/adapters/src/resolution-draft.js";
export async function resolutionDraftCommand(args: string[], pool: pg.Pool) {
  const { values } = parseArgs({
    args,
    options: {
      deployment: { type: "string" },
      market: { type: "string" },
      action: { type: "string" },
      outcome: { type: "string" },
      "evidence-hash": { type: "string" },
    },
  });
  if (
    !values.deployment ||
    !values.market ||
    !values.action ||
    !values.outcome ||
    !values["evidence-hash"]
  )
    throw new Error("INVALID_ARGUMENTS");
  return resolutionDraft(pool, {
    deploymentId: values.deployment,
    marketId: values.market,
    action: values.action as ResolutionDraftInput["action"],
    outcome: values.outcome as ResolutionDraftInput["outcome"],
    evidenceHash: values["evidence-hash"],
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const connectionString = process.env.RESOLUTION_DATABASE_URL;
  if (!connectionString) throw new Error("RESOLUTION_DATABASE_URL_REQUIRED");
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    options: "-c default_transaction_read_only=on",
  });
  try {
    console.log(
      JSON.stringify(await resolutionDraftCommand(process.argv.slice(2), pool)),
    );
  } catch (error) {
    console.error(
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : "RESOLUTION_DRAFT_FAILED",
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
