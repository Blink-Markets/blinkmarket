import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DeploymentManifest,
  parseProtocolDeployment,
} from "../packages/schemas/src/index.ts";

const manifest = DeploymentManifest.parse(
  JSON.parse(
    readFileSync("deployments/base-sepolia/alpha-2.manifest.json", "utf8"),
  ),
);
// alpha-2 is the v0.1 record, kept byte-identical as history; manifest v2 refuses it by name.
test("alpha-2 is a historical v0.1 manifest, not a protocol deployment", () => {
  assert.deepEqual(
    parseProtocolDeployment(
      JSON.parse(
        readFileSync("deployments/base-sepolia/alpha-2.manifest.json", "utf8"),
      ),
    ),
    { ok: false, reason: "HISTORICAL_V1_MANIFEST" },
  );
});
const deploymentPage = readFileSync(
  "apps/web/content/docs/deployment.md",
  "utf8",
);

test("alpha-2 manifest and deployment page agree", () => {
  assert.equal(manifest.deploymentId, "alpha-2");
  assert.equal(manifest.chainId, 84532);
  assert.equal(manifest.tradingEnabled, false);

  for (const address of [
    ...Object.values(manifest.contracts),
    ...Object.values(manifest.roles),
  ]) {
    assert.ok(
      deploymentPage.includes(address),
      `deployment page is missing ${address}`,
    );
  }
  assert.ok(
    deploymentPage.includes(manifest.deploymentBlock),
    "deployment page is missing deploymentBlock",
  );
  assert.ok(
    deploymentPage.includes(manifest.artifacts.gitCommit),
    "deployment page is missing artifacts.gitCommit",
  );
});
