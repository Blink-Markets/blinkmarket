import { test } from "node:test";
import assert from "node:assert/strict";
import { blinkEventNames } from "../packages/adapters/src/blink-abi.js";
import {
  applyEvent,
  chainEventNames,
  ChainProjectionError,
  emptyProjection,
  foldEvents,
  projectionChanges,
  type DecodedEvent,
} from "../packages/domain/src/chain-reducer.ts";

const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const MAKER = address(0xa1);
const TAKER = address(0xb1);
const TAKER2 = address(0xb2);
const UNIT = 1_000_000n;

let sequence = 0;
// Each helper call lands in its own block unless a position is given.
function event(
  name: DecodedEvent["name"],
  args: DecodedEvent["args"],
  position: Partial<
    Pick<
      DecodedEvent,
      "blockNumber" | "txIndex" | "logIndex" | "blockTimestamp"
    >
  > = {},
): DecodedEvent {
  const blockNumber = position.blockNumber ?? BigInt(10 + sequence++);
  return {
    name,
    args,
    blockNumber,
    blockHash: hash(Number(blockNumber) + 1000),
    blockTimestamp: position.blockTimestamp ?? 1_000n + blockNumber * 2n,
    txHash: hash(Number(blockNumber) + 5000),
    txIndex: position.txIndex ?? 0,
    logIndex: position.logIndex ?? 0,
  };
}

const created = (marketId = 1, position = {}) =>
  event(
    "MarketCreated",
    {
      marketId: String(marketId),
      specHash: hash(0x700 + marketId),
      specURI: "fixture://REPLAY/" + marketId,
      mode: "1",
      closeAt: "5000",
      proposalDeadline: "6000",
      hardDeadline: "7000",
      challengeSeconds: "120",
      maxPairs: "10000",
      maxTakerShares: "500",
    },
    position,
  );
const deposited = (amount: bigint) =>
  event("MakerDeposited", { amountMicros: String(amount) });
const fill = (
  options: {
    marketId?: number;
    digest?: number;
    taker?: string;
    side?: 0 | 1;
    quantity?: bigint;
    priceBps?: number;
    takerCost?: bigint;
    makerCost?: bigint;
  } = {},
) => {
  const quantity = options.quantity ?? 10n;
  const priceBps = options.priceBps ?? 6000;
  const takerCost = options.takerCost ?? quantity * BigInt(priceBps) * 100n;
  return event("QuoteFilled", {
    marketId: String(options.marketId ?? 1),
    digest: hash(0x900 + (options.digest ?? 1)),
    maker: MAKER,
    taker: options.taker ?? TAKER,
    side: String(options.side ?? 0),
    quantity: String(quantity),
    priceBps: String(priceBps),
    takerCost: String(takerCost),
    makerCost: String(options.makerCost ?? quantity * UNIT - takerCost),
  });
};
const proposed = (outcome: 0 | 1 | 2, marketId = 1, timestamp = 5200n) =>
  event(
    "OutcomeProposed",
    {
      marketId: String(marketId),
      outcome: String(outcome),
      evidenceHash: hash(0xe1),
    },
    { blockTimestamp: timestamp },
  );
const finalized = (outcome: 0 | 1 | 2, reason: 0 | 1 | 2 = 0, marketId = 1) =>
  event("OutcomeFinalized", {
    marketId: String(marketId),
    outcome: String(outcome),
    reason: String(reason),
    evidenceHash: hash(0xe1),
  });
const redeemed = (
  account: string,
  yes: bigint,
  no: bigint,
  payout: bigint,
  marketId = 1,
) =>
  event("PositionRedeemed", {
    marketId: String(marketId),
    account,
    yesShares: String(yes),
    noShares: String(no),
    payoutMicros: String(payout),
  });

function fold(...events: DecodedEvent[]) {
  const state = emptyProjection();
  for (const e of events) applyEvent(state, e);
  return state;
}
const inconsistent = /INCONSISTENT_EVENT/;

