import assert from "node:assert/strict";
import { test } from "node:test";
import {
  foldProtocolEvents,
  tradable,
  creditAt,
  type ProtocolEvent,
} from "../packages/domain/src/protocol-reducer.ts";
const a = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const h = (n: number) => "0x" + n.toString(16).padStart(64, "0");
let index = 0;
export const event = (
  name: string,
  args: ProtocolEvent["args"],
  contract: ProtocolEvent["contract"] = "MARKETS",
): ProtocolEvent => ({
  contract,
  emitter: a(99),
  name,
  args,
  blockNumber: 1n,
  blockHash: h(1),
  blockTimestamp: 1000n,
  txHash: h(2),
  txIndex: 0,
  logIndex: index++,
});
export const created = () =>
  event("MarketCreated", {
    marketId: "1",
    creator: a(1),
    specHash: h(3),
    specURI: "ipfs://spec",
    templateId: h(4),
    cls: "0",
    replay: true,
    openAt: "1000",
    closeAt: "2000",
    proposalDeadline: "3000",
    hardDeadline: "4000",
    maxPairs: "100",
    creationBond: "1000000",
  });
export const fill = (maker = a(2), digest = h(5)) =>
  event("QuoteFilled", {
    marketId: "1",
    digest,
    maker,
    taker: a(4),
    side: "0",
    quantity: "10",
    priceBps: "6000",
    takerCost: "6000000",
    makerCost: "4000000",
    fee: "60000",
  });
