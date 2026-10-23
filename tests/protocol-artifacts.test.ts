import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

test("compiles protocol contracts within EIP-170", () => {
  const run = spawnSync(process.execPath, ["scripts/check-contracts.mjs"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync("contracts/artifacts/BlinkFaucet.json"));
});
