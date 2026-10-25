import assert from "node:assert/strict";
import { test } from "node:test";
import {
  foldProtocolEvents,
  tradable,
  creditAt,
  type ProtocolEvent,
} from "../packages/domain/src/protocol-reducer.ts";
import { presets } from "../packages/schemas/src/index.ts";
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
      keeperTip: "900", // 5% of the 15% resolution share, from the default Params
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

// ---- Task 7: resolution, juror and fee projections ----
const at = (seconds: number, e: ProtocolEvent): ProtocolEvent => ({
  ...e,
  blockNumber: BigInt(seconds),
  blockTimestamp: BigInt(seconds),
});
const res = (name: string, args: ProtocolEvent["args"]) =>
  event(name, args, "RESOLUTION");
const jur = (name: string, args: ProtocolEvent["args"]) =>
  event(name, args, "JURORS");
const alpha = presets.alpha;
const proposed = (outcome: string, proposer = a(5)) => [
  res("Proposed", {
    id: "1",
    proposer,
    outcome,
    bond: "5000000",
    challengeEnd: "2160",
    evidenceHash: h(11),
    evidenceURI: "ipfs://evidence",
  }),
  event("MarketProposed", { marketId: "1" }),
];
const dispute = (id = "1", kind = "1") => [
  res("DisputeOpened", {
    disputeId: id,
    marketId: "1",
    challenger: a(6),
    kind,
    bond: "5000000",
    ground: "0",
    evidenceHash: h(12),
  }),
  event("MarketDisputed", { marketId: "1" }),
];
const base = () => [
  created(),
  event("MarketOpened", { marketId: "1", openAt: "1001" }),
];

