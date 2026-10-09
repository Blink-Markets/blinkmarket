import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { TrackedCreation } from "../packages/ports/src/index.js";
import {
  DeploymentManifest,
  MarketSpecV011,
} from "../packages/schemas/src/index.js";
import { creationReceiptReader } from "../packages/adapters/src/creation-receipt-reader.js";
import { untrackedCreation } from "../packages/adapters/src/creation-tracker-store.js";
import { encodeMarketCreation } from "../packages/adapters/src/creation-calldata.js";
import { deploymentFixture } from "./helpers/deployment-fixture.js";
import { creationRpc, hashOf } from "./helpers/creation-rpc.js";

async function fixture() {
  const manifest = DeploymentManifest.parse(deploymentFixture().manifest);
  const legacy = JSON.parse(
    await readFile("fixtures/replay/market-spec.json", "utf8"),
  );
  const spec = MarketSpecV011.parse({
    ...legacy,
    schemaVersion: "blink.market.v0.1.1",
    resolutionPolicy: {
      hardDeadlineOutcome: "INVALID",
      unfinalizedProposalAtHardDeadline: "INVALID",
      invalidPayoutRule: "HALF_PER_SIDE_NOT_PURCHASE_REFUND",
      authorityModel: "TEAM_OPERATED_WHITELISTED_ROLES",
    },
  });
  const id = "00000000-0000-4000-8000-000000000001",
    hash = hashOf("spec"),
    uri = "https://blink.example/v1/specs/" + hash;
  const creation: TrackedCreation = {
    manifest,
    status: untrackedCreation(id),
    intent: {
      creationIntentId: id,
      approvalId: id,
      deploymentId: "test",
      state: "AWAITING_ADMIN_SIGNATURE",
      chainId: 84532,
      to: manifest.contracts.BlinkMarket,
      requiredSender: manifest.roles.admin,
      value: "0",
      specHash: hash,
      specUri: uri,
      calldata: encodeMarketCreation(spec, hash, uri),
    },
  };
  return { creation, ...creationRpc(creation.intent) };
}
test("creation receipt: exact event, confirmation threshold, reorg and same-tx re-inclusion", async () => {
  const s = await fixture(),
    reader = creationReceiptReader(s.client);
  const apply = async () => {
    const o = await reader.observe(s.creation, s.txHash);
    s.creation.status = {
      ...o,
      creationIntentId: s.creation.intent.creationIntentId,
      version: s.creation.status.version + 1,
      observedAt: new Date().toISOString(),
    };
    return o;
  };
  assert.equal((await apply()).state, "INCLUDED");
  assert.equal(s.creation.status.marketId, "9007199254740993");
  s.state.head = 20n;
  assert.equal((await apply()).state, "INCLUDED");
  s.state.head = 21n;
  assert.equal((await apply()).state, "CONFIRMED");
  s.state.head = 20n;
  await assert.rejects(apply(), /CREATION_HEAD_REGRESSED/);
  s.state.head = 21n;
  s.canonical.set(10n, hashOf("reorg"));
  s.state.receipt = null;
  s.state.tx = null;
  const orphan = await apply();
  assert.equal(orphan.state, "REORGED");
  assert.equal(orphan.marketId, null);
  Object.assign(s.state, s.mine(22n, 99n));
  s.state.head = 22n;
  assert.equal((await apply()).state, "INCLUDED");
  assert.equal(s.creation.status.marketId, "99");
  s.state.head = 33n;
  assert.equal((await apply()).state, "CONFIRMED");
});
test("creation receipt: RPC failures, wrong transaction/event/chain/code and changing anchors fail closed", async (t) => {
  for (const fault of [
    "chain",
    "sender",
    "target",
    "value",
    "calldata",
    "event",
    "duplicate",
    "removed",
    "code",
    "rpc",
    "head",
  ]) {
    const s = await fixture();
    if (fault === "chain") s.state.chainId = 1;
    if (fault === "sender") s.state.tx!.from = s.creation.manifest.roles.maker;
    if (fault === "target")
      s.state.tx!.to = s.creation.manifest.contracts.BlinkTestUSD;
    if (fault === "value") s.state.tx!.value = 1n;
    if (fault === "calldata") s.state.tx!.input = "0x1234";
    if (fault === "event") s.state.receipt!.logs[0]!.data = "0x";
    if (fault === "duplicate")
      s.state.receipt!.logs.push(s.state.receipt!.logs[0]!);
    if (fault === "removed") s.state.receipt!.logs[0]!.removed = true;
    if (fault === "code") s.state.code = "0x6001";
    if (fault === "rpc") s.state.fail = true;
    if (fault === "head") s.state.head = 9n;
    await assert.rejects(
      creationReceiptReader(s.client).observe(s.creation, s.txHash),
      Error,
      fault,
    );
  }
  const s = await fixture();
  let reads = 0;
  t.mock.method(s.client, "getBlock", async () => ({
    number: 10n,
    hash: ++reads < 3 ? hashOf("block-10") : hashOf("changed"),
  }));
  await assert.rejects(
    creationReceiptReader(s.client).observe(s.creation, s.txHash),
    /REORG_DURING_CREATION_CHECK/,
  );
});
test("creation receipt: missing receipt is unknown, not success or automatically reverted", async () => {
  const s = await fixture(),
    reader = creationReceiptReader(s.client);
  s.state.receipt = null;
  const unknown = await reader.observe(s.creation, s.txHash);
  assert.equal(unknown.state, "UNKNOWN");
  assert.equal(unknown.marketId, null);
  assert.equal(unknown.blockHash, null);
  s.creation.status = {
    ...unknown,
    creationIntentId: s.creation.intent.creationIntentId,
    version: 1,
    observedAt: new Date().toISOString(),
  };
  s.state.fail = true;
  await assert.rejects(reader.observe(s.creation, s.txHash), /RPC unavailable/);
  s.state.fail = false;
  Object.assign(s.state, s.mine(10n));
  s.state.receipt!.status = "reverted";
  const reverted = await reader.observe(s.creation, s.txHash);
  assert.equal(reverted.state, "REVERTED");
  assert.equal(reverted.marketId, null);
});

