import type { ProtocolReader } from "../../packages/ports/src/index.ts";
import {
  presets,
  type Anchor,
  type DigestStatus,
  type IndexHealth,
  type MakerState,
  type ProtocolAccount,
  type ProtocolMarket,
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
    ...initial,
  };
  const account = (address: string) =>
    state.accounts.find((a) => lower(a.address) === lower(address)) ?? null;
  const byId = (a: ProtocolMarket, b: ProtocolMarket) =>
    BigInt(a.marketId) < BigInt(b.marketId) ? -1 : 1;
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
  };
}
