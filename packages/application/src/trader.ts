import { createHash } from "node:crypto";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import {
  DeploymentManifest,
  SignedQuoteResponse,
  quoteTypes,
} from "@blink/schemas";
import {
  askPriceBps,
  JobError,
  parseQuoteMessage,
  quoteCosts,
  quoteDomain,
  traderDecision,
  type QuoteMessage,
} from "@blink/domain";
import type {
  CallEncoder,
  ChainHead,
  Hex,
  TraderContext,
  TraderIntentFact,
  TraderMandate,
  TraderMarketView,
  TraderQuoteApi,
  TraderRole,
  TraderSignedQuote,
  TraderStore,
  TraderTrade,
} from "@blink/ports";
import { indexerStatus } from "./rfq.js";
import { quoteTypedData } from "./signer.js";
import { TxDispatchError, type DispatchResult } from "./tx-dispatcher.js";

// A buy whose RFQ was never admitted is given back after this long (business clock). Nothing was
// signed for it, and a quote that still appears later is never acted on once it is released.
const RFQ_PATIENCE_SECONDS = 120;
// Approve and fill are only started while the quote still has this much block time to live.
const MIN_QUOTE_LEAD_SECONDS = 6n;
const POLL_MS = 1000;
const REDEEM_WAIT_MS = 30_000;

