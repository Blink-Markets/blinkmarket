import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  governorDefaults,
  parseProtocolDeployment,
  presets,
  TEST_TOKEN_PRICE_MICROS,
} from "../packages/schemas/src/index.ts";

const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const names = [
  "BlinkFaucet",
  "BlinkRegistry",
  "BlinkJurors",
  "BlinkMarkets",
  "BlinkResolution",
];
const v2 = () => ({
  schema: "blink.deployment/2",
  deploymentId: "alpha-3",
  chainId: 84532,
  deployer: address(1),
  treasury: address(2),
  shared: {
    faucet: address(10),
    busd: address(11),
    token: address(12),
    priceSource: address(13),
    governor: address(14),
    anchor: address(15),
  },
  generation: {
    index: 0,
    registry: address(20),
    jurors: address(21),
    markets: address(22),
    resolution: address(23),
    previousRegistry: null,
  },
  params: presets.alpha,
  governor: governorDefaults,
  tokenPriceMicros: TEST_TOKEN_PRICE_MICROS,
  contracts: Object.fromEntries(
    names.map((name, i) => [
      name,
      {
        address: address(10 + i),
        abiHash: hash(100 + i),
        runtimeHash: hash(200 + i),
        deployTx: hash(300 + i),
        block: 1000 + i,
      },
    ]),
  ),
  startBlock: 1000,
  releaseCommit: "a".repeat(40),
});

test("a v2 fixture parses", () => {
  const result = parseProtocolDeployment(v2());
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.equal(result.manifest.generation.previousRegistry, null);
  assert.equal(result.manifest.params.replayAllowed, true);
});

test("the alpha-2 manifest is a historical v1 manifest", () => {
  const v1 = JSON.parse(
    readFileSync("deployments/base-sepolia/alpha-2.manifest.json", "utf8"),
  );
  assert.deepEqual(parseProtocolDeployment(v1), {
    ok: false,
    reason: "HISTORICAL_V1_MANIFEST",
  });
});

test("duplicate addresses across slots fail", () => {
  const sharedClash = v2();
  sharedClash.shared.anchor = sharedClash.shared.faucet;
  assert.equal(parseProtocolDeployment(sharedClash).ok, false);

  const crossClash = v2();
  crossClash.generation.registry = crossClash.shared.token;
  assert.equal(parseProtocolDeployment(crossClash).ok, false);

  const caseClash = v2();
  caseClash.generation.jurors = caseClash.generation.markets
    .toUpperCase()
    .replace("0X", "0x");
  assert.equal(parseProtocolDeployment(caseClash).ok, false);

  const previousClash = v2();
  previousClash.generation.previousRegistry = previousClash.generation
    .registry as never;
  assert.equal(parseProtocolDeployment(previousClash).ok, false);
});

test("wrong chain, unknown fields and zero addresses fail", () => {
  assert.equal(parseProtocolDeployment({ ...v2(), chainId: 1 }).ok, false);
  assert.equal(parseProtocolDeployment({ ...v2(), extra: true }).ok, false);
  const zero = v2();
  zero.shared.busd = address(0);
  assert.equal(parseProtocolDeployment(zero).ok, false);
  const result = parseProtocolDeployment({ nope: 1 });
  assert.equal(result.ok, false);
});
