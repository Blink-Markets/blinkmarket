import { parseArgs } from "node:util";
import pg from "pg";
import { identityAdmin } from "../packages/adapters/src/identity-admin.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "operator-name": { type: "string" },
    "agent-name": { type: "string" },
    "agent-id": { type: "string" },
    "key-id": { type: "string" },
    scopes: { type: "string" },
    days: { type: "string", default: "30" },
    reason: { type: "string" },
  },
});
const url = process.env.IDENTITY_ADMIN_DATABASE_URL;
if (!url) throw new Error("IDENTITY_ADMIN_DATABASE_URL_REQUIRED");
const pool = new pg.Pool({ connectionString: url });
try {
  const admin = identityAdmin(pool);
  const common = {
    scopes: values.scopes?.split(","),
    lifetimeDays: Number(values.days),
    reason: values.reason,
  };
  let result: unknown;
  if (positionals.length !== 1) throw new Error("INVALID_COMMAND");
  if (positionals[0] === "invite")
    result = await admin.invite({
      ...common,
      operatorName: values["operator-name"],
      agentName: values["agent-name"],
    });
  else if (positionals[0] === "issue" && values["agent-id"])
    result = await admin.issue(values["agent-id"], common);
  else if (positionals[0] === "revoke" && values["key-id"] && values.reason)
    result = await admin.revoke(values["key-id"], values.reason);
  else throw new Error("INVALID_COMMAND");
  // Explicit administrator action: the secret is shown once, never stored in audit/DB.
  console.error(
    "Sensitive output: deliver API keys through a secure channel; do not save in shared logs.",
  );
  console.log(JSON.stringify(result));
} catch {
  console.error(
    "IDENTITY_ADMIN_FAILED: check arguments, DB role and migrations",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
