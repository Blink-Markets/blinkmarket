import {
  presets,
  RoleName,
  ClassName,
  OutcomeName,
  type ProtocolAccount,
  type ProtocolMarket,
  type MakerState,
  type DigestStatus,
  type Anchor,
} from "@blink/schemas";
export type EventValue =
  string | boolean | EventValue[] | { [key: string]: EventValue };
export interface ProtocolEvent {
  contract:
    | "REGISTRY"
    | "JURORS"
    | "MARKETS"
    | "RESOLUTION"
    | "FAUCET"
    | "ANCHOR"
    | "GOVERNOR";
  emitter: string;
  name: string;
  args: Record<string, EventValue>;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: bigint;
  txHash: string;
  txIndex: number;
  logIndex: number;
}
export interface ProtocolPosition {
  marketId: string;
  account: string;
  yesShares: string;
  noShares: string;
  takerBoughtShares: string;
  redeemedPayoutMicros: string;
}
export interface ProtocolTemplate {
  templateId: string;
  class: ProtocolMarket["class"];
  parserHash: string;
  uri: string;
}
export interface ProtocolFill {
  marketId: string;
  digest: string;
  maker: string;
  taker: string;
  side: "YES" | "NO";
  quantity: string;
  priceBps: string;
  takerCost: string;
  makerCost: string;
  fee: string;
  blockNumber: string;
  txHash: string;
}
export interface ProtocolProjection {
  accounts: Map<string, ProtocolAccount>;
  templates: Map<string, ProtocolTemplate>;
  markets: Map<string, ProtocolMarket>;
  positions: Map<string, ProtocolPosition>;
  makers: Map<string, MakerState>;
  digests: Map<string, DigestStatus>;
  fills: Map<string, ProtocolFill>;
  anchors: Map<string, Anchor>;
  successors: Map<string, { registry: string; effectiveAt: number }>;
}
export class ChainProjectionError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ChainProjectionError";
  }
}
export const emptyProtocolProjection = (): ProtocolProjection => ({
  accounts: new Map(),
  templates: new Map(),
  markets: new Map(),
  positions: new Map(),
  makers: new Map(),
  digests: new Map(),
  fills: new Map(),
  anchors: new Map(),
  successors: new Map(),
});
const fail = (e: ProtocolEvent, detail: string): never => {
  throw new ChainProjectionError(
    `${e.contract}.${e.name} at ${e.blockNumber}:${e.logIndex}: ${detail}`,
  );
};
const str = (e: ProtocolEvent, k: string) => {
  const v = e.args[k];
  return typeof v === "string" ? v : fail(e, `invalid ${k}`);
};
const uint = (e: ProtocolEvent, k: string) => {
  const v = str(e, k);
  return /^\d+$/.test(v) ? BigInt(v) : fail(e, `invalid uint ${k}`);
};
const num = (e: ProtocolEvent, k: string) => {
  const n = uint(e, k);
  return n <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(n)
    : fail(e, `unsafe integer ${k}`);
};
const hex = (e: ProtocolEvent, k: string, size: number) => {
  const v = str(e, k).toLowerCase();
  return new RegExp(`^0x[0-9a-f]{${size * 2}}$`).test(v)
    ? v
    : fail(e, `invalid hex ${k}`);
};
const addr = (e: ProtocolEvent, k: string) => hex(e, k, 20);
const hash = (e: ProtocolEvent, k: string) => hex(e, k, 32);
const flag = (e: ProtocolEvent, k: string) => {
  const v = e.args[k];
  return typeof v === "boolean" ? v : fail(e, `invalid bool ${k}`);
};
const member = <T extends string>(
  e: ProtocolEvent,
  k: string,
  values: readonly T[],
) => values[num(e, k)] ?? fail(e, `invalid enum ${k}`);
const add = (value: string, delta: bigint, e: ProtocolEvent) => {
  const n = BigInt(value) + delta;
  return n >= 0n ? n.toString() : fail(e, "negative balance");
};
export const tradable = (market: ProtocolMarket, at: number) =>
  market.state === "OPEN" && at < market.closeAt;