test("the reducer's event names are the names the ABI module and migration 0007 accept", () => {
  assert.deepEqual([...chainEventNames], [...blinkEventNames]);
});

test("MarketCreated adds an OPEN market with the logged parameters and creation anchor", () => {
  const log = created(1);
  const m = fold(log).markets.get("1")!;
  assert.deepEqual(m, {
    marketId: "1",
    specHash: hash(0x701),
    specUri: "fixture://REPLAY/1",
    mode: "REPLAY",
    closeAt: 5000n,
    proposalDeadline: 6000n,
    hardDeadline: 7000n,
    challengeSeconds: 120,
    maxPairs: 10000n,
    maxTakerShares: 500n,
    state: "OPEN",
    paused: false,
    proposedOutcome: null,
    proposedAt: null,
    proposalEvidenceHash: null,
    challengeEvidenceHash: null,
    finalOutcome: null,
    finalReason: null,
    finalEvidenceHash: null,
    totalPairs: 0n,
    escrowMicros: 0n,
    createdBlockNumber: log.blockNumber,
    createdTxHash: log.txHash,
  });
  assert.throws(() => fold(created(1), created(1)), inconsistent);
});

test("pause events set the global flag or one market's flag, and taker allow-listing is recorded per lowercase account", () => {
  const state = fold(
    created(1),
    event("TradingPauseChanged", {
      marketId: "0",
      globalPause: true,
      paused: true,
    }),
    event("TradingPauseChanged", {
      marketId: "1",
      globalPause: false,
      paused: true,
    }),
    event("TakerAllowedChanged", {
      account: TAKER.toUpperCase().replace("0X", "0x"),
      allowed: true,
    }),
  );
  assert.equal(state.maker.globalPaused, true);
  assert.equal(state.markets.get("1")!.paused, true);
  assert.equal(state.takers.get(TAKER), true);
  applyEvent(
    state,
    event("TradingPauseChanged", {
      marketId: "0",
      globalPause: true,
      paused: false,
    }),
  );
  assert.equal(state.maker.globalPaused, false);
  assert.equal(
    state.markets.get("1")!.paused,
    true,
    "a global change leaves the market flag alone",
  );
  assert.throws(
    () =>
      fold(
        event("TradingPauseChanged", {
          marketId: "9",
          globalPause: false,
          paused: true,
        }),
      ),
    inconsistent,
  );
});

test("maker deposits and withdrawals move the free balance and a withdrawal below zero is inconsistent", () => {
  const state = fold(deposited(5_000_000n));
  applyEvent(state, event("MakerWithdrawn", { amountMicros: "2000000" }));
  assert.equal(state.maker.freeMicros, 3_000_000n);
  assert.throws(
    () =>
      applyEvent(state, event("MakerWithdrawn", { amountMicros: "3000001" })),
    (error) =>
      error instanceof ChainProjectionError &&
      error.code === "INCONSISTENT_EVENT",
  );
  assert.equal(
    state.maker.freeMicros,
    3_000_000n,
    "a rejected event changes nothing",
  );
});

