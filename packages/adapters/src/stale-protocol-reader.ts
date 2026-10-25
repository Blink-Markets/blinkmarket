import type { ProtocolReader } from "@blink/ports";

/**
 * The reader of a process that has no deployment to read: its index counts as stale, so every
 * identity-acting write refuses, and it knows no market.
 */
export const staleProtocolReader: ProtocolReader = {
  health: async () => ({
    headBlock: 0,
    indexedBlock: 0,
    lagSeconds: 0,
    stale: true,
  }),
  account: async () => null,
  hasRole: async () => false,
  creditAt: async () => 0,
  market: async () => null,
  marketBySpecHash: async () => null,
  markets: async () => ({ items: [], next: null }),
  maker: async (address: string) => ({ address, freeMicros: "0", epoch: "0" }),
  digest: async () => "UNUSED" as const,
  anchor: async () => null,
  proposal: async () => null,
  disputes: async () => ({ items: [], next: null }),
  dispute: async () => null,
  rounds: async () => [],
  votes: async () => ({ items: [], next: null }),
  juror: async () => null,
  fees: async () => null,
  templates: async () => ({ items: [], next: null }),
  positions: async () => ({ items: [], next: null }),
};
