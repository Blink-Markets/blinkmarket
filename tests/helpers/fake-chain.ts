import {
  foldEvents,
  type DecodedEvent,
} from "../../packages/domain/src/chain-reducer.ts";
import type {
  ChainBlock,
  ChainLogReader,
  ChainViews,
} from "../../packages/ports/src/index.js";

export const MARKET_ADDRESS = "0x" + "aa".repeat(20);
export const MAKER = "0x" + "a1".repeat(20);
export const TAKER = "0x" + "b1".repeat(20);
export const TAKER2 = "0x" + "b2".repeat(20);

export const hashOf = (n: number | bigint) =>
  "0x" + BigInt(n).toString(16).padStart(64, "0");
export type NewEvent = Pick<DecodedEvent, "name" | "args">;

export const marketCreated = (id: number): NewEvent => ({
  name: "MarketCreated",
  args: {
    marketId: String(id),
    specHash: hashOf(0x700 + id),
    specURI: "fixture://REPLAY/" + id,
    mode: "1",
    closeAt: "5000",
    proposalDeadline: "6000",
    hardDeadline: "7000",
    challengeSeconds: "120",
    maxPairs: "10000",
    maxTakerShares: "500",
  },
});
export const makerDeposited = (micros: bigint): NewEvent => ({
  name: "MakerDeposited",
  args: { amountMicros: String(micros) },
});
export const takerAllowed = (account: string): NewEvent => ({
  name: "TakerAllowedChanged",
  args: { account, allowed: true },
});
export const quoteFilled = (
  digest: number,
  options: {
    side?: 0 | 1;
    quantity?: bigint;
    priceBps?: number;
    taker?: string;
    marketId?: number;
  } = {},
): NewEvent => {
  const quantity = options.quantity ?? 10n;
  const priceBps = options.priceBps ?? 6000;
  const takerCost = quantity * BigInt(priceBps) * 100n;
  return {
    name: "QuoteFilled",
    args: {
      marketId: String(options.marketId ?? 1),
      digest: hashOf(0x900 + digest),
      maker: MAKER,
      taker: options.taker ?? TAKER,
      side: String(options.side ?? 0),
      quantity: String(quantity),
      priceBps: String(priceBps),
      takerCost: String(takerCost),
      makerCost: String(quantity * 1_000_000n - takerCost),
    },
  };
};
export const quoteCancelled = (digest: number): NewEvent => ({
  name: "QuoteCancelled",
  args: { digest: hashOf(0x900 + digest) },
});

interface FakeBlock extends ChainBlock {
  events: DecodedEvent[];
}
export interface FakeReaderOptions {
  chainId?: number;
  /** null reports an unsupported finalized tag. */
  finalized?: bigint | null;
  /** Reports each log twice. */
  duplicateLogs?: boolean;
  /** Ignores the lower bound, as a provider replaying earlier logs would. */
  overlappingLogs?: boolean;
  headOverride?: bigint;
  /** Replaces the contract reads. */
  views?: (truth: ChainViews) => ChainViews;
  /** Called with the number of block() calls so far, after the call has been answered. */
  afterBlockCall?: (calls: number) => void | Promise<void>;
  /** Called after logs() computed its answer and before it returns. */
  afterLogs?: () => void | Promise<void>;
}

