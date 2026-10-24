import { test } from "node:test";
import assert from "node:assert/strict";
import { withDatabase } from "../helpers/postgres-database.js";
import { assertIdentityRuntimeRole } from "../../packages/adapters/src/identity-store.js";
import { assertWorkerRuntimeRole } from "../../packages/adapters/src/job-queue.js";
import { assertIndexerRuntimeRole } from "../../packages/adapters/src/runtime-role.js";

const services = [
  ["blink_api", assertIdentityRuntimeRole],
  ["blink_worker", assertWorkerRuntimeRole],
  ["blink_indexer", assertIndexerRuntimeRole],
] as const;

test("real PostgreSQL: each service requires exactly one runtime group and no admin membership", async () => {
  await withDatabase(async ({ login }) => {
    for (const [role, guard] of services) {
      await guard(await login({ memberOf: [role] }));
      for (const second of [
        "blink_api",
        "blink_worker",
        "blink_indexer",
        "blink_evidence_admin",
        "blink_deployment_admin",
        "blink_forecast_admin",
      ].filter((r) => r !== role)) {
        await assert.rejects(
          guard(await login({ memberOf: [role, second] })),
          /UNSAFE_.*_DATABASE_ROLE/,
          `${role} + ${second}`,
        );
      }
    }
  });
});