test("dispute with appeal projection", () => {
  const p = foldProtocolEvents(
    [
      ...base(),
      ...proposed("0").map((e) => at(2100, e)),
      ...dispute().map((e) => at(2110, e)),
      at(2120, res("VoteCommitted", { disputeId: "1", round: "0", juror: a(7), weight: "100" })),
      at(2120, res("VoteCommitted", { disputeId: "1", round: "0", juror: a(8), weight: "50" })),
      at(2150, res("VoteRevealed", { disputeId: "1", round: "0", juror: a(7), choice: "1" })),
      // quorum not met: the round restarts at the same appeal level
      at(2175, res("RoundRestarted", { disputeId: "1", round: "1", appealRound: "0", snapshotAt: "2174" })),
      at(2180, res("VoteCommitted", { disputeId: "1", round: "1", juror: a(7), weight: "100" })),
      at(2180, res("VoteCommitted", { disputeId: "1", round: "1", juror: a(8), weight: "50" })),
      at(2210, res("VoteRevealed", { disputeId: "1", round: "1", juror: a(7), choice: "1" })),
      at(2210, res("VoteRevealed", { disputeId: "1", round: "1", juror: a(8), choice: "1" })),
      at(2240, res("RoundSettled", { disputeId: "1", round: "1", appealRound: "0", choice: "1", appealEnd: "2265" })),
      at(2250, res("Appealed", { disputeId: "1", round: "2", appealRound: "1", appellant: a(5), bond: "10000000" })),
      at(2255, res("VoteCommitted", { disputeId: "1", round: "2", juror: a(7), weight: "100" })),
      at(2285, res("VoteRevealed", { disputeId: "1", round: "2", juror: a(7), choice: "0" })),
      at(2320, res("RoundSettled", { disputeId: "1", round: "2", appealRound: "1", choice: "0", appealEnd: "2370" })),
      at(2380, res("DisputeFinalized", { disputeId: "1", choice: "0" })),
      at(2380, event("MarketFinalized", { marketId: "1", outcome: "0" })),
      at(2390, res("VoteSettled", { disputeId: "1", round: "0", juror: a(8), slash: "5", reward: "0" })),
      at(2390, res("VoteSettled", { disputeId: "1", round: "2", juror: a(7), slash: "0", reward: "7" })),
      // the final-round credit settlement repeats the event with zero amounts
      at(2391, res("VoteSettled", { disputeId: "1", round: "2", juror: a(7), slash: "0", reward: "0" })),
    ],
    alpha,
  );
  assert.deepEqual(p.proposals.get("1"), {
    marketId: "1",
    proposer: a(5),
    outcome: "YES",
    bondMicros: "5000000",
    challengeEnd: 2160,
    evidenceHash: h(11),
    evidenceUri: "ipfs://evidence",
    proposedAt: 2100,
  });
  const d = p.disputes.get("1")!;
  assert.deepEqual(d, {
    disputeId: "1",
    marketId: "1",
    kind: "RESULT",
    ground: 0,
    challenger: a(6),
    evidenceHash: h(12),
    currentRound: 2,
    appealRound: 1,
    settled: true,
    timedOut: false,
    finalChoice: 0,
  });
  assert.equal(p.rounds.size, 3);
  assert.deepEqual(p.rounds.get("1:0"), {
    disputeId: "1",
    round: 0,
    level: 0,
    snapshotAt: 2109,
    commitEnd: 2110 + alpha.commitSeconds,
    revealEnd: 2110 + alpha.commitSeconds + alpha.revealSeconds,
    appealEnd:
      2110 + alpha.commitSeconds + alpha.revealSeconds + alpha.appealSeconds,
    committedWeight: "150",
    revealedWeight: ["0", "100"],
    committers: 2,
    revealers: 1,
    leadingChoice: 0,
    restarted: true,
    settled: true,
    creditThreshold: 0,
  });
  const second = p.rounds.get("1:1")!;
  assert.equal(second.snapshotAt, 2174);
  assert.equal(second.level, 0);
  assert.deepEqual(second.revealedWeight, ["0", "150"]);
  assert.equal(second.leadingChoice, 1);
  assert.equal(second.restarted, false);
  assert.equal(second.settled, true);
  const third = p.rounds.get("1:2")!;
  assert.equal(third.level, 1);
  assert.equal(third.leadingChoice, 0);
  assert.deepEqual(third.revealedWeight, ["100", "0"]);
  assert.equal(third.appealEnd, 2370);
  // a vote's choice stays null until its reveal event
  assert.equal(p.votes.get(`1:0:${a(7)}`)?.choice, 1);
  assert.deepEqual(p.votes.get(`1:0:${a(8)}`), {
    disputeId: "1",
    round: 0,
    juror: a(8),
    weight: "50",
    revealed: false,
    choice: null,
    settled: true,
    slashed: "5",
    reward: "0",
  });
  assert.deepEqual(p.votes.get(`1:2:${a(7)}`), {
    disputeId: "1",
    round: 2,
    juror: a(7),
    weight: "100",
    revealed: true,
    choice: 0,
    settled: true,
    slashed: "0",
    reward: "7",
  });
  assert.equal(p.markets.get("1")?.finalOutcome, "YES");
});

test("a vote has no choice before its reveal and a timeout settles the dispute", () => {
  const events = [
    ...base(),
    ...proposed("0").map((e) => at(2100, e)),
    ...dispute().map((e) => at(2110, e)),
    at(2120, res("VoteCommitted", { disputeId: "1", round: "0", juror: a(7), weight: "100" })),
  ];
  const sealed = foldProtocolEvents(events, alpha);
  assert.equal(sealed.votes.get(`1:0:${a(7)}`)?.choice, null);
  assert.equal(sealed.votes.get(`1:0:${a(7)}`)?.revealed, false);
  const timedOut = foldProtocolEvents(
    [
      ...events,
      at(4000, res("TimeoutFinalized", { id: "1", returnedBond: "5000000", forfeitedBonds: "5000000" })),
      at(4000, event("MarketFinalized", { marketId: "1", outcome: "2" })),
    ],
    alpha,
  );
  const d = timedOut.disputes.get("1")!;
  assert.equal(d.settled, true);
  assert.equal(d.timedOut, true);
  assert.equal(d.finalChoice, null);
  assert.throws(() =>
    foldProtocolEvents([
      ...events,
      res("VoteCommitted", { disputeId: "1", round: "0", juror: a(7), weight: "1" }),
    ], alpha),
  );
});

