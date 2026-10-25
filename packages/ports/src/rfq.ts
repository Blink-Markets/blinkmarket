export interface RfqRecord {
  id: string;
  /** Orders the open list; also its paging cursor. */
  seq: string;
  marketId: string;
  specHash: string;
  side: "YES" | "NO";
  quantity: string;
  /** Lowercase address. */
  taker: string;
  createdAt: number;
  expiresAt: number;
}
/** The posted quote fields (as JSON text, exactly as stored) and the signature bytes. */
export interface StoredQuote {
  quote: string;
  signature: string;
}
export interface MakerStatsRecord {
  quotesRelayed: number;
  quotesFilled: number;
  quotesCancelledBeforeExpiry: number;
}
export interface RfqStore {
  /** False when the taker already holds `maxOpen` open RFQs; nothing is stored then. */
  create(
    input: Omit<RfqRecord, "seq">,
    maxOpen: number,
  ): Promise<boolean>;
  get(id: string): Promise<RfqRecord | null>;
  /** Open RFQs (expiresAt > now) with seq > after, oldest first. */
  listOpen(q: { after: string | null; limit: number; now: number }): Promise<RfqRecord[]>;
  /** Atomic: the RFQ is still open by the store's own clock, read after the per-RFQ lock is taken, at most `maxPerRfq` quotes per RFQ and one per maker; nothing is stored on a refusal. */
  addQuote(
    input: {
      rfqId: string;
      /** Lowercase address. */
      maker: string;
      digest: string;
      priceBps: number;
      expiresAt: number;
      quote: string;
      signature: string;
    },
    maxPerRfq: number,
  ): Promise<"OK" | "DUPLICATE" | "FULL" | "CLOSED">;
  /** priceBps ascending, then arrival. */
  quotes(rfqId: string): Promise<StoredQuote[]>;
  stats(maker: string): Promise<MakerStatsRecord>;
}