/** BlinkRegistry.creditOf: integer right shift, capped at 32 halvings. */
export function creditAt(
  c: { value: number; updatedAt: number } | undefined,
  at: number,
  halfLife: number,
): number {
  if (!c) return 0;
  if (!Number.isSafeInteger(halfLife) || halfLife <= 0 || at < c.updatedAt)
    throw new Error("INVALID_CREDIT_TIME");
  const shift = Math.floor((at - c.updatedAt) / halfLife);
  return shift >= 32 ? 0 : Number(BigInt(c.value) >> BigInt(shift));
}
export function hasRole(
  a: ProtocolAccount | null,
  role: RoleName,
  minStake: string,
): boolean {
  return role === "JUROR"
    ? !!a?.registered
    : !!a?.roles[role]?.active &&
        BigInt(a.roles[role].stakeMicros) >= BigInt(minStake);
}
function account(p: ProtocolProjection, e: ProtocolEvent) {
  const address = addr(e, "account");
  let a = p.accounts.get(address);
  if (!a) {
    a = {
      address,
      registered: false,
      roles: Object.fromEntries(
        RoleName.options.map((r) => [
          r,
          {
            stakeMicros: "0",
            active: false,
            exitRequestedAt: null,
            openObligations: 0,
          },
        ]),
      ) as ProtocolAccount["roles"],
      credit: Object.fromEntries(
        RoleName.options.map((r) => [r, { value: 0, updatedAt: 0 }]),
      ) as ProtocolAccount["credit"],
    };
    p.accounts.set(address, a);
  }
  return a;
}
function market(p: ProtocolProjection, e: ProtocolEvent) {
  return (
    p.markets.get(uint(e, "marketId").toString()) ?? fail(e, "unknown market")
  );
}
function maker(p: ProtocolProjection, e: ProtocolEvent) {
  const address = addr(e, "maker");
  let m = p.makers.get(address);
  if (!m) {
    m = { address, freeMicros: "0", epoch: "0" };
    p.makers.set(address, m);
  }
  return m;
}
function position(p: ProtocolProjection, id: string, address: string) {
  const key = `${id}:${address}`;
  let v = p.positions.get(key);
  if (!v) {
    v = {
      marketId: id,
      account: address,
      yesShares: "0",
      noShares: "0",
      takerBoughtShares: "0",
      redeemedPayoutMicros: "0",
    };
    p.positions.set(key, v);
  }
  return v;
}
// Task 7 folds these journaled juror/resolution events. Governance is observed, never executed.
export const recordOnlyEvents: Record<
  ProtocolEvent["contract"],
  readonly string[]
