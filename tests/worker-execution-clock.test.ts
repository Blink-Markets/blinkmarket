import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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

// `allowTestClock` is a parameter only a harness passes. No runtime check can see a later edit
// to the worker's main.ts, so this reads the sources.
test("apps/worker never passes allowTestClock to buildExecution or allows a test clock itself", async () => {
  const directory = new URL("../apps/worker/src/", import.meta.url);
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith(".ts"),
  );
  assert.ok(files.includes("main.ts") && files.includes("execution.ts"));
  for (const name of files) {
    const source = await readFile(new URL(name, directory), "utf8");
    if (name !== "execution.ts")
      assert.doesNotMatch(source, /allowTestClock|ALLOW_TEST_CLOCK/, name);
    assert.doesNotMatch(source, /assertProductionClock\([^)]*\btrue\b/, name);
  }
});
