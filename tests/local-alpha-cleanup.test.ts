import { test } from "node:test";
import assert from "node:assert/strict";
import { runCleanup } from "../scripts/local-alpha.ts";

test("a failing cleanup step does not stop the others and is reported", async () => {
  const ran: string[] = [];
  const boom = new Error("drop failed");
  await assert.rejects(
    runCleanup([
      ["process api", async () => void ran.push("process api")],
      ["drop database", async () => Promise.reject(boom)],
      ["drop role", async () => void ran.push("drop role")],
      ["anvil", () => Promise.reject(new Error("anvil stuck"))],
      ["temp directory", async () => void ran.push("temp directory")],
    ]),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /LOCAL_ALPHA_CLEANUP_FAILED: drop database, anvil$/);
      assert.deepEqual(error.errors, [boom, error.errors[1]]);
      return true;
    },
  );
  assert.deepEqual(ran, ["process api", "drop role", "temp directory"]);
});

test("cleanup that succeeds resolves", async () => {
  await runCleanup([["step", async () => undefined]]);
});