> = {
  REGISTRY: ["Imported"],
  JURORS: [
    "JurorRewarded",
    "RewardNotified",
    "RewardsClaimed",
    "RewardsForfeited",
    "Slashed",
    "Staked",
    "UnstakeRequested",
    "UnstakeWithdrawn",
    "VoteLocked",
    "VoteUnlocked",
  ],
  RESOLUTION: [
    "Appealed",
    "DisputeFinalized",
    "DisputeOpened",
    "Proposed",
    "RoundRestarted",
    "RoundSettled",
    "TimeoutFinalized",
    "UnchallengedFinalized",
    "VoteCommitted",
    "VoteRevealed",
    "VoteSettled",
  ],
  FAUCET: ["Claimed"],
  ANCHOR: [],
  MARKETS: ["EIP712DomainChanged"],
  GOVERNOR: [
    "EIP712DomainChanged",
    "ProposalCanceled",
    "ProposalCreated",
    "ProposalExecuted",
    "ProposalQueued",
    "ProposalThresholdSet",
    "QuorumNumeratorUpdated",
    "VoteCast",
    "VoteCastWithParams",
    "VotingDelaySet",
    "VotingPeriodSet",
  ],
};
function apply(
  p: ProtocolProjection,
  e: ProtocolEvent,
  halfLife: number,
): void {
  if (recordOnlyEvents[e.contract]?.includes(e.name)) return;
  if (e.contract === "REGISTRY") {
    const a = account(p, e);
    if (e.name === "Registered") {
      if (a.registered) fail(e, "duplicate registration");
      a.registered = true;
      return;
    }
    const role = member(e, "role", RoleName.options),
      r = a.roles[role];
    switch (e.name) {
      case "RoleJoined":
        r.stakeMicros = uint(e, "amount").toString();
        r.active = true;
        r.exitRequestedAt = null;
        return;
      case "RoleStakeAdded":
        r.stakeMicros = add(r.stakeMicros, uint(e, "amount"), e);
        return;
      case "RoleSlashed":
        r.stakeMicros = add(r.stakeMicros, -uint(e, "amount"), e);
        return;
      case "RoleExitRequested":
        r.active = false;
        r.exitRequestedAt = Number(e.blockTimestamp);
        return;
      case "RoleWithdrawn":
        r.stakeMicros = add(r.stakeMicros, -uint(e, "amount"), e);
        r.active = false;
        r.exitRequestedAt = null;
        return;
      case "RoleLocked":
      case "RoleUnlocked":
        r.openObligations = num(e, "openObligations");
        return;
      case "CreditGained":
      case "CreditLost":
      case "CreditImported": {
        const c = a.credit[role],
          at = Number(e.blockTimestamp),
          shift = Math.floor((at - c.updatedAt) / halfLife);
        // A prior reportLoss can materialise zero silently; its hidden clock cannot be inferred.
        if (
          c.value > 0 &&
          shift < 32 &&
          BigInt(c.value) >> BigInt(shift) === 0n
        )
          fail(
            e,
            "credit epoch is ambiguous after silent zero materialisation",
          );
        // _materialise preserves partial periods, except when the stored value was zero or expired.
        const updatedAt =
          c.value === 0 || shift >= 32 ? at : c.updatedAt + shift * halfLife;
        a.credit[role] = { value: num(e, "credit"), updatedAt };
        return;
      }
      default:
        fail(e, "unknown registry event");
    }
  }
  if (e.contract === "ANCHOR" && e.name === "Anchored") {
    const root = hash(e, "root");
    p.anchors.set(root, { root, by: addr(e, "by"), anchoredAt: num(e, "at") });
    return;
  }
  if (e.contract === "GOVERNOR" && e.name === "SuccessorAdopted") {
    const registry = addr(e, "registry");
    p.successors.set(registry, {
      registry,
      effectiveAt: num(e, "effectiveAt"),
    });
    return;
  }
  if (e.contract !== "MARKETS") return fail(e, "unknown contract event");
  switch (e.name) {
    case "TemplateRegistered": {
      const templateId = hash(e, "templateId");
      p.templates.set(templateId, {
        templateId,
        class: member(e, "cls", ClassName.options),
        parserHash: hash(e, "parserHash"),
        uri: str(e, "uri"),
      });
      return;
    }
    case "MarketCreated": {
      const marketId = uint(e, "marketId").toString();
      if (marketId === "0" || p.markets.has(marketId))
        fail(e, "duplicate or zero market");
      p.markets.set(marketId, {
        marketId,
        creator: addr(e, "creator"),
        class: member(e, "cls", ClassName.options),
        state: "PENDING",
        templateId: hash(e, "templateId"),
        specHash: hash(e, "specHash"),
        specUri: str(e, "specURI"),
        replay: flag(e, "replay"),
        openAt: num(e, "openAt"),
        closeAt: num(e, "closeAt"),
        proposalDeadline: num(e, "proposalDeadline"),
        hardDeadline: num(e, "hardDeadline"),
        maxPairs: uint(e, "maxPairs").toString(),
        mintedPairs: "0",
        escrowMicros: "0",
        feePoolMicros: "0",
        finalOutcome: null,
        feesDistributed: false,
        creationChallenged: false,
      });
      return;
    }
    case "MakerDeposited": {
      const m = maker(p, e);
      m.freeMicros = add(m.freeMicros, uint(e, "amount"), e);
      return;
    }
    case "MakerWithdrawn": {
      const m = maker(p, e);
      m.freeMicros = add(m.freeMicros, -uint(e, "amount"), e);
      return;
    }
    case "MakerEpochIncremented": {
      const m = maker(p, e),
        epoch = uint(e, "epoch");
      if (epoch !== BigInt(m.epoch) + 1n) fail(e, "epoch sequence");
      m.epoch = epoch.toString();
      return;
    }
    case "QuoteCancelled": {
      const digest = hash(e, "digest");
      if (p.digests.get(digest) === "CONSUMED") fail(e, "consumed digest");
      p.digests.set(digest, "CANCELLED");
      return;
    }
    case "MarketOpened": {
      const m = market(p, e);
      if (m.state !== "PENDING") fail(e, "opening non-pending market");
      m.state = "OPEN";
      m.openAt = num(e, "openAt");
      return;
    }
    case "CreationChallenged":
      market(p, e).creationChallenged = true;
      return;
    case "CreationResolved": {
      const m = market(p, e);
      m.creationChallenged = false;
      m.state = flag(e, "upheld") ? "CANCELLED" : "OPEN";
      return;
    }
    case "MarketProposed":
      market(p, e).state = "PROPOSED";
      return;
    case "MarketDisputed":
      market(p, e).state = "DISPUTED";
      return;
    case "MarketFinalized": {
      const m = market(p, e);
      m.state = "FINAL";
      m.finalOutcome = member(e, "outcome", OutcomeName.options);
      return;
    }
    case "QuoteFilled": {
      const m = market(p, e),
        d = hash(e, "digest"),
        mm = maker(p, e),
        taker = addr(e, "taker"),
        q = uint(e, "quantity"),
        price = uint(e, "priceBps"),
        tc = uint(e, "takerCost"),
        mc = uint(e, "makerCost"),
        fee = uint(e, "fee"),
        side = member(e, "side", ["YES", "NO"] as const);
      if (
        m.state !== "OPEN" ||
        p.digests.has(d) ||
        q === 0n ||
        price === 0n ||
        price >= 10000n ||
        tc !== q * price * 100n ||
        tc + mc !== q * 1000000n ||
        BigInt(m.mintedPairs) + q > BigInt(m.maxPairs)
      )
        fail(e, "inconsistent fill");
      mm.freeMicros = add(mm.freeMicros, -mc, e);
      m.mintedPairs = add(m.mintedPairs, q, e);
      m.escrowMicros = add(m.escrowMicros, q * 1000000n, e);
      m.feePoolMicros = add(m.feePoolMicros, fee, e);
      const bought = position(p, m.marketId, taker),
        sold = position(p, m.marketId, mm.address);
      bought.takerBoughtShares = add(bought.takerBoughtShares, q, e);
      if (side === "YES") {
        bought.yesShares = add(bought.yesShares, q, e);
        sold.noShares = add(sold.noShares, q, e);
      } else {
        bought.noShares = add(bought.noShares, q, e);
        sold.yesShares = add(sold.yesShares, q, e);
      }
      p.digests.set(d, "CONSUMED");
      p.fills.set(d, {
        marketId: m.marketId,
        digest: d,
        maker: mm.address,
        taker,
        side,
        quantity: q.toString(),
        priceBps: price.toString(),
        takerCost: tc.toString(),
        makerCost: mc.toString(),
        fee: fee.toString(),
        blockNumber: e.blockNumber.toString(),
        txHash: e.txHash,
      });
      return;
    }
    case "FeesDistributed": {
      const m = market(p, e);
      if (m.feePoolMicros !== uint(e, "amount").toString())
        fail(e, "fee pool mismatch");
      m.feePoolMicros = "0";
      m.feesDistributed = true;
      return;
    }
    case "PositionRedeemed": {
      const m = market(p, e),
        v = p.positions.get(`${m.marketId}:${addr(e, "account")}`),
        yes = uint(e, "yes"),
        no = uint(e, "no"),
        payout = uint(e, "payout");
      if (
        !v ||
        m.state !== "FINAL" ||
        BigInt(v.yesShares) !== yes ||
        BigInt(v.noShares) !== no ||
        yes + no === 0n
      )
        fail(e, "position mismatch");
      const expected =
        m.finalOutcome === "YES"
          ? yes * 1000000n
          : m.finalOutcome === "NO"
            ? no * 1000000n
            : (yes + no) * 500000n;
      if (payout !== expected) fail(e, "payout mismatch");
      m.escrowMicros = add(m.escrowMicros, -payout, e);
      v!.yesShares = "0";
      v!.noShares = "0";
      v!.redeemedPayoutMicros = add(v!.redeemedPayoutMicros, payout, e);
      return;
    }
    default:
      fail(e, "unhandled event");
  }
}
/** Pure single-event fold: callers keep their input even when validation fails. */
export function applyProtocolEvent(
  p: ProtocolProjection,
  e: ProtocolEvent,
  halfLife = presets.baseSepolia.creditHalfLife,
): ProtocolProjection {
  const next = structuredClone(p);
  apply(next, e, halfLife);
  return next;
}
export const compareEvents = (a: ProtocolEvent, b: ProtocolEvent) =>
  a.blockNumber < b.blockNumber
    ? -1
    : a.blockNumber > b.blockNumber
      ? 1
      : a.logIndex - b.logIndex;
export function foldProtocolEvents(
  events: readonly ProtocolEvent[],
  halfLife = presets.baseSepolia.creditHalfLife,
): ProtocolProjection {
  const p = emptyProtocolProjection();
  for (const e of [...events].sort(compareEvents)) apply(p, e, halfLife);
  return p;
}
export type ProjectionChanges = {
  [K in keyof ProtocolProjection]: string[];
} & { removed: string[] };
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
export function projectionChanges(
  before: ProtocolProjection,
  after: ProtocolProjection,
): ProjectionChanges {
  const changes = { removed: [] } as unknown as ProjectionChanges;
  for (const kind of Object.keys(after) as (keyof ProtocolProjection)[]) {
    changes[kind] = [];
    for (const [key, value] of after[kind])
      if (
        JSON.stringify(canonical(value)) !==
        JSON.stringify(canonical(before[kind].get(key)))
      )
        changes[kind].push(key);
    for (const key of before[kind].keys())
      if (!after[kind].has(key)) changes.removed.push(`${kind}:${key}`);
  }
  return changes;
}
