import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileObjectStore } from "../packages/adapters/src/file-object-store.js";
import { keccak256 } from "viem";
import {
  MarketSpecV011,
  ResolutionPolicy,
  PublicMarketRef,
  requireDeployment,
  generateOpenApi,
  Uint256,
} from "../packages/schemas/src/index.js";
import {
  createSpecArchive,
  encodeNewSpec,
  verifySpecBytes,
} from "../packages/adapters/src/spec-archive.js";
import { buildApi } from "../apps/api/src/server.js";
import { routes } from "../apps/api/src/routes.js";
import { apiContracts } from "../packages/schemas/src/index.js";
import { spawnSync } from "node:child_process";

export async function newSpec() {
  const old = JSON.parse(
    await readFile("fixtures/replay/market-spec.json", "utf8"),
  );
  return {
    ...old,
    schemaVersion: "blink.market.v0.1.1",
    resolutionPolicy: {
      hardDeadlineOutcome: "INVALID",
      unfinalizedProposalAtHardDeadline: "INVALID",
      invalidPayoutRule: "HALF_PER_SIDE_NOT_PURCHASE_REFUND",
      authorityModel: "TEAM_OPERATED_WHITELISTED_ROLES",
    },
  };
}
test("spec freeze persists and returns exact bytes; whitespace tampering fails", async () => {
  const input = await newSpec();
  const { bytes, hash } = encodeNewSpec(input, 0n);
  assert.equal(
    MarketSpecV011.parse(input).schemaVersion,
    "blink.market.v0.1.1",
  );
  assert.equal(verifySpecBytes(bytes, hash).mode, "REPLAY");
  assert.throws(
    () => verifySpecBytes(new Uint8Array([...bytes, 32]), hash),
    /HASH_MISMATCH/,
  );
  assert.throws(
    () =>
      encodeNewSpec({ ...input, mode: "LIVE", challengeSeconds: 86400 }, 0n),
    /PLACEHOLDER/,
  );
  assert.throws(
    () => encodeNewSpec(input, BigInt(input.closeAt)),
    /MARKET_CLOSED/,
  );
  assert.equal(
    ResolutionPolicy.safeParse({
      ...input.resolutionPolicy,
      hardDeadlineOutcome: "YES",
    }).success,
    false,
  );
  let stored = new Uint8Array();
  const archive = createSpecArchive({
    async putIfAbsent(value) {
      stored = value.slice();
      return { uri: "memory:test" };
    },
    async read() {
      return stored.slice();
    },
  });
  await archive.freeze(input, 0n);
  assert.deepEqual(await archive.read("memory:test", hash), bytes);
  stored[0] = 0;
  await assert.rejects(archive.read("memory:test", hash), /HASH_MISMATCH/);
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  assert.equal(encodeNewSpec(reordered, 0n).hash, hash);
  assert.notEqual(
    keccak256(new TextEncoder().encode(JSON.stringify(input, null, 2))),
    hash,
  );
});
test("wire integers, deployment identity and template rejection", async () => {
  for (const bad of ["-1", "1.5", "NaN", "01", "x", (2n ** 256n).toString()])
    assert.equal(Uint256.safeParse(bad).success, false);
  assert.equal(
    PublicMarketRef.safeParse({ marketId: "1", mode: "LIVE" }).success,
    false,
  );
  assert.equal(
    PublicMarketRef.safeParse({
      deploymentId: "d",
      marketId: "uuid",
      mode: "LIVE",
    }).success,
    false,
  );
  const template = JSON.parse(
    await readFile("deployments/base-sepolia/manifest.template.json", "utf8"),
  );
  assert.throws(() => requireDeployment(template, "d", 84532));
  const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
  const hash = "0x" + "1".repeat(64);
  const valid = {
    ...template,
    status: "DEPLOYED",
    deploymentId: "d",
    deploymentBlock: "1",
    contracts: { BlinkTestUSD: addr(10), BlinkMarket: addr(11) },
    artifacts: {
      abiHashes: { BlinkTestUSD: hash, BlinkMarket: hash },
      bytecodeHashes: { BlinkTestUSD: hash, BlinkMarket: hash },
      compiler: "0.8.30",
      gitCommit: "1".repeat(40),
      dependencies: { openzeppelin: "5.6.1" },
    },
    roles: {
      admin: addr(1),
      resultProposer: addr(2),
      challenger: addr(3),
      arbiter: addr(4),
      maker: addr(5),
      faucetMinter: addr(6),
    },
  };
  assert.equal(requireDeployment(valid, "d", 84532).deploymentId, "d");
  assert.throws(() => requireDeployment(valid, "other", 84532));
  assert.throws(() => requireDeployment(valid, "d", 8453));
  assert.throws(() =>
    requireDeployment(
      { ...valid, roles: { ...valid.roles, arbiter: addr(1) } },
      "d",
      84532,
    ),
  );
});
test("file archive is content addressed, exclusive and rejects path escape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blink-m0-"));
  try {
    const store = fileObjectStore(dir);
    const archive = createSpecArchive(store);
    const frozen = await archive.freeze(await newSpec(), 0n);
    assert.deepEqual(await archive.read(frozen.uri, frozen.hash), frozen.bytes);
    assert.equal((await archive.freeze(await newSpec(), 0n)).uri, frozen.uri);
    await assert.rejects(store.read("local-object:../../secrets"), /INVALID/);
    await assert.rejects(
      store.putIfAbsent(new Uint8Array([0]), frozen.hash),
      /HASH_MISMATCH/,
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});
test("every business endpoint has request/response contracts and stays disabled", async () => {
  assert.deepEqual(
    apiContracts.map((c) => c.method + c.path).sort(),
    routes.map((c) => c.method + c.path).sort(),
  );
  const doc = generateOpenApi();
  assert.equal(doc.openapi, "3.1.0");
  const app = buildApi();
  try {
    assert.equal((await app.inject("/v1/markets/1")).statusCode, 400);
    assert.equal(
      (await app.inject("/v1/markets/1?deploymentId=d")).statusCode,
      501,
    );
    assert.equal(
      (await app.inject({ method: "POST", url: "/v1/rfqs", payload: {} }))
        .statusCode,
      400,
    );
    assert.equal((await app.inject("/openapi.json")).statusCode, 200);
  } finally {
    await app.close();
  }
});
test("Foundry runner propagates command failures", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/foundry.mjs", "forge", "--invalid-blink-option"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
});