test("round credit threshold follows the finalized-market phase-in", () => {
  const opened = foldProtocolEvents(
    [...base(), ...proposed("0"), ...dispute()],
    { ...alpha, phaseInFinalizedMarkets: 0, roundCreditThreshold: [3, 5, 10, 20] },
  );
  assert.equal(opened.rounds.get("1:0")?.creditThreshold, 3);
  const early = foldProtocolEvents(
    [...base(), ...proposed("0"), ...dispute()],
    { ...alpha, phaseInFinalizedMarkets: 1, roundCreditThreshold: [3, 5, 10, 20] },
  );
  assert.equal(early.rounds.get("1:0")?.creditThreshold, 0);
});

// Pool 1001 leaves dust: creator 250, resolution 150 (tip 7), jurors 150, bounty 150, treasury 301.
const feePool = (fee = "1001") =>
  event("QuoteFilled", {
    marketId: "1",
    digest: h(5),
    maker: a(2),
    taker: a(4),
    side: "0",
    quantity: "1",
    priceBps: "6000",
    takerCost: "600000",
    makerCost: "400000",
    fee,
  });
const distributed = (amount = "1001", keeperTip = "7") =>
  event("FeesDistributed", { marketId: "1", amount, keeper: a(9), keeperTip });
// middle is a thunk: events take their log index when built, and the base must come first.
const withFees = (middle: () => ProtocolEvent[], tip?: string, stake = true) => [
  ...base(),
  ...(stake ? [jur("Staked", { juror: a(7), amount: "1000" })] : []),
  event("MakerDeposited", { maker: a(2), amount: "10000000" }),
  feePool(),
  ...middle(),
  distributed("1001", tip),
];
const total = (f: Record<string, unknown>) =>
  ["treasury", "creator", "resolution", "keeperTip", "jurors", "bounty"]
    .map((k) => BigInt(f[k] as string))
    .reduce((x, y) => x + y, 0n);

test("fee breakdown recomputes FeesDistributed: proposal won", () => {
  const f = foldProtocolEvents(
    withFees(() => [
      ...proposed("0"),
      event("MarketFinalized", { marketId: "1", outcome: "0" }),
    ]),
    alpha,
  ).fees.get("1")!;
  assert.deepEqual(f, {
    marketId: "1",
    poolMicros: "1001",
    treasury: "301",
    creator: "250",
    resolution: "143",
    keeperTip: "7",
    keeper: a(9),
    jurors: "300", // the juror share plus the unclaimed bounty share
    bounty: "0",
    bountyWinner: null,
  });
  assert.equal(total(f), 1001n);
});

test("fee breakdown recomputes FeesDistributed: proposal lost sends the resolution share to jurors, bounty paid", () => {
  const f = foldProtocolEvents(
    withFees(() => [
      ...proposed("0"),
      ...dispute(),
      res("DisputeFinalized", { disputeId: "1", choice: "1" }),
      event("MarketFinalized", { marketId: "1", outcome: "1" }),
    ]),
    alpha,
  ).fees.get("1")!;
  assert.deepEqual(f, {
    marketId: "1",
    poolMicros: "1001",
    treasury: "301",
    creator: "250",
    resolution: "0",
    keeperTip: "7",
    keeper: a(9),
    jurors: String(150 + 143),
    bounty: "150",
    bountyWinner: a(6),
  });
  assert.equal(total(f), 1001n);
});