test("a YES fill and a NO fill give the taker and the maker opposite positions", () => {
  const state = fold(
    created(1),
    deposited(100_000_000n),
    fill({ digest: 1, side: 0, quantity: 10n, priceBps: 6000 }),
    fill({ digest: 2, side: 1, quantity: 4n, priceBps: 3000, taker: TAKER2 }),
  );
  const position = (account: string) => state.positions.get("1:" + account)!;
  assert.deepEqual(position(TAKER), {
    marketId: "1",
    account: TAKER,
    yesShares: 10n,
    noShares: 0n,
    takerBoughtShares: 10n,
    redeemedPayoutMicros: 0n,
  });
  assert.deepEqual(position(TAKER2), {
    marketId: "1",
    account: TAKER2,
    yesShares: 0n,
    noShares: 4n,
    takerBoughtShares: 4n,
    redeemedPayoutMicros: 0n,
  });
  assert.deepEqual(position(MAKER), {
    marketId: "1",
    account: MAKER,
    yesShares: 4n,
    noShares: 10n,
    takerBoughtShares: 0n,
    redeemedPayoutMicros: 0n,
  });
  const market = state.markets.get("1")!;
  assert.equal(market.totalPairs, 14n);
  assert.equal(market.escrowMicros, 14n * UNIT);
  // Makers pay (1 - price) per share: 10 * 400000 + 4 * 700000.
  assert.equal(state.maker.freeMicros, 100_000_000n - 4_000_000n - 2_800_000n);
  const digest = state.digests.get(hash(0x901))!;
  assert.equal(digest.state, "FILLED");
  assert.equal(digest.taker, TAKER);
  assert.equal(digest.side, "YES");
  assert.equal(digest.quantity, 10n);
  assert.equal(digest.priceBps, 6000);
  assert.equal(digest.takerCostMicros, 6_000_000n);
  assert.equal(digest.makerCostMicros, 4_000_000n);
  assert.equal(state.digests.get(hash(0x902))!.side, "NO");
});

test("fill arithmetic is asserted and a rejected fill leaves the projection untouched", () => {
  const base = () => fold(created(1), deposited(100_000_000n));
  // takerCost must be quantity * priceBps * 100.
  assert.throws(
    () =>
      applyEvent(
        base(),
        fill({ takerCost: 5_999_999n, makerCost: 4_000_001n }),
      ),
    inconsistent,
  );
  // takerCost + makerCost must be quantity * 1e6.
  assert.throws(
    () => applyEvent(base(), fill({ makerCost: 3_999_999n })),
    inconsistent,
  );
  // The market must exist and be OPEN, and the maker must be able to pay.
  assert.throws(() => applyEvent(base(), fill({ marketId: 2 })), inconsistent);
  const poor = fold(created(1), deposited(1_000_000n));
  const before = structuredClone(poor);
  assert.throws(() => applyEvent(poor, fill()), inconsistent);
  assert.deepEqual(poor, before);
  const proposedMarket = fold(created(1), deposited(100_000_000n), proposed(0));
  assert.throws(() => applyEvent(proposedMarket, fill()), inconsistent);
  // A digest can be filled only once.
  const once = fold(created(1), deposited(100_000_000n), fill());
  assert.throws(() => applyEvent(once, fill()), inconsistent);
});

test("QuoteCancelled marks the digest CANCELLED and a cancel after a fill is inconsistent", () => {
  const cancelled = fold(event("QuoteCancelled", { digest: hash(0x950) }));
  assert.equal(cancelled.digests.get(hash(0x950))!.state, "CANCELLED");
  assert.equal(cancelled.digests.get(hash(0x950))!.taker, null);
  const state = fold(created(1), deposited(100_000_000n), fill({ digest: 1 }));
  assert.throws(
    () => applyEvent(state, event("QuoteCancelled", { digest: hash(0x901) })),
    inconsistent,
  );
  assert.equal(state.digests.get(hash(0x901))!.state, "FILLED");
});

test("the maker epoch must advance by exactly one", () => {
  const state = fold(event("MakerEpochIncremented", { epoch: "1" }));
  applyEvent(state, event("MakerEpochIncremented", { epoch: "2" }));
  assert.equal(state.maker.epoch, 2n);
  assert.throws(
    () => applyEvent(state, event("MakerEpochIncremented", { epoch: "4" })),
    inconsistent,
  );
});

