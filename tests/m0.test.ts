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
import { verifiedArchive } from "../packages/adapters/src/content-store.js";
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
test("archived bytes are returned exactly and tampering fails", async () => {
  const input = await newSpec();
  assert.equal(
    MarketSpecV011.parse(input).schemaVersion,
    "blink.market.v0.1.1",
  );
  assert.equal(
    ResolutionPolicy.safeParse({
      ...input.resolutionPolicy,
      hardDeadlineOutcome: "YES",
    }).success,
    false,
  );
  // The hash covers exactly these bytes; reordering or reformatting would change it.
  const bytes = new TextEncoder().encode(JSON.stringify(input, null, 2));
  const hash = keccak256(bytes);
  let stored = bytes.slice();
  const archive = verifiedArchive({
    async putIfAbsent() {
      return { uri: "memory:test" };
    },
    async read() {
      return stored.slice();
    },
  });
  assert.deepEqual(await archive.read("memory:test", hash), bytes);
  stored[0] = 0;
  await assert.rejects(archive.read("memory:test", hash), /HASH_MISMATCH/);
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
  // The v0.1 template, inlined: deployments/base-sepolia/manifest.template.json is manifest v2 now.
  const template = {
    status: "TEMPLATE_NOT_DEPLOYED",
    chainId: 84532,
    deploymentId: null,
    deploymentBlock: null,
    contracts: { BlinkTestUSD: null, BlinkMarket: null },
    artifacts: {
      abiHashes: null,
      bytecodeHashes: null,
      compiler: "0.8.30",
      gitCommit: null,
      dependencies: null,
    },
    roles: {
      admin: null,
      resultProposer: null,
      challenger: null,
      arbiter: null,
      maker: null,
      faucetMinter: null,
    },
    parameters: {
      collateralDecimals: 6,
      quoteDefaultTtlSeconds: 30,
      quoteMaxTtlSeconds: 60,
      makerSpreadBps: 200,
      maxFillShares: "100",
      maxMarketPairs: "10000",
      maxTakerShares: "500",
    },
    tradingEnabled: false,
  };
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
    const archive = verifiedArchive(store);
    const bytes = new TextEncoder().encode(JSON.stringify(await newSpec()));
    const hash = keccak256(bytes);
    const { uri } = await store.putIfAbsent(bytes, hash);
    assert.deepEqual(
      Buffer.from(await archive.read(uri, hash)),
      Buffer.from(bytes),
    );
    assert.equal((await store.putIfAbsent(bytes, hash)).uri, uri);
    await assert.rejects(store.read("local-object:../../secrets"), /INVALID/);
    await assert.rejects(
      store.putIfAbsent(new Uint8Array([0]), hash),
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
      (
        await app.inject({
          method: "POST",
          url: "/v1/markets/1/forecasts?deploymentId=d",
          payload: {},
        })
      ).statusCode,
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