test("normal lifecycle projection", () => {
  const p = foldProtocolEvents([
    event("Registered", { account: a(1), feePaid: "1" }, "REGISTRY"),
    event(
      "RoleJoined",
      { account: a(1), role: "0", amount: "100000000" },
      "REGISTRY",
    ),
    event("TemplateRegistered", {
      templateId: h(4),
      cls: "0",
      parserHash: h(6),
      uri: "ipfs://template",
    }),
    created(),
    event("MarketOpened", { marketId: "1", openAt: "1001" }),
    event("MakerDeposited", { maker: a(2), amount: "10000000" }),
    event("MakerDeposited", { maker: a(3), amount: "10000000" }),
    fill(),
    fill(a(3), h(7)),
    event("MarketProposed", { marketId: "1" }),
    event("MarketFinalized", { marketId: "1", outcome: "0" }),
    event("FeesDistributed", {
      marketId: "1",
      amount: "120000",
      keeper: a(5),
      keeperTip: "0",
    }),
    event("PositionRedeemed", {
      marketId: "1",
      account: a(4),
      yes: "20",
      no: "0",
      payout: "20000000",
    }),
    event("PositionRedeemed", {
      marketId: "1",
      account: a(2),
      yes: "0",
      no: "10",
      payout: "0",
    }),
    event("PositionRedeemed", {
      marketId: "1",
      account: a(3),
      yes: "0",
      no: "10",
      payout: "0",
    }),
  ]);
  assert.equal(p.markets.get("1")?.state, "FINAL");
  assert.equal(p.markets.get("1")?.escrowMicros, "0");
  assert.equal(p.markets.get("1")?.feePoolMicros, "0");
  assert.equal(p.makers.get(a(2))?.freeMicros, "6000000");
  assert.equal(p.makers.get(a(3))?.freeMicros, "6000000");
  assert.equal(p.positions.get("1:" + a(4))?.yesShares, "0");
  assert.equal(p.positions.get("1:" + a(4))?.redeemedPayoutMicros, "20000000");
});
test("status of PENDING and CANCELLED markets is not tradable", () => {
  const m = foldProtocolEvents([created()]).markets.get("1")!;
  for (const state of [
    "PENDING",
    "CANCELLED",
    "PROPOSED",
    "DISPUTED",
    "FINAL",
  ] as const)
    assert.equal(tradable({ ...m, state }, 1001), false);
  assert.equal(tradable({ ...m, state: "OPEN" }, 1999), true);
  assert.equal(tradable({ ...m, state: "OPEN" }, 2000), false);
});
test("digest consumed and cancelled", () => {
  const p = foldProtocolEvents([
    created(),
    event("MarketOpened", { marketId: "1", openAt: "1001" }),
    event("MakerDeposited", { maker: a(2), amount: "10000000" }),
    fill(),
    event("QuoteCancelled", { digest: h(9) }),
  ]);
  assert.equal(p.digests.get(h(5)), "CONSUMED");
  assert.equal(p.digests.get(h(9)), "CANCELLED");
});
test("maker epoch is per maker", () => {
  const p = foldProtocolEvents([
    event("MakerEpochIncremented", { maker: a(2), epoch: "1" }),
    event("MakerEpochIncremented", { maker: a(3), epoch: "1" }),
    event("MakerEpochIncremented", { maker: a(2), epoch: "2" }),
  ]);
  assert.equal(p.makers.get(a(2))?.epoch, "2");
  assert.equal(p.makers.get(a(3))?.epoch, "1");
});
test("credit decay vectors", () => {
  // Values are verified by RegistryTest.test_indexerCreditDecayVectors via real creditOf calls (Foundry).
  for (const [elapsed, expected] of [
    [0, 100],
    [100, 50],
    [250, 25],
    [4000, 0],
  ])
    assert.equal(
      creditAt({ value: 100, updatedAt: 1000 }, 1000 + elapsed!, 100),
      expected,
    );
});
test("credit updates retain partial half-life periods", () => {
  const gain = (at: bigint, credit: string) => ({
    ...event(
      "CreditGained",
      { account: a(1), role: "0", amount: "1", credit },
      "REGISTRY",
    ),
    blockNumber: at,
    blockTimestamp: at,
  });
  const p = foldProtocolEvents([gain(1000n, "100"), gain(1250n, "26")], 100);
  assert.deepEqual(p.accounts.get(a(1))?.credit.CREATOR, {
    value: 26,
    updatedAt: 1200,
  });
  assert.equal(creditAt(p.accounts.get(a(1))?.credit.CREATOR, 1300, 100), 13);
});
test("every generation ABI event is folded or explicitly retained in the journal", async () => {
  const { protocolAbi } =
    await import("../packages/adapters/src/protocol-abi.ts");
  const { applyProtocolEvent, emptyProtocolProjection, ChainProjectionError } =
    await import("../packages/domain/src/protocol-reducer.ts");
  for (const contract of [
    "registry",
    "jurors",
    "markets",
    "resolution",
    "faucet",
    "anchor",
    "governor",
  ] as const)
    for (const item of protocolAbi[contract]) {
      if (item.type !== "event") continue;
      const e = event(
        item.name,
        { role: "0", account: a(1) },
        contract.toUpperCase() as ProtocolEvent["contract"],
      );
      try {
        applyProtocolEvent(emptyProtocolProjection(), e);
      } catch (error) {
        assert.ok(error instanceof ChainProjectionError);
        assert.equal(
          /unknown.*event|unhandled event/.test(error.message),
          false,
          `${contract}.${item.name}`,
        );
      }
    }
});
test("rejected single-event folds never mutate their input", async () => {
  const { applyProtocolEvent } =
    await import("../packages/domain/src/protocol-reducer.ts");
  const p = foldProtocolEvents([created()]),
    before = structuredClone(p);
  assert.throws(() => applyProtocolEvent(p, fill()));
  assert.deepEqual(p, before);
});
test("zero-decayed credit gains preserve the materialised partial period", () => {
  const first = {
    ...event(
      "CreditGained",
      { account: a(1), role: "0", amount: "1", credit: "1" },
      "REGISTRY",
    ),
    blockNumber: 1000n,
    blockTimestamp: 1000n,
  };
  const next = {
    ...event(
      "CreditGained",
      { account: a(1), role: "0", amount: "1", credit: "1" },
      "REGISTRY",
    ),
    blockNumber: 1150n,
    blockTimestamp: 1150n,
  };
  const p = foldProtocolEvents([first, next], 100);
  assert.deepEqual(p.accounts.get(a(1))?.credit.CREATOR, {
    value: 1,
    updatedAt: 1100,
  });
  assert.equal(creditAt(p.accounts.get(a(1))?.credit.CREATOR, 1200, 100), 0);
});
test("registry stake, obligations, exits and imported credit follow their events", () => {
  const r = (name: string, args: ProtocolEvent["args"]) =>
    event(name, { account: a(1), role: "2", ...args }, "REGISTRY");
  const first = [
    r("Registered", { feePaid: "1" }),
    r("RoleJoined", { amount: "100" }),
    r("RoleStakeAdded", { amount: "5" }),
    r("RoleSlashed", { amount: "10" }),
    r("RoleLocked", { openObligations: "1" }),
    r("CreditGained", { amount: "20", credit: "20" }),
    r("CreditLost", { amount: "6", credit: "14" }),
    r("CreditImported", { amount: "3", credit: "17" }),
  ];
  const active = foldProtocolEvents(first).accounts.get(a(1))!;
  assert.equal(active.roles.TAKER.stakeMicros, "95");
  assert.equal(active.roles.TAKER.openObligations, 1);
  assert.deepEqual(active.credit.TAKER, { value: 17, updatedAt: 1000 });
  const exiting = foldProtocolEvents([
    ...first,
    r("RoleExitRequested", { withdrawableAt: "1060" }),
  ]).accounts.get(a(1))!;
  assert.equal(exiting.roles.TAKER.active, false);
  assert.equal(exiting.roles.TAKER.exitRequestedAt, 1000);
  const withdrawn = foldProtocolEvents([
    ...first,
    r("RoleExitRequested", { withdrawableAt: "1060" }),
    r("RoleUnlocked", { openObligations: "0" }),
    r("RoleWithdrawn", { amount: "95" }),
  ]).accounts.get(a(1))!;
  assert.deepEqual(withdrawn.roles.TAKER, {
    stakeMicros: "0",
    active: false,
    exitRequestedAt: null,
    openObligations: 0,
  });
});