test("fee breakdown recomputes FeesDistributed: INVALID sends the creator share to jurors", () => {
  const f = foldProtocolEvents(
    withFees(() => [
      ...proposed("0"),
      ...dispute(),
      res("TimeoutFinalized", { id: "1", returnedBond: "0", forfeitedBonds: "0" }),
      event("MarketFinalized", { marketId: "1", outcome: "2" }),
    ]),
    alpha,
  ).fees.get("1")!;
  assert.equal(f.creator, "0");
  assert.equal(f.resolution, "0");
  assert.equal(f.bounty, "0");
  assert.equal(f.bountyWinner, null);
  assert.equal(f.jurors, String(150 + 250 + 143 + 150));
  assert.equal(total(f), 1001n);
});

test("fee breakdown: a failed challenge pays the proposer, not the bounty", () => {
  const f = foldProtocolEvents(
    withFees(() => [
      ...proposed("0"),
      ...dispute(),
      res("DisputeFinalized", { disputeId: "1", choice: "0" }),
      event("MarketFinalized", { marketId: "1", outcome: "0" }),
    ]),
    alpha,
  ).fees.get("1")!;
  assert.equal(f.resolution, "143");
  assert.equal(f.bounty, "0");
  assert.equal(f.bountyWinner, null);
  assert.equal(f.jurors, String(150 + 150));
  assert.equal(total(f), 1001n);
});

test("fee breakdown: with no juror stake the juror allocation is forwarded to the treasury", () => {
  const f = foldProtocolEvents(
    withFees(
      () => [...proposed("0"), event("MarketFinalized", { marketId: "1", outcome: "0" })],
      undefined,
      false,
    ),
    alpha,
  ).fees.get("1")!;
  // The same pool as the proposal-won case: the 300 for jurors moves to the treasury (301 + 300).
  assert.equal(f.jurors, "0");
  assert.equal(f.treasury, "601");
  assert.equal(f.resolution, "143");
  assert.equal(total(f), 1001n);
  // Stake that was unstaked before the distribution counts as none.
  const unstaked = foldProtocolEvents(
    [
      ...base(),
      jur("Staked", { juror: a(7), amount: "1000" }),
      jur("UnstakeRequested", { juror: a(7), amount: "1000", unlockAt: "2000" }),
      event("MakerDeposited", { maker: a(2), amount: "10000000" }),
      feePool(),
      ...proposed("0"),
      event("MarketFinalized", { marketId: "1", outcome: "0" }),
      distributed(),
    ],
    alpha,
  );
  assert.equal(unstaked.fees.get("1")?.jurors, "0");
});

test("fee breakdown refuses a keeper tip the parameters do not give", () => {
  assert.throws(
    () =>
      foldProtocolEvents(
        withFees(
          () => [
            ...proposed("0"),
            event("MarketFinalized", { marketId: "1", outcome: "0" }),
          ],
          "8",
        ),
        alpha,
      ),
    /keeper tip/,
  );
});

