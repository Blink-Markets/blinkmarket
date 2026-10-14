// Pure fold of canonical BlinkMarket events into the chain projections (migration 0007).
// Event arguments arrive as decimal strings, lowercase hex and booleans; amounts are bigint here.
// A rejected event leaves the projection untouched and signals that the feed or this model is wrong.

export const chainEventNames = [
  "MarketCreated",
  "TradingPauseChanged",
  "TakerAllowedChanged",
  "MakerDeposited",
  "MakerWithdrawn",
  "QuoteFilled",
  "QuoteCancelled",
  "MakerEpochIncremented",
  "OutcomeProposed",
  "OutcomeChallenged",
  "OutcomeFinalized",
  "PositionRedeemed",
] as const;
export type BlinkEventName = (typeof chainEventNames)[number];

export type DecodedEvent = {
  name: BlinkEventName;
  args: Record<string, string | boolean>;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: bigint;
  txHash: string;
  txIndex: number;
  logIndex: number;
};

export type ChainOutcome = "YES" | "NO" | "INVALID";
export type ChainMarketState = "OPEN" | "PROPOSED" | "DISPUTED" | "FINAL";
export type ChainFinalReason = "UNCHALLENGED" | "ARBITRATED" | "TIMEOUT";

export interface MarketProjection {
  marketId: string;
  specHash: string;
  specUri: string;
  mode: "LIVE" | "REPLAY";
  closeAt: bigint;
  proposalDeadline: bigint;
  hardDeadline: bigint;
  challengeSeconds: number;
  maxPairs: bigint;
  maxTakerShares: bigint;
  state: ChainMarketState;
  paused: boolean;
  proposedOutcome: ChainOutcome | null;
  proposedAt: bigint | null;
  proposalEvidenceHash: string | null;
  challengeEvidenceHash: string | null;
  finalOutcome: ChainOutcome | null;
  finalReason: ChainFinalReason | null;
  finalEvidenceHash: string | null;
  totalPairs: bigint;
  escrowMicros: bigint;
  createdBlockNumber: bigint;
  createdTxHash: string;
}
export interface PositionProjection {
  marketId: string;
  account: string;
  yesShares: bigint;
  noShares: bigint;
  takerBoughtShares: bigint;
  redeemedPayoutMicros: bigint;
}
export interface DigestProjection {
  digest: string;
  state: "FILLED" | "CANCELLED";
  marketId: string | null;
  taker: string | null;
  side: "YES" | "NO" | null;
  quantity: bigint | null;
  priceBps: number | null;
  takerCostMicros: bigint | null;
  makerCostMicros: bigint | null;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
}
// keys: marketId / `${marketId}:${account}` / digest / account (lowercase)
export interface ChainProjection {
  markets: Map<string, MarketProjection>;
  positions: Map<string, PositionProjection>;
  maker: { freeMicros: bigint; epoch: bigint; globalPaused: boolean };
  digests: Map<string, DigestProjection>;
  takers: Map<string, boolean>;
}

export class ChainProjectionError extends Error {
  readonly code = "INCONSISTENT_EVENT" as const;
  constructor(detail: string) {
    super("INCONSISTENT_EVENT: " + detail);
    this.name = "ChainProjectionError";
  }
}

const UNIT = 1_000_000n;
const OUTCOMES = ["YES", "NO", "INVALID"] as const;
const REASONS = ["UNCHALLENGED", "ARBITRATED", "TIMEOUT"] as const;
const MODES = ["LIVE", "REPLAY"] as const;
const SIDES = ["YES", "NO"] as const;

const fail: (event: DecodedEvent, detail: string) => never = (
  event,
  detail,
) => {
  throw new ChainProjectionError(
    `${event.name} at block ${event.blockNumber} log ${event.logIndex}: ${detail}`,
  );
};
const text = (event: DecodedEvent, key: string) => {
  const value = event.args[key];
  return typeof value === "string"
    ? value
    : fail(event, `${key} must be a string`);
};
const uint = (event: DecodedEvent, key: string) => {
  const value = text(event, key);
  return /^\d+$/.test(value)
    ? BigInt(value)
    : fail(event, `${key} must be an unsigned integer`);
};
const flag = (event: DecodedEvent, key: string) => {
  const value = event.args[key];
  return typeof value === "boolean"
    ? value
    : fail(event, `${key} must be a boolean`);
};
const lower = (event: DecodedEvent, key: string) =>
  text(event, key).toLowerCase();
const member = <T extends readonly string[]>(
  event: DecodedEvent,
  key: string,
  names: T,
): T[number] =>
  names[Number(uint(event, key))] ?? fail(event, `${key} is out of range`);

const positionKey = (marketId: string, account: string) =>
  `${marketId}:${account}`;
function market(state: ChainProjection, event: DecodedEvent, key = "marketId") {
  return (
    state.markets.get(uint(event, key).toString()) ??
    fail(event, "market " + text(event, key) + " is not indexed")
  );
}

