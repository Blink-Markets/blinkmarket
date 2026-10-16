import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExecution } from "../apps/worker/src/execution.js";
import { createTestDatabase } from "./helpers/database.js";

const config = {
  deploymentId: "no-such-deployment",
  signerUrl: "http://127.0.0.1:1",
  signerToken: "unused",
  rpcUrl: "http://127.0.0.1:1",
};
const queue = {} as never;

test("the worker's execution wiring refuses a shifted business clock unless a harness allows it", async () => {
  const t = await createTestDatabase();
  try {
    await t.db.exec(
      "SELECT set_config('blink.test_clock_offset_seconds','3600',false)",
    );
    await assert.rejects(
      buildExecution({ pool: t.pool, queue, config }),
      /TEST_CLOCK_FORBIDDEN/,
    );
    // Allowed, it gets past the clock check (and then fails on the missing deployment).
    await assert.rejects(
      buildExecution({ pool: t.pool, queue, config, allowTestClock: true }),
      (error) =>
        error instanceof Error && !/TEST_CLOCK_FORBIDDEN/.test(error.message),
    );
  } finally {
    await t.close();
  }
});