test("juror unstake and rewards", () => {
  const p = foldProtocolEvents([
    at(1000, jur("Staked", { juror: a(7), amount: "100" })),
    at(1000, jur("Staked", { juror: a(8), amount: "300" })),
    // 604800 over the 7 day stream is exactly 1e18 per second
    at(1100, jur("RewardNotified", { from: a(1), amount: "604800", rewardPerToken: "0" })),
    at(1200, jur("UnstakeRequested", { juror: a(7), amount: "40", unlockAt: "1500" })),
    at(1210, jur("VoteLocked", { juror: a(7), openVotes: "1" })),
    at(1200, jur("Slashed", { juror: a(7), requested: "70", slashed: "70", to: a(1) })),
  ]);
  assert.deepEqual(p.jurors.get(a(7)), {
    address: a(7),
    staked: "0",
    pendingUnstake: "30",
    unstakeReadyAt: 1500,
    openVotes: 1,
    rewardsOwed: "25",
    rewardPaid: "250000000000000000000000000000000000",
  });
  const settled = foldProtocolEvents([
    at(1000, jur("Staked", { juror: a(7), amount: "100" })),
    at(1000, jur("Staked", { juror: a(8), amount: "300" })),
    at(1100, jur("RewardNotified", { from: a(1), amount: "604800", rewardPerToken: "0" })),
    at(1200, jur("UnstakeRequested", { juror: a(7), amount: "40", unlockAt: "1500" })),
    at(1210, jur("VoteUnlocked", { juror: a(7), openVotes: "0" })),
    at(1500, jur("UnstakeWithdrawn", { juror: a(7), amount: "40" })),
    at(1300, jur("RewardsClaimed", { juror: a(8), amount: "158" })),
  ]);
  const a7 = settled.jurors.get(a(7))!;
  assert.equal(a7.staked, "60");
  assert.equal(a7.pendingUnstake, "0");
  assert.equal(a7.unstakeReadyAt, 0);
  assert.equal(a7.openVotes, 0);
  // 25 settled at the unstake request; a juror is credited only what the stream gave them
  assert.equal(a7.rewardsOwed, "25");
  assert.equal(settled.jurors.get(a(8))?.rewardsOwed, "0");
  assert.equal(settled.rewardPool.get("pool")?.totalStaked, "360");
  assert.throws(() =>
    foldProtocolEvents([
      at(1000, jur("Staked", { juror: a(7), amount: "10" })),
      at(1001, jur("UnstakeRequested", { juror: a(7), amount: "11", unlockAt: "1500" })),
    ]),
  );
});

// An independent model of BlinkJurors' reward stream for one staker, including the silent settles
// (a zero-value claimRewards emits no event) that an event-derived fold cannot see.
function contractRewards(silentAt: number[]) {
  const E18 = 10n ** 18n,
    stake = 100n * E18,
    rate = (302_400n * E18) / 604_800n; // notified at t=1000
  let paid = 0n,
    rewards = 0n,
    last = 1000;
  const settle = (t: number) => {
    const rpt = (BigInt(t - 1000) * rate * E18) / stake;
    rewards += (stake * (rpt - paid)) / (E18 * E18);
    paid = rpt;
    last = t;
  };
  for (const t of silentAt) settle(t);
  return { settle, rewards: () => rewards, last: () => last };
}

test("juror rewards: silent zero-value claims leave under one micro each, and the next claim resyncs exactly", () => {
  const stakeEvent = jur("Staked", { juror: a(7), amount: (100n * 10n ** 18n).toString() });
  const notify = jur("RewardNotified", { from: a(9), amount: "302400", rewardPerToken: "0" });
  const silent = [1001, 1002]; // claimRewards with nothing owed: settles, emits nothing
  const model = contractRewards(silent);
  // A later evented settle (a one-wei top-up of the stake) at 1003.
  const top = at(1003, jur("Staked", { juror: a(7), amount: "1" }));
  const folded = foldProtocolEvents([at(1000, stakeEvent), at(1000, notify), top], alpha);
  model.settle(1003);
  const gap = BigInt(folded.jurors.get(a(7))!.rewardsOwed) - model.rewards();
  assert.equal(model.rewards(), 0n);
  assert.ok(gap > 0n && gap < BigInt(silent.length), "fold is ahead of the contract by less than 1 micro per silent call");
  // The stream ends at 1000 + 604800; the claim pays the contract value and the fold resets to 0.
  const end = 1000 + 604_800;
  const claimModel = contractRewards(silent);
  claimModel.settle(1003);
  claimModel.settle(end);
  const paidAmount = claimModel.rewards();
  assert.ok(paidAmount > 0n);
  const claimed = foldProtocolEvents(
    [
      at(1000, stakeEvent),
      at(1000, notify),
      top,
      at(end, jur("RewardsClaimed", { juror: a(7), amount: paidAmount.toString() })),
    ],
    alpha,
  );
  assert.equal(claimed.jurors.get(a(7))?.rewardsOwed, "0");
});