/** A stable id for one buy: the same mandate, market and forecast window always give the same one. */
export function traderIntentId(input: {
  agentId: string;
  deploymentId: string;
  marketId: string;
  windowId: string;
}): string {
  const h = createHash("sha256")
    .update(
      JSON.stringify([
        "blink-trader-intent-v1",
        input.agentId,
        input.deploymentId,
        input.marketId,
        input.windowId,
      ]),
    )
    .digest("hex");
  const variant = (8 + (parseInt(h[16]!, 16) & 3)).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Why no new buy may start on this market now; null when it may. In-flight buys use it too. */
export function traderStopReason(
  ctx: TraderContext,
  market: TraderMarketView,
): string | null {
  const manifest = DeploymentManifest.safeParse(ctx.deployment?.manifest);
  if (
    !ctx.deployment?.enabled ||
    !manifest.success ||
    !manifest.data.tradingEnabled
  )
    return "TRADING_DISABLED";
  if (indexerStatus(ctx.cursor, ctx.cursor?.headNumber ?? 0n) !== "FRESH")
    return "INDEXER_LAG";
  if (ctx.globalPaused || market.paused) return "TRADING_PAUSED";
  if (ctx.poolGate) return "SERVICE_NOT_READY";
  if (market.state !== "OPEN") return "MARKET_CLOSED";
  // Close is judged on block time and on the business clock; either one reaching it stops the buy.
  if (
    ctx.cursor!.blockTimestamp >= market.closeAt ||
    ctx.nowSeconds >= market.closeAt
  )
    return "MARKET_CLOSED";
  if (market.gates[0]) return market.gates[0];
  if (!ctx.takerAllowed) return "TAKER_NOT_ALLOWED";
  return null;
}

type Verified =
  | { ok: true; message: QuoteMessage; signature: Hex; takerCostMicros: bigint }
  | { ok: false; reason: string };

/**
 * What a careful taker checks before it spends anything on a quote: it is for this deployment,
 * market, side, size, taker and maker, priced no higher than the ask the decision saw, costed
 * consistently, signed over the contract's own EIP-712 domain by the maker, and its calldata is
 * exactly the fill of that message. Nothing the API says is taken on trust.
 */
export async function verifyTraderQuote(input: {
  quote: TraderSignedQuote;
  manifest: DeploymentManifest;
  deploymentId: string;
  marketId: bigint;
  specHash: string;
  side: "YES" | "NO";
  shares: number;
  wallet: string;
  askBps: number;
  encodeCall: CallEncoder;
}): Promise<Verified> {
  const { quote, manifest } = input;
  const bad = (reason: string): Verified => ({ ok: false, reason });
  const market = manifest.contracts.BlinkMarket.toLowerCase();
  if (quote.deploymentId !== input.deploymentId)
    return bad("DEPLOYMENT_MISMATCH");
  const domain = quoteDomain(manifest);
  if (
    quote.verifyingContract.toLowerCase() !== market ||
    quote.domain.verifyingContract.toLowerCase() !== market ||
    quote.domain.chainId !== domain.chainId ||
    quote.domain.name !== domain.name ||
    quote.domain.version !== domain.version
  )
    return bad("DOMAIN_MISMATCH");
  if (JSON.stringify(quote.types.Quote) !== JSON.stringify(quoteTypes.Quote))
    return bad("TYPES_MISMATCH");
  const message = parseQuoteMessage(quote.message);
  if (!message) return bad("QUOTE_INVALID");
  if (
    message.marketId !== input.marketId ||
    BigInt(quote.marketId) !== input.marketId ||
    message.specHash !== input.specHash.toLowerCase()
  )
    return bad("MARKET_MISMATCH");
  if (message.maker !== manifest.roles.maker.toLowerCase())
    return bad("MAKER_MISMATCH");
  if (message.taker !== input.wallet.toLowerCase())
    return bad("TAKER_MISMATCH");
  if (message.side !== (input.side === "YES" ? 0 : 1))
    return bad("SIDE_MISMATCH");
  if (message.quantity !== BigInt(input.shares))
    return bad("QUANTITY_MISMATCH");
  if (message.priceBps < 1n || message.priceBps > BigInt(input.askBps))
    return bad("PRICE_ABOVE_ASK");
  const lifetime = message.expiresAt - message.validAfter;
  if (
    lifetime < 1n ||
    lifetime > 60n ||
    quote.expiresAt !== String(message.expiresAt)
  )
    return bad("LIFETIME_INVALID");
  const costs = quoteCosts(message.quantity, Number(message.priceBps));
  if (
    quote.takerCostMicros !== String(costs.takerCostMicros) ||
    quote.makerCostMicros !== String(costs.makerCostMicros)
  )
    return bad("COST_MISMATCH");
  const typed = quoteTypedData(manifest, message);
  if (hashTypedData(typed) !== quote.quoteId.toLowerCase())
    return bad("DIGEST_MISMATCH");
  const signature = quote.signature as Hex;
  try {
    const signer = await recoverTypedDataAddress({ ...typed, signature });
    if (signer.toLowerCase() !== message.maker) return bad("SIGNATURE_INVALID");
  } catch {
    return bad("SIGNATURE_INVALID");
  }
  const calldata = input.encodeCall({
    to: market,
    functionName: "fillQuote",
    args: [message, signature],
  });
  if (calldata.toLowerCase() !== quote.calldata.toLowerCase())
    return bad("CALLDATA_MISMATCH");
  return {
    ok: true,
    message,
    signature,
    takerCostMicros: costs.takerCostMicros,
  };
}

const wire = (m: QuoteMessage): Record<string, string> => ({
  marketId: String(m.marketId),
  specHash: m.specHash,
  maker: m.maker,
  taker: m.taker,
  side: m.side === 0 ? "0" : "1",
  quantity: String(m.quantity),
  priceBps: String(m.priceBps),
  validAfter: String(m.validAfter),
  expiresAt: String(m.expiresAt),
  nonce: String(m.nonce),
  epoch: String(m.epoch),
});
const isMined = (fact: TraderIntentFact | null) =>
  fact !== null &&
  fact.mined === "success" &&
  (fact.state === "INCLUDED" || fact.state === "FINALIZED");

export interface TraderRun {
  /** Why the whole run did nothing (no mandate, mandate disabled). */
  stopped: string | null;
  /** One outcome per market the decision pass looked at. */
  markets: Record<string, string>;
  /** One outcome per reservation carried forward, by its buy id. */
  trades: Record<string, string>;
  /** One outcome per FINAL market where the wallet held shares. */
  redeemed: Record<string, string>;
}

export interface TraderDeps {
  store: TraderStore;
  /** The public RFQ API, called with the trader's own key. */
  api: TraderQuoteApi;
  dispatcher: {
    dispatch(intentId: string, signal?: AbortSignal): Promise<DispatchResult>;
  };
  /** The live canonical head: quote life is judged on block time, never on a host clock. */
  chain: { head(): Promise<ChainHead> };
  encodeCall: CallEncoder;
  deploymentId: string;
  role: TraderRole;
  /** Keeps a transaction watched to finality after the trader stops waiting for it. */
  track(intentId: string): Promise<void>;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  now?(): number;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * The internal trader (spec 9.3, 12.3). Deterministic: it buys when its own forecaster's
 * probability beats the ask by more than the mandate's threshold, within the mandate, through the
 * public RFQ and the restricted signer. It holds no key and sends no calldata of its own: every
 * transaction is an intent the signer checks and signs, built only from numbers read from the
 * database and from a verified envelope.
 */
export function createTrader(deps: TraderDeps) {
  const { store } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const manifestOf = (ctx: TraderContext) => {
    const parsed = DeploymentManifest.safeParse(ctx.deployment?.manifest);
    return parsed.success ? parsed.data : null;
  };
  const aborted = (signal: AbortSignal) => {
    if (signal.aborted) throw new JobError("OPERATION_ABORTED", true);
  };

  // Sends one intent through the dispatcher until a block holds it, it fails for good, or the
  // wall-clock bound passes. A refused first signature is final; a transient dispatch error is not.
  async function drive(
    intentId: string,
    until: number,
    signal: AbortSignal,
  ): Promise<"MINED" | "FAILED" | "PENDING"> {
    for (;;) {
      aborted(signal);
      let result: DispatchResult;
      try {
        result = await deps.dispatcher.dispatch(intentId, signal);
      } catch (error) {
        if (error instanceof TxDispatchError) {
          if (error.code.startsWith("SIGN_REJECTED")) return "FAILED";
          if (error.retryable) return "PENDING";
        }
        throw error;
      }
      if (result === "REVERTED") return "FAILED";
      if (result === "INCLUDED" || result === "FINALIZED")
        return isMined(await store.intent(intentId)) ? "MINED" : "PENDING";
      if (now() >= until) return "PENDING";
      await sleep(POLL_MS, signal);
    }
  }

  async function advance(
    trade: TraderTrade,
    ctx: TraderContext,
    mandate: TraderMandate,
    signal: AbortSignal,
  ): Promise<string> {
    const r = trade.reservation;
    const release = async (reason: string) => {
      await store.release(r.id, reason);
      return "RELEASED:" + reason;
    };
    const cursor = trade.cursor;
    // A projection under repair is not evidence of anything: settle nothing against it.
    if (!cursor || cursor.gateReason) return "WAITING:INDEXER_GATED";

    // 1. What the canonical chain says decides first.
    if (trade.digest === "FILLED") {
      if (r.state === "HELD") await store.setAccounted(r.id, true);
      if (trade.fill) await deps.track(trade.fill.intentId);
      return "ACCOUNTED";
    }
    // The fill's block was reorged away: its risk is occupied again until the chain says otherwise.
    if (r.state === "ACCOUNTED") await store.setAccounted(r.id, false);

    // 2. Definitive ends. Expiry is block time only: a host clock never gives capacity back.
    if (trade.approve?.state === "FAILED") return release("APPROVE_FAILED");
    if (trade.fill?.state === "FAILED") return release("FILL_FAILED");
    const quote = trade.quote;
    if (!quote && r.ageSeconds >= RFQ_PATIENCE_SECONDS)
      return release("RFQ_NOT_ADMITTED");
    if (quote) {
      if (
        trade.digest === "CANCELLED" ||
        (trade.makerEpoch !== null && trade.makerEpoch > quote.epoch)
      )
        return release("QUOTE_CANCELLED");
      if (cursor.blockTimestamp >= quote.expiresAt)
        return release("QUOTE_EXPIRED");
    }

    // 3. Everything below can spend: only while the mandate is on and the market may be traded.
    const manifest = manifestOf(ctx);
    if (!mandate.enabled || !manifest) return "WAITING:DISABLED";
    const market = ctx.markets.find((m) => m.marketId === r.marketId);
    const stop = market ? traderStopReason(ctx, market) : "MARKET_CLOSED";
    if (stop) return "WAITING:" + stop;

    // 4. The quote: the stored signed envelope, or the RFQ (idempotent under the buy's own key).
    const maxCostMicros = BigInt(r.shares) * BigInt(r.askBps) * 100n;
    let envelope: TraderSignedQuote | null = null;
    if (quote?.envelope) {
      const stored = SignedQuoteResponse.safeParse(quote.envelope);
      if (!stored.success) {
        await store.audit({
          action: "trader.quote_refused",
          resource: r.intentId,
          reason: "SCHEMA",
        });
        return release("ENVELOPE_INVALID:SCHEMA");
      }
      envelope = stored.data;
    }
    if (!envelope) {
      aborted(signal);
      const answer = await deps.api.requestQuote(
        {
          deploymentId: r.deploymentId,
          marketId: r.marketId,
          side: r.side,
          quantity: String(r.shares),
          maxCostMicros: String(maxCostMicros),
        },
        "trader-" + r.intentId,
      );
      if (!answer.ok)
        return answer.retryable
          ? "WAITING:RFQ:" + answer.code
          : release("RFQ_REJECTED:" + answer.code);
      envelope = answer.quote;
    }
    const verified = await verifyTraderQuote({
      quote: envelope,
      manifest,
      deploymentId: r.deploymentId,
      marketId: BigInt(r.marketId),
      specHash: market!.specHash,
      side: r.side,
      shares: r.shares,
      wallet: mandate.wallet,
      askBps: r.askBps,
      encodeCall: deps.encodeCall,
    });
    if (!verified.ok) {
      await store.audit({
        action: "trader.quote_refused",
        resource: r.intentId,
        reason: verified.reason,
      });
      return release("ENVELOPE_INVALID:" + verified.reason);
    }

    // 5. Approve exactly the cost, then fill. Quote life is read from the live head each time.
    // Seconds of block time the quote has left, or null when the head cannot be read.
    const lead = async () => {
      try {
        return verified.message.expiresAt - (await deps.chain.head()).timestamp;
      } catch {
        return null;
      }
    };
    let remaining = await lead();
    if (remaining === null) return "WAITING:CHAIN_UNAVAILABLE";
    if (remaining < MIN_QUOTE_LEAD_SECONDS) return "WAITING:QUOTE_EXPIRING";
    const wait = (seconds: bigint) => now() + Number(seconds) * 1000;
    if (!isMined(trade.approve)) {
      const { intentId } = trade.approve
        ? { intentId: trade.approve.intentId }
        : await store.prepare({
            deploymentId: r.deploymentId,
            kind: "APPROVE",
            dedupeKey: "trader:approve:" + r.intentId,
            payload: {
              tradeIntentId: r.intentId,
              marketId: r.marketId,
              amountMicros: String(verified.takerCostMicros),
            },
            unsignedPayload: {
              to: manifest.contracts.BlinkTestUSD.toLowerCase(),
              functionName: "approve",
              args: [
                manifest.contracts.BlinkMarket.toLowerCase(),
                String(verified.takerCostMicros),
              ],
            },
          });
      const outcome = await drive(intentId, wait(remaining), signal);
      if (outcome === "FAILED") return release("APPROVE_FAILED");
      if (outcome !== "MINED") return "WAITING:APPROVE";
      await deps.track(intentId);
      remaining = await lead();
      if (remaining === null) return "WAITING:CHAIN_UNAVAILABLE";
      if (remaining < MIN_QUOTE_LEAD_SECONDS) return "WAITING:QUOTE_EXPIRING";
    }
    if (isMined(trade.fill)) {
      await deps.track(trade.fill!.intentId);
      return "FILL_INCLUDED";
    }
    const { intentId } = trade.fill
      ? { intentId: trade.fill.intentId }
      : await store.prepare({
          deploymentId: r.deploymentId,
          kind: "FILL",
          dedupeKey: "trader:fill:" + r.intentId,
          payload: {
            tradeIntentId: r.intentId,
            marketId: r.marketId,
            quoteId: envelope.quoteId,
          },
          unsignedPayload: {
            to: manifest.contracts.BlinkMarket.toLowerCase(),
            functionName: "fillQuote",
            args: [wire(verified.message), verified.signature],
          },
        });
    const outcome = await drive(intentId, wait(remaining), signal);
    if (outcome === "FAILED") return release("FILL_FAILED");
    if (outcome !== "MINED") return "WAITING:FILL";
    await deps.track(intentId);
    return "FILL_INCLUDED";
  }

  // Redeem what a FINAL market pays: one REDEEM intent per market and wallet, only on a fresh indexer.
  async function redeem(
    ctx: TraderContext,
    mandate: TraderMandate,
    signal: AbortSignal,
    run: TraderRun,
  ) {
    const manifest = manifestOf(ctx);
    if (!manifest) return;
    const wallet = mandate.wallet.toLowerCase();
    for (const item of await store.redeemable({
      deploymentId: deps.deploymentId,
      wallet: wallet as Hex,
    })) {
      aborted(signal);
      const { marketId, intent } = item;
      if (intent?.state === "FAILED") {
        await store.audit({
          action: "trader.redeem_failed",
          resource: `${deps.deploymentId}:${marketId}:${wallet.slice(2)}`,
          reason: intent.intentId,
        });
        run.redeemed[marketId] = "FAILED";
        continue;
      }
      if (isMined(intent)) {
        await deps.track(intent!.intentId);
        run.redeemed[marketId] = "INCLUDED";
        continue;
      }
      if (indexerStatus(ctx.cursor, ctx.cursor?.headNumber ?? 0n) !== "FRESH") {
        run.redeemed[marketId] = "WAITING:INDEXER_LAG";
        continue;
      }
      const { intentId } = intent
        ? { intentId: intent.intentId }
        : await store.prepare({
            deploymentId: deps.deploymentId,
            kind: "REDEEM",
            dedupeKey: `trader:redeem:${deps.deploymentId}:${marketId}:${wallet.slice(2)}`,
            payload: { marketId },
            unsignedPayload: {
              to: manifest.contracts.BlinkMarket.toLowerCase(),
              functionName: "redeem",
              args: [marketId],
            },
          });
      const outcome = await drive(intentId, now() + REDEEM_WAIT_MS, signal);
      if (outcome === "MINED") await deps.track(intentId);
      run.redeemed[marketId] =
        outcome === "MINED"
          ? "INCLUDED"
          : outcome === "FAILED"
            ? "FAILED"
            : "WAITING";
    }
  }

  async function evaluate(signal: AbortSignal): Promise<TraderRun> {
    const run: TraderRun = {
      stopped: null,
      markets: {},
      trades: {},
      redeemed: {},
    };
    const mandate = await store.mandate(deps.role);
    if (!mandate) {
      run.stopped = "NO_MANDATE";
      return run;
    }
    const ctx = await store.context({
      deploymentId: deps.deploymentId,
      mandate,
    });

    // Buys already in flight carry on first, whether or not the mandate still allows new ones.
    for (const trade of await store.trades({
      agentId: mandate.agentId,
      deploymentId: deps.deploymentId,
    })) {
      aborted(signal);
      run.trades[trade.reservation.intentId] = await advance(
        trade,
        ctx,
        mandate,
        signal,
      );
    }
    await redeem(ctx, mandate, signal, run);

    if (!mandate.enabled) {
      run.stopped = "MANDATE_DISABLED";
      return run;
    }
    const manifest = manifestOf(ctx);
    if (!manifest) {
      run.stopped = "TRADING_DISABLED";
      return run;
    }
    for (const market of ctx.markets) {
      aborted(signal);
      const stop = traderStopReason(ctx, market);
      if (stop) {
        run.markets[market.marketId] = stop;
        continue;
      }
      const snapshot = market.snapshot;
      if (!snapshot) {
        run.markets[market.marketId] = "NO_FORECAST";
        continue;
      }
      const spreadBps = manifest.parameters.makerSpreadBps;
      const ask = (side: "YES" | "NO") =>
        askPriceBps({
          probabilitySumMillionths: snapshot.probabilitySumMillionths,
          side,
          spreadBps,
        });
      const askYesBps = ask("YES");
      const askNoBps = ask("NO");
      const decision = traderDecision({
        ownProbabilityMillionths: snapshot.ownProbabilityMillionths,
        askYesBps,
        askNoBps,
        thresholdBps: mandate.edgeThresholdBps,
      });
      if (!decision) {
        run.markets[market.marketId] = "NO_EDGE";
        continue;
      }
      const intentId = traderIntentId({
        agentId: mandate.agentId,
        deploymentId: deps.deploymentId,
        marketId: market.marketId,
        windowId: snapshot.windowId,
      });
      const reserved = await store.reserve({
        mandate,
        intentId,
        deploymentId: deps.deploymentId,
        marketId: market.marketId,
        windowId: snapshot.windowId,
        side: decision.side,
        shares: mandate.sharesPerTrade,
        askBps: decision.side === "YES" ? askYesBps : askNoBps,
        ownProbabilityMillionths: snapshot.ownProbabilityMillionths,
      });
      if (reserved.state === "EXISTS") {
        run.markets[market.marketId] = "DECIDED:" + reserved.reservationState;
        continue;
      }
      if (reserved.state === "SKIPPED") {
        run.markets[market.marketId] = "SKIPPED:" + reserved.reason;
        continue;
      }
      const trade = await store.trade(intentId);
      run.markets[market.marketId] = "RESERVED";
      run.trades[intentId] = await advance(trade!, ctx, mandate, signal);
    }
    return run;
  }

  return { evaluate };
}

/** The `trader.evaluate` job handler. The payload is ignored: every run looks at everything. */
export function createTraderHandler(trader: {
  evaluate(signal: AbortSignal): Promise<TraderRun>;
}) {
  return async (ctx: {
    job: { id: string; payload: Record<string, unknown> };
    signal: AbortSignal;
  }): Promise<void> => {
    await trader.evaluate(ctx.signal);
  };
}
