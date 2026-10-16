import { test } from "node:test";
import assert from "node:assert/strict";
import { withDatabase } from "../helpers/postgres-database.js";
import { assertIdentityRuntimeRole } from "../../packages/adapters/src/identity-store.js";
import { assertWorkerRuntimeRole } from "../../packages/adapters/src/job-queue.js";
import { assertCreationTrackingRuntimeRole } from "../../packages/adapters/src/creation-tracking-schedule.js";
import { assertSignerRuntimeRole } from "../../packages/adapters/src/signing-store.js";

const services = [
  ["blink_api", assertIdentityRuntimeRole],
  ["blink_worker", assertWorkerRuntimeRole],
  ["blink_indexer", assertCreationTrackingRuntimeRole],
  ["blink_signer", assertSignerRuntimeRole],
] as const;

test("real PostgreSQL: each service requires exactly one runtime group and no admin membership", async () => {
  await withDatabase(async ({ login }) => {
    for (const [role, guard] of services) {
      await guard(await login({ memberOf: [role] }));
      for (const second of [
        "blink_api",
        "blink_worker",
        "blink_indexer",
        "blink_signer",
        "blink_identity_admin",
        "blink_evidence_admin",
        "blink_deployment_admin",
        "blink_forecast_admin",
        "blink_trading_admin",
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