export function emptyProjection(): ChainProjection {
  return {
    markets: new Map(),
    positions: new Map(),
    maker: { freeMicros: 0n, epoch: 0n, globalPaused: false },
    digests: new Map(),
    takers: new Map(),
  };
}

function position(state: ChainProjection, marketId: string, account: string) {
  const key = positionKey(marketId, account);
  let found = state.positions.get(key);
  if (!found) {
    found = {
      marketId,
      account,
      yesShares: 0n,
      noShares: 0n,
      takerBoughtShares: 0n,
      redeemedPayoutMicros: 0n,
    };
    state.positions.set(key, found);
  }
  return found;
}

const handlers: Record<
  BlinkEventName,
  (state: ChainProjection, event: DecodedEvent) => void
> = {
  MarketCreated(state, event) {
    const marketId = uint(event, "marketId");
    if (marketId === 0n || state.markets.has(marketId.toString()))
      fail(event, "market id is zero or already created");
    state.markets.set(marketId.toString(), {
      marketId: marketId.toString(),
      specHash: lower(event, "specHash"),
      specUri: text(event, "specURI"),
      mode: member(event, "mode", MODES),
      closeAt: uint(event, "closeAt"),
      proposalDeadline: uint(event, "proposalDeadline"),
      hardDeadline: uint(event, "hardDeadline"),
      challengeSeconds: Number(uint(event, "challengeSeconds")),
      maxPairs: uint(event, "maxPairs"),
      maxTakerShares: uint(event, "maxTakerShares"),
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
      createdBlockNumber: event.blockNumber,
      createdTxHash: event.txHash.toLowerCase(),
    });
  },
  TradingPauseChanged(state, event) {
    const paused = flag(event, "paused");
    if (flag(event, "globalPause")) state.maker.globalPaused = paused;
    else market(state, event).paused = paused;
  },
  TakerAllowedChanged(state, event) {
    state.takers.set(lower(event, "account"), flag(event, "allowed"));
  },
  MakerDeposited(state, event) {
    state.maker.freeMicros += uint(event, "amountMicros");
  },
  MakerWithdrawn(state, event) {
    const amount = uint(event, "amountMicros");
    if (amount > state.maker.freeMicros)
      fail(event, "withdrawal exceeds the free balance");
    state.maker.freeMicros -= amount;
  },
  QuoteFilled(state, event) {
    const m = market(state, event);
    const digest = lower(event, "digest");
    const quantity = uint(event, "quantity");
    const priceBps = uint(event, "priceBps");
    const takerCost = uint(event, "takerCost");
    const makerCost = uint(event, "makerCost");
    const side = member(event, "side", SIDES);
    const taker = lower(event, "taker");
    const maker = lower(event, "maker");
    if (m.state !== "OPEN") fail(event, "market is not OPEN");
    if (state.digests.has(digest))
      fail(event, "digest already filled or cancelled");
    if (takerCost + makerCost !== quantity * UNIT)
      fail(event, "costs do not add up to the notional");
    if (takerCost !== quantity * priceBps * 100n)
      fail(event, "taker cost does not match the price");
    if (makerCost > state.maker.freeMicros)
      fail(event, "maker cost exceeds the free balance");
    state.maker.freeMicros -= makerCost;
    m.escrowMicros += quantity * UNIT;
    m.totalPairs += quantity;
    const bought = position(state, m.marketId, taker);
    const sold = position(state, m.marketId, maker);
    bought.takerBoughtShares += quantity;
    if (side === "YES") {
      bought.yesShares += quantity;
      sold.noShares += quantity;
    } else {
      bought.noShares += quantity;
      sold.yesShares += quantity;
    }
    state.digests.set(digest, {
      digest,
      state: "FILLED",
      marketId: m.marketId,
      taker,
      side,
      quantity,
      priceBps: Number(priceBps),
      takerCostMicros: takerCost,
      makerCostMicros: makerCost,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash.toLowerCase(),
      txHash: event.txHash.toLowerCase(),
    });
  },
  QuoteCancelled(state, event) {
    const digest = lower(event, "digest");
    const known = state.digests.get(digest);
    if (known?.state === "FILLED")
      fail(event, "a filled digest cannot be cancelled");
    if (known) return;
    state.digests.set(digest, {
      digest,
      state: "CANCELLED",
      marketId: null,
      taker: null,
      side: null,
      quantity: null,
      priceBps: null,
      takerCostMicros: null,
      makerCostMicros: null,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash.toLowerCase(),
      txHash: event.txHash.toLowerCase(),
    });
  },
  MakerEpochIncremented(state, event) {
    if (uint(event, "epoch") !== state.maker.epoch + 1n)
      fail(event, "epoch does not follow the previous epoch");
    state.maker.epoch += 1n;
  },
  OutcomeProposed(state, event) {
    const m = market(state, event);
    if (m.state !== "OPEN") fail(event, "market is not OPEN");
    m.proposedOutcome = member(event, "outcome", OUTCOMES);
    m.proposedAt = event.blockTimestamp;
    m.proposalEvidenceHash = lower(event, "evidenceHash");
    m.state = "PROPOSED";
  },
  OutcomeChallenged(state, event) {
    const m = market(state, event);
    if (m.state !== "PROPOSED") fail(event, "market is not PROPOSED");
    m.challengeEvidenceHash = lower(event, "evidenceHash");
    m.state = "DISPUTED";
  },
  OutcomeFinalized(state, event) {
    const m = market(state, event);
    const outcome = member(event, "outcome", OUTCOMES);
    const reason = member(event, "reason", REASONS);
    if (m.state === "FINAL") fail(event, "market is already FINAL");
    if (reason === "UNCHALLENGED" && m.state !== "PROPOSED")
      fail(event, "unchallenged finalization needs a PROPOSED market");
    if (reason === "ARBITRATED" && m.state !== "DISPUTED")
      fail(event, "arbitration needs a DISPUTED market");
    m.finalOutcome = outcome;
    m.finalReason = reason;
    m.finalEvidenceHash = lower(event, "evidenceHash");
    m.state = "FINAL";
  },
  PositionRedeemed(state, event) {
    const m = market(state, event);
    const account = lower(event, "account");
    const yes = uint(event, "yesShares");
    const no = uint(event, "noShares");
    const payout = uint(event, "payoutMicros");
    if (m.state !== "FINAL") fail(event, "market is not FINAL");
    const held = state.positions.get(positionKey(m.marketId, account));
    if (!held) return fail(event, "no projected position to redeem");
    if (held.yesShares !== yes || held.noShares !== no || yes + no === 0n)
      fail(event, "redeemed shares differ from the projected position");
    const expected =
      m.finalOutcome === "YES"
        ? yes * UNIT
        : m.finalOutcome === "NO"
          ? no * UNIT
          : (yes + no) * (UNIT / 2n);
    if (payout !== expected)
      fail(event, "payout differs from the outcome rule");
    if (payout > m.escrowMicros)
      fail(event, "payout exceeds the market escrow");
    held.yesShares = 0n;
    held.noShares = 0n;
    held.redeemedPayoutMicros += payout;
    m.escrowMicros -= payout;
  },
};

