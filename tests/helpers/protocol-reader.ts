import type {
  ProtocolPosition,
  ProtocolReader,
  ProtocolTemplate,
} from "../../packages/ports/src/index.ts";
import {
  presets,
  type Anchor,
  type DigestStatus,
  type FeeBreakdown,
  type IndexHealth,
  type JurorState,
  type MakerState,
  type ProtocolAccount,
  type ProtocolDispute,
  type ProtocolMarket,
  type ProtocolProposal,
  type ProtocolRound,
  type ProtocolVote,
} from "../../packages/schemas/src/index.ts";

// BlinkRegistry decays credit by value >> floor(elapsed / halfLife) and zeroes it from 32 halvings.
const MAX_DECAY_SHIFT = 32;

export type FakeProtocolState = {
  health: IndexHealth;
  /** The two registry Params that hasRole and creditAt depend on. */
  params: { minRoleStake: string; creditHalfLife: number };
  accounts: ProtocolAccount[];
  markets: ProtocolMarket[];
  makers: MakerState[];
  digests: Record<string, DigestStatus>;
  anchors: Anchor[];
  proposals: ProtocolProposal[];
  disputes: ProtocolDispute[];
  rounds: ProtocolRound[];
  /** Stored as given: a test may leave a choice on an unrevealed vote to prove it is never served. */
  votes: ProtocolVote[];
  jurors: JurorState[];
  fees: FeeBreakdown[];
  templates: ProtocolTemplate[];
  positions: ProtocolPosition[];
};

const lower = (v: string) => v.toLowerCase();

/** In-memory ProtocolReader for tests that run before (or without) the real indexed store. */
export function fakeProtocolReader(
  initial: Partial<FakeProtocolState> = {},
): ProtocolReader & { set(patch: Partial<FakeProtocolState>): void } {
  let state: FakeProtocolState = {
    health: { headBlock: 0, indexedBlock: 0, lagSeconds: 0, stale: false },
    params: {
      minRoleStake: presets.baseSepolia.minRoleStake,
      creditHalfLife: presets.baseSepolia.creditHalfLife,
    },
    accounts: [],
    markets: [],
    makers: [],
    digests: {},
    anchors: [],
    proposals: [],
    disputes: [],
    rounds: [],
    votes: [],
    jurors: [],
    fees: [],
    templates: [],
    positions: [],
    ...initial,
  };
  const account = (address: string) =>
    state.accounts.find((a) => lower(a.address) === lower(address)) ?? null;
  const byId = (a: ProtocolMarket, b: ProtocolMarket) =>
    BigInt(a.marketId) < BigInt(b.marketId) ? -1 : 1;
  const paged = <T>(
    rows: T[],
    q: { after?: string; limit: number },
    key: (row: T) => string,
    isAfter: (row: T, after: string) => boolean,
  ) => {
    const rest = rows.filter((r) => q.after === undefined || isAfter(r, q.after));
    const items = rest.slice(0, q.limit);
    return {
      items,
      next: rest.length > q.limit ? key(items[items.length - 1]!) : null,
    };
  };
  const big = (v: string) => BigInt(v);
  return {
    set(patch) {
      state = { ...state, ...patch };
    },
    async health() {
      return state.health;
    },
    async account(address) {
      return account(address);
    },
    async hasRole(address, role) {
      const a = account(address);
      if (!a) return false;
      if (role === "JUROR") return a.registered;
      const r = a.roles[role];
      return (
        !!r &&
        r.active &&
        BigInt(r.stakeMicros) >= BigInt(state.params.minRoleStake)
      );
    },
    async creditAt(address, role, at) {
      const c = account(address)?.credit[role];
      if (!c) return 0;
      const shift = Math.floor(
        Math.max(0, at - c.updatedAt) / state.params.creditHalfLife,
      );
      return shift >= MAX_DECAY_SHIFT ? 0 : Math.floor(c.value / 2 ** shift);
    },
    async market(id) {
      return state.markets.find((m) => m.marketId === id) ?? null;
    },
    async marketBySpecHash(specHash) {
      return (
        state.markets.find((m) => lower(m.specHash) === lower(specHash)) ?? null
      );
    },
    async markets({ states, after, limit }) {
      const rows = [...state.markets]
        .sort(byId)
        .filter((m) => !states || states.includes(m.state))
        .filter(
          (m) => after === undefined || BigInt(m.marketId) > BigInt(after),
        );
      const items = rows.slice(0, limit);
      return {
        items,
        next: rows.length > limit ? items[items.length - 1]!.marketId : null,
      };
    },
    async maker(address) {
      return (
        state.makers.find((m) => lower(m.address) === lower(address)) ?? {
          address,
          freeMicros: "0",
          epoch: "0",
        }
      );
    },
    async digest(digest) {
      return state.digests[lower(digest)] ?? "UNUSED";
    },
    async anchor(root) {
      return state.anchors.find((a) => lower(a.root) === lower(root)) ?? null;
    },
    async proposal(marketId) {
      return state.proposals.find((p) => p.marketId === marketId) ?? null;
    },
    async disputes(marketId, q) {
      const rows = state.disputes
        .filter((d) => d.marketId === marketId)
        .sort((a, b) => (big(a.disputeId) < big(b.disputeId) ? -1 : 1));
      return paged(rows, q, (d) => d.disputeId, (d, after) => big(d.disputeId) > big(after));
    },
    async dispute(id) {
      return state.disputes.find((d) => d.disputeId === id) ?? null;
    },
    async rounds(disputeId) {
      return state.rounds
        .filter((r) => r.disputeId === disputeId)
        .sort((a, b) => a.round - b.round);
    },
    async votes(disputeId, q) {
      const order = (v: ProtocolVote) => `${String(v.round).padStart(10, "0")}:${v.juror}`;
      const rows = state.votes
        .filter((v) => v.disputeId === disputeId && (q.round === undefined || v.round === q.round))
        .sort((a, b) => (order(a) < order(b) ? -1 : 1));
      const key = (v: ProtocolVote) => `${v.round}:${v.juror}`;
      const page = paged(rows, q, key, (v, after) => {
        const [round, juror] = after.split(":");
        return order(v) > `${String(round).padStart(10, "0")}:${juror}`;
      });
      // Like the real reader, never show a choice that was not revealed.
      return {
        ...page,
        items: page.items.map((v) => (v.revealed ? v : { ...v, choice: null })),
      };
    },
    async juror(address) {
      return state.jurors.find((j) => lower(j.address) === lower(address)) ?? null;
    },
    async fees(marketId) {
      return state.fees.find((f) => f.marketId === marketId) ?? null;
    },
    async templates(q) {
      const rows = [...state.templates].sort((a, b) => (a.templateId < b.templateId ? -1 : 1));
      return paged(rows, q, (t) => t.templateId, (t, after) => t.templateId > after);
    },
    async positions(address, q) {
      const rows = state.positions
        .filter((p) => lower(p.account) === lower(address))
        .sort((a, b) => (big(a.marketId) < big(b.marketId) ? -1 : 1));
      return paged(rows, q, (p) => p.marketId, (p, after) => big(p.marketId) > big(after));
    },
  };
}
