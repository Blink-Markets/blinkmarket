import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";

test("compiles protocol contracts within EIP-170", () => {
  const run = spawnSync(process.execPath, ["scripts/check-contracts.mjs"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync("contracts/artifacts/BlinkFaucet.json"));
});

// The forced-recompile path is not repeated here: it costs a full ~50 s solc-js compile, and it
// already runs whenever contracts/src, solc, OpenZeppelin or the script itself changes.
test("an unchanged contract set skips the recompile", () => {
  const rerun = spawnSync(process.execPath, ["scripts/check-contracts.mjs"], { encoding: "utf8" });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /contracts unchanged/);
  assert.ok(existsSync("contracts/artifacts/.inputs.sha256"));
});

test("protocol contracts expose no privileged functions", () => {
  const names = readdirSync("contracts/src/protocol")
    .filter((name) => name.endsWith(".sol"))
    .map((name) => name.slice(0, -4))
    .filter((name) => name !== "BlinkGovernor" && name !== "BlinkTypes");
  assert.ok(names.length >= 7, "scan the concrete protocol contract set");
  for (const name of names) {
    const artifact = JSON.parse(
      readFileSync(`contracts/artifacts/${name}.json`, "utf8"),
    );
    assert.notEqual(artifact.bytecode, "0x", `${name} is a concrete contract`);
    for (const entry of artifact.abi) {
      if (entry.type !== "function") continue;
      if (
        name === "BlinkMarkets" &&
        ["setProposed", "setDisputed"].includes(entry.name)
      )
        continue;
      assert.ok(
        !/owner|admin|pause|initiali[sz]e|upgrade|^bind/i.test(entry.name) &&
          !/^set[A-Z]/.test(entry.name),
        `${name}.${entry.name} exposes a privileged function`,
      );
    }
  }
});