test("the outcome lifecycle records proposal time from the block, dispute and finalization", () => {
  const state = fold(created(1), proposed(1, 1, 5200n));
  let m = state.markets.get("1")!;
  assert.equal(m.state, "PROPOSED");
  assert.equal(m.proposedOutcome, "NO");
  assert.equal(m.proposedAt, 5200n);
  assert.equal(m.proposalEvidenceHash, hash(0xe1));
  applyEvent(
    state,
    event("OutcomeChallenged", { marketId: "1", evidenceHash: hash(0xe2) }),
  );
  m = state.markets.get("1")!;
  assert.equal(m.state, "DISPUTED");
  assert.equal(m.challengeEvidenceHash, hash(0xe2));
  applyEvent(state, finalized(0, 1));
  m = state.markets.get("1")!;
  assert.equal(m.state, "FINAL");
  assert.equal(m.finalOutcome, "YES");
  assert.equal(m.finalReason, "ARBITRATED");
  assert.equal(m.finalEvidenceHash, hash(0xe1));
  assert.throws(() => applyEvent(state, proposed(0)), inconsistent);
  assert.throws(() => applyEvent(state, finalized(0, 1)), inconsistent);
  // Challenge and unchallenged finalization need the matching prior state.
  const open = fold(created(1));
  assert.throws(
    () =>
      applyEvent(
        open,
        event("OutcomeChallenged", { marketId: "1", evidenceHash: hash(1) }),
      ),
    inconsistent,
  );
  assert.throws(() => applyEvent(open, finalized(0, 0)), inconsistent);
  applyEvent(open, finalized(2, 2));
  assert.equal(open.markets.get("1")!.finalReason, "TIMEOUT");
});

function settled(outcome: 0 | 1 | 2) {
  return fold(
    created(1),
    deposited(100_000_000n),
    fill({ digest: 1, side: 0, quantity: 10n, priceBps: 6000 }),
    fill({ digest: 2, side: 1, quantity: 4n, priceBps: 3000, taker: TAKER2 }),
    proposed(outcome),
    finalized(outcome),
  );
}

test("redemption pays the outcome rule, empties the position and releases escrow", () => {
  // YES: yes shares pay 1e6. TAKER holds 10 YES, MAKER holds 4 YES / 10 NO, TAKER2 holds 4 NO.
  const yes = settled(0);
  assert.equal(yes.markets.get("1")!.escrowMicros, 14n * UNIT);
  applyEvent(yes, redeemed(TAKER, 10n, 0n, 10n * UNIT));
  const taker = yes.positions.get("1:" + TAKER)!;
  assert.equal(taker.yesShares, 0n);
  assert.equal(taker.noShares, 0n);
  assert.equal(taker.redeemedPayoutMicros, 10n * UNIT);
  assert.equal(yes.markets.get("1")!.escrowMicros, 4n * UNIT);
  applyEvent(yes, redeemed(MAKER, 4n, 10n, 4n * UNIT));
  applyEvent(yes, redeemed(TAKER2, 0n, 4n, 0n));
  assert.equal(yes.markets.get("1")!.escrowMicros, 0n);

  const no = settled(1);
  applyEvent(no, redeemed(MAKER, 4n, 10n, 10n * UNIT));
  applyEvent(no, redeemed(TAKER2, 0n, 4n, 4n * UNIT));
  applyEvent(no, redeemed(TAKER, 10n, 0n, 0n));
  assert.equal(no.markets.get("1")!.escrowMicros, 0n);

  const invalid = settled(2);
  applyEvent(invalid, redeemed(MAKER, 4n, 10n, 14n * 500_000n));
  applyEvent(invalid, redeemed(TAKER, 10n, 0n, 10n * 500_000n));
  applyEvent(invalid, redeemed(TAKER2, 0n, 4n, 4n * 500_000n));
  assert.equal(invalid.markets.get("1")!.escrowMicros, 0n);
});