// Handlers validate before they mutate, so a rejected event changes nothing; only the closing
// escrow check can fire after a change, and it means the loaded projection was already unsound.
export function applyEvent(state: ChainProjection, event: DecodedEvent): void {
  handlers[event.name](state, event);
  const touched =
    event.args.marketId !== undefined &&
    /^\d+$/.test(String(event.args.marketId))
      ? state.markets.get(String(event.args.marketId))
      : undefined;
  if (
    touched &&
    touched.state !== "FINAL" &&
    touched.escrowMicros !== touched.totalPairs * UNIT
  )
    fail(event, "escrow differs from total pairs times one unit");
}

export const compareEvents = (a: DecodedEvent, b: DecodedEvent) =>
  a.blockNumber < b.blockNumber
    ? -1
    : a.blockNumber > b.blockNumber
      ? 1
      : a.txIndex - b.txIndex || a.logIndex - b.logIndex;

export function foldEvents(events: readonly DecodedEvent[]): ChainProjection {
  const state = emptyProjection();
  for (const event of [...events].sort(compareEvents)) applyEvent(state, event);
  return state;
}

export interface ProjectionChanges {
  maker: boolean;
  markets: string[];
  positions: string[];
  digests: string[];
  takers: string[];
  // Entries in `before` that `after` lacks, as `${kind}:${key}`.
  removed: string[];
}

const sameRecord = (a: object, b: object) => {
  const left = Object.entries(a);
  return (
    left.length === Object.keys(b).length &&
    left.every(([key, value]) => (b as Record<string, unknown>)[key] === value)
  );
};
function diff<T extends object>(
  kind: string,
  before: Map<string, T>,
  after: Map<string, T>,
  changed: string[],
  removed: string[],
) {
  for (const [key, value] of after) {
    const old = before.get(key);
    if (!old || !sameRecord(old, value)) changed.push(key);
  }
  for (const key of before.keys())
    if (!after.has(key)) removed.push(`${kind}:${key}`);
}

// What a store must write to turn `before` into `after`.
export function projectionChanges(
  before: ChainProjection,
  after: ChainProjection,
): ProjectionChanges {
  const changes: ProjectionChanges = {
    maker: !sameRecord(before.maker, after.maker),
    markets: [],
    positions: [],
    digests: [],
    takers: [],
    removed: [],
  };
  diff(
    "market",
    before.markets,
    after.markets,
    changes.markets,
    changes.removed,
  );
  diff(
    "position",
    before.positions,
    after.positions,
    changes.positions,
    changes.removed,
  );
  diff(
    "digest",
    before.digests,
    after.digests,
    changes.digests,
    changes.removed,
  );
  const takers = (map: Map<string, boolean>) =>
    new Map([...map].map(([key, allowed]) => [key, { allowed }]));
  diff(
    "taker",
    takers(before.takers),
    takers(after.takers),
    changes.takers,
    changes.removed,
  );
  return changes;
}