// A scriptable chain: blocks carry decoded events, a rewind starts a new fork, and the reader serves it
// the way the viem reader serves a node.
export class FakeChain {
  private blocks = new Map<bigint, FakeBlock>();
  private fork = 0;
  head = -1n;
  constructor(genesisHeight: bigint) {
    this.mineTo(genesisHeight);
  }
  private hash(fork: number, number: bigint) {
    return (
      "0x" +
      fork.toString(16).padStart(2, "0") +
      number.toString(16).padStart(62, "0")
    );
  }
  mine(events: NewEvent[] = []): FakeBlock {
    const number = this.head + 1n;
    const hash = this.hash(this.fork, number);
    const block: FakeBlock = {
      number,
      hash,
      parentHash:
        number === 0n ? hashOf(0) : this.blocks.get(number - 1n)!.hash,
      timestamp: 1000n + number * 2n,
      events: events.map((event, index) => ({
        ...event,
        blockNumber: number,
        blockHash: hash,
        blockTimestamp: 1000n + number * 2n,
        txHash: hashOf(0x70000 + Number(number) * 16 + index),
        txIndex: index,
        logIndex: index,
      })),
    };
    this.blocks.set(number, block);
    this.head = number;
    return block;
  }
  /** Empty blocks up to and including `number`. */
  mineTo(number: bigint) {
    while (this.head < number) this.mine();
  }
  /** Empty blocks up to `number - 1`, then one block with `events` at `number`. */
  mineAt(number: bigint, events: NewEvent[]) {
    this.mineTo(number - 1n);
    return this.mine(events);
  }
  /** Drops every block above `number`; the next blocks belong to a new fork. */
  rewind(number: bigint) {
    for (let n = this.head; n > number; n--) this.blocks.delete(n);
    this.head = number;
    this.fork += 1;
  }
  snapshot() {
    return { blocks: new Map(this.blocks), head: this.head, fork: this.fork };
  }
  restore(snapshot: ReturnType<FakeChain["snapshot"]>) {
    this.blocks = new Map(snapshot.blocks);
    this.head = snapshot.head;
    this.fork = snapshot.fork;
  }
  at(number: bigint) {
    return this.blocks.get(number);
  }
  allEvents(upTo = this.head) {
    return [...this.blocks.values()]
      .filter((b) => b.number <= upTo)
      .flatMap((b) => b.events);
  }

  reader(
    options: FakeReaderOptions = {},
  ): ChainLogReader & { blockCalls: number } {
    let blockCalls = 0;
    const self = this;
    return {
      get blockCalls() {
        return blockCalls;
      },
      async chainId() {
        return options.chainId ?? 84532;
      },
      async head() {
        const number = options.headOverride ?? self.head;
        const block = self.blocks.get(number)!;
        return { number, hash: block.hash, timestamp: block.timestamp };
      },
      async finalized() {
        return options.finalized ?? null;
      },
      async block(number) {
        blockCalls += 1;
        const block = self.blocks.get(number);
        const answer = block
          ? {
              number: block.number,
              hash: block.hash,
              parentHash: block.parentHash,
              timestamp: block.timestamp,
            }
          : null;
        await options.afterBlockCall?.(blockCalls);
        return answer;
      },
      async logs(address, from, to) {
        if (address.toLowerCase() !== MARKET_ADDRESS)
          throw new Error("UNEXPECTED_ADDRESS");
        const lower = options.overlappingLogs ? 0n : from;
        const found = self
          .allEvents(to)
          .filter((event) => event.blockNumber >= lower)
          .map((event) => ({ ...event }));
        await options.afterLogs?.();
        return options.duplicateLogs
          ? found.flatMap((e) => [e, { ...e }])
          : found;
      },
      async views(_address, blockHash, marketIds) {
        const block = [...self.blocks.values()].find(
          (b) => b.hash === blockHash,
        );
        if (!block) throw new Error("UNKNOWN_BLOCK");
        const truth = foldEvents(self.allEvents(block.number));
        const views: ChainViews = {
          makerFreeMicros: truth.maker.freeMicros,
          epoch: truth.maker.epoch,
          markets: new Map(
            marketIds.map((id) => {
              const market = truth.markets.get(id.toString())!;
              return [
                id.toString(),
                {
                  totalPairs: market.totalPairs,
                  escrowMicros: market.escrowMicros,
                  state: market.state,
                },
              ];
            }),
          ),
        };
        return options.views ? options.views(views) : views;
      },
    };
  }
}