test("a redemption that disagrees with the outcome rule, the position or the market state is inconsistent", () => {
  const wrongPayout = settled(0);
  assert.throws(
    () => applyEvent(wrongPayout, redeemed(TAKER, 10n, 0n, 10n * UNIT + 1n)),
    inconsistent,
  );
  assert.throws(
    () => applyEvent(wrongPayout, redeemed(TAKER, 9n, 0n, 9n * UNIT)),
    inconsistent,
    "the event's shares must equal the projected position",
  );
  assert.throws(
    () => applyEvent(wrongPayout, redeemed(address(0xdead), 1n, 0n, UNIT)),
    inconsistent,
    "no projected position",
  );
  const open = fold(created(1), deposited(100_000_000n), fill());
  assert.throws(
    () => applyEvent(open, redeemed(TAKER, 10n, 0n, 10n * UNIT)),
    inconsistent,
  );
  const once = settled(0);
  applyEvent(once, redeemed(TAKER, 10n, 0n, 10n * UNIT));
  assert.throws(
    () => applyEvent(once, redeemed(TAKER, 10n, 0n, 10n * UNIT)),
    inconsistent,
  );
});

test("foldEvents orders by block, transaction and log position whatever the input order", () => {
  const events = [
    created(1, { blockNumber: 10n }),
    event("MakerDeposited", { amountMicros: "50000000" }, { blockNumber: 11n }),
    event(
      "QuoteFilled",
      {
        marketId: "1",
        digest: hash(0x901),
        maker: MAKER,
        taker: TAKER,
        side: "0",
        quantity: "10",
        priceBps: "6000",
        takerCost: "6000000",
        makerCost: "4000000",
      },
      { blockNumber: 12n, txIndex: 1, logIndex: 3 },
    ),
    event(
      "MakerWithdrawn",
      { amountMicros: "46000000" },
      { blockNumber: 12n, txIndex: 2, logIndex: 0 },
    ),
    event(
      "MakerDeposited",
      { amountMicros: "1000000" },
      { blockNumber: 12n, txIndex: 1, logIndex: 4 },
    ),
  ];
  const expected = foldEvents(events);
  assert.equal(
    expected.maker.freeMicros,
    50_000_000n - 4_000_000n + 1_000_000n - 46_000_000n,
  );
  for (const order of [
    [...events].reverse(),
    [events[3]!, events[0]!, events[4]!, events[2]!, events[1]!],
  ])
    assert.deepEqual(foldEvents(order), expected);
  assert.deepEqual(
    events.map((e) => e.logIndex),
    [0, 0, 3, 0, 4],
    "the input is not reordered in place",
  );
  assert.deepEqual(foldEvents([]), emptyProjection());
});

test("malformed event arguments are inconsistent rather than silently coerced", () => {
  assert.throws(
    () => fold(event("MakerDeposited", { amountMicros: "12.5" })),
    inconsistent,
  );
  assert.throws(() => fold(event("MakerDeposited", {})), inconsistent);
  assert.throws(
    () =>
      fold(event("TakerAllowedChanged", { account: TAKER, allowed: "true" })),
    inconsistent,
  );
});

test("projectionChanges names the added, changed and removed entries", () => {
  const before = fold(created(1), deposited(100_000_000n), fill({ digest: 1 }));
  const after = structuredClone(before);
  assert.deepEqual(projectionChanges(before, after), {
    maker: false,
    markets: [],
    positions: [],
    digests: [],
    takers: [],
    removed: [],
  });
  applyEvent(after, created(2));
  applyEvent(after, fill({ digest: 2, taker: TAKER2, side: 1, quantity: 2n }));
  applyEvent(
    after,
    event("TakerAllowedChanged", { account: TAKER2, allowed: true }),
  );
  const changes = projectionChanges(before, after);
  assert.equal(changes.maker, true);
  assert.deepEqual(changes.markets.sort(), ["1", "2"]);
  assert.deepEqual(
    changes.positions.sort(),
    ["1:" + TAKER2, "1:" + MAKER].sort(),
  );
  assert.deepEqual(changes.digests, [hash(0x902)]);
  assert.deepEqual(changes.takers, [TAKER2]);
  assert.deepEqual(changes.removed, []);
  // The reverse direction reports what disappeared.
  assert.deepEqual(projectionChanges(after, before).removed.sort(), [
    "digest:" + hash(0x902),
    "market:2",
    "position:1:" + TAKER2,
    "taker:" + TAKER2,
  ]);
});