test("creation receipt: missing receipt cannot erase a verified canonical block", async () => {
  for (const state of ["INCLUDED", "CONFIRMED", "REVERTED"] as const) {
    const s = await fixture();
    if (state === "CONFIRMED") s.state.head = 21n;
    if (state === "REVERTED") s.state.receipt!.status = "reverted";
    const reader = creationReceiptReader(s.client);
    const verified = await reader.observe(s.creation, s.txHash);
    assert.equal(verified.state, state);
    s.creation.status = {
      ...verified,
      creationIntentId: s.creation.intent.creationIntentId,
      version: 1,
      observedAt: new Date().toISOString(),
    };
    s.state.receipt = null;

    await assert.rejects(
      reader.observe(s.creation, s.txHash),
      /CREATION_RECEIPT_INDETERMINATE/,
      `missing receipt after ${state} must preserve the verified projection`,
    );
  }
});

test("creation receipt: a missing receipt with positive orphan proof retracts the market ID", async () => {
  const s = await fixture();
  const reader = creationReceiptReader(s.client);
  const included = await reader.observe(s.creation, s.txHash);
  s.creation.status = {
    ...included,
    creationIntentId: s.creation.intent.creationIntentId,
    version: 1,
    observedAt: new Date().toISOString(),
  };
  s.canonical.set(10n, hashOf("orphaned block"));
  s.state.receipt = null;
  s.state.tx = null;

  const orphaned = await reader.observe(s.creation, s.txHash);
  assert.equal(orphaned.state, "REORGED");
  assert.equal(orphaned.marketId, null);
});
