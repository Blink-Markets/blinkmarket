// The trader, the RFQ taker. Each tick it settles any fill still in flight, redeems the markets it
// bought into that are FINAL, and otherwise takes one OPEN market it has not traded yet and has a
// view on: post an RFQ for the side its model favours, verify the quotes makers send back, and, if
// the best one leaves the model an edge of at least MIN_EDGE_BPS, approve exactly what it can cost
// and fill it on chain. A market whose spec cannot be read, or that the model has no view on, is
// never traded: there is no valuation to hold a price against. The wallet, registration and API key
// are the runtime's (`onboard`); the TAKER role is joined here, before the first trade.
//
// The platform only relays RFQs and quotes. It never quotes, signs or fills: this agent verifies a
// quote itself and sends the fill itself. An agent outside this repository imports the same names
// from "@blink/client".
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  type Hex,
} from "viem";
import {
  BlinkApiError,
  QuoteVerificationError,
  ROLE,
  agentAbi,
  verifySignedQuote,
} from "@blink/client";
import type { AgentContext } from "../lib/env.ts";
import type { RoleTick } from "../lib/loop.ts";
import { send } from "../lib/session.ts";
import type { PendingFill } from "../lib/state.ts";

const QUANTITY = "10";
/** The model's probability of the side it buys must beat the best quote's price by this much. */
const MIN_EDGE_BPS = 500;
const MAX_RFQ_ATTEMPTS = 3;
const UNIT = 1_000_000n;
/** Market ids this trader has filled, redeemed, and passed on for lack of an edge (`state.acted`). */
const FILLED = "trader.filled";
const REDEEMED = "trader.redeemed";
const PASSED = "trader.passed";

export type TraderOptions = {
  /** Fixes the side; otherwise the model's probability decides (YES from 50%). */
  side?: "YES" | "NO";
  quantity?: string;
  /** Delay between polls of the API and the chain. */
  pollMs?: number;
  /** How long to wait for quotes, for a receipt and for an uncertain fill to settle (it is never resent). */
  waitMs?: { quotes?: number; receipt?: number; settle?: number; grace?: number };
};
type Settings = {
  side: "YES" | "NO" | undefined;
  quantity: string;
  pollMs: number;
  /** `grace`: how long to keep collecting after the first quote, so that a second maker can undercut it. */
  waits: { quotes: number; receipt: number; settle: number; grace: number };
};
type FillResult = { landed: true; txHash: string } | { landed: false; reason: string };

/** `until` ran out of time; the only failure of a poll that means "nothing yet". */
class PollTimeout extends Error {
  constructor(what: string) {
    super(`TIMEOUT waiting for ${what}`);
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isRefusal = (error: unknown, ...codes: string[]) =>
  error instanceof BlinkApiError && codes.includes(error.body.code);
const actedOn = (ctx: AgentContext, action: string) => (ctx.state.data.acted[action] ??= []);

async function until<T>(
  s: Settings,
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new PollTimeout(what);
    await sleep(s.pollMs);
  }
}
/** Chain time, never this machine's clock: quotes expire by block timestamp. */
const chainSeconds = async (ctx: AgentContext) =>
  (await ctx.publicClient.getBlock({ blockTag: "latest" })).timestamp;

const consumedNow = (ctx: AgentContext, digest: Hex) =>
  ctx.publicClient.readContract({
    address: ctx.deployment.generation.markets as Hex,
    abi: agentAbi.markets,
    functionName: "consumed",
    args: [digest],
  });

/** Joins TAKER once; the stake is approved exactly. */
async function ensureTakerRole(ctx: AgentContext) {
  const { generation, shared, params } = ctx.deployment;
  const registry = generation.registry as Hex;
  const held = await ctx.publicClient.readContract({
    address: registry,
    abi: agentAbi.registry,
    functionName: "hasRole",
    args: [ctx.account.address, ROLE.TAKER],
  } as never);
  if (held) return;
  const stake = BigInt(params.minRoleStake);
  await send(ctx, "APPROVE_STAKE", {
    address: shared.busd as Hex,
    abi: agentAbi.usd,
    functionName: "approve",
    args: [registry, stake],
  });
  await send(ctx, "JOIN_TAKER", {
    address: registry,
    abi: agentAbi.registry,
    functionName: "joinRole",
    args: [ROLE.TAKER, stake],
  });
  ctx.log("joined_role", { role: "trader" });
}

/** Claims test bUSD when the balance cannot cover the most one fill can cost. */
async function ensureFunds(ctx: AgentContext, quantity: string) {
  const { shared, params } = ctx.deployment;
  // All shares at nearly a dollar, plus the fee.
  const shares = BigInt(quantity) * UNIT;
  const worstFill = shares + (shares * BigInt(params.feeBps)) / 10_000n;
  const balance = await ctx.publicClient.readContract({
    address: shared.busd as Hex,
    abi: agentAbi.usd,
    functionName: "balanceOf",
    args: [ctx.account.address],
  });
  if (balance >= worstFill) return;
  await send(ctx, "FAUCET_CLAIM", {
    address: shared.faucet as Hex,
    abi: agentAbi.faucet,
    functionName: "claim",
  });
  ctx.log("faucet_claimed");
}

/**
 * Learns whether a fill that was sent landed, and returns only when that is known. A reverted
 * receipt is a definitive miss. Otherwise the transaction may still be pending, so nothing is
 * resent and no replacement RFQ is made until a receipt arrives, `consumed(digest)` shows the
 * fill, or chain time has passed the quote's expiry and the digest is then still unused (a block at
 * or after expiry cannot include the fill).
 */
function awaitFill(ctx: AgentContext, s: Settings, pending: PendingFill): Promise<FillResult> {
  const expiresAt = BigInt(pending.expiresAt);
  return until(s, "the fill's outcome", s.waits.settle, async () => {
    if (pending.txHash !== undefined) {
      const receipt = await ctx.publicClient
        .getTransactionReceipt({ hash: pending.txHash })
        .catch(() => undefined);
      if (receipt)
        return receipt.status === "success"
          ? { landed: true as const, txHash: pending.txHash }
          : { landed: false as const, reason: "FILL_REVERTED" };
    }
    // Chain time first, then the digest: a fill that lands in between is found, and expiry is
    // concluded only when the digest is still unused after the clock has passed it.
    const now = await chainSeconds(ctx);
    if (await consumedNow(ctx, pending.digest))
      return { landed: true as const, txHash: pending.txHash ?? "" };
    return now >= expiresAt
      ? { landed: false as const, reason: "QUOTE_EXPIRED_UNUSED" }
      : undefined;
  });
}

/**
 * Sends one fill and returns only when its outcome is known. The fill is written to the saved state
 * before it is sent, so a crash or a failed tick cannot make a later tick buy again: that tick
 * settles the same record first.
 */
async function sendFill(
  ctx: AgentContext,
  s: Settings,
  marketId: string,
  quote: Record<string, unknown>,
  signature: Hex,
  digest: Hex,
): Promise<FillResult> {
  const pending: PendingFill = { digest, expiresAt: String(quote["expiresAt"]) };
  ctx.state.data.fills[marketId] = pending;
  await ctx.state.save();
  try {
    pending.txHash = await ctx.walletClient.writeContract({
      address: ctx.deployment.generation.markets as Hex,
      abi: agentAbi.markets,
      functionName: "fillQuote",
      args: [quote, signature],
    } as never);
  } catch (error) {
    // The node refused it before broadcasting (the call would revert): nothing is pending.
    if (
      error instanceof BaseError &&
      error.walk((e) => e instanceof ContractFunctionRevertedError)
    )
      return { landed: false, reason: "FILL_REJECTED_BEFORE_SEND" };
    ctx.log("fill_outcome_unknown", { marketId });
    return awaitFill(ctx, s, pending);
  }
  // Outside the try on purpose: a failed save is a failed tick, not an unknown send, and the next
  // tick settles the record from the chain.
  await ctx.state.save();
  try {
    const receipt = await ctx.publicClient.waitForTransactionReceipt({
      hash: pending.txHash,
      timeout: s.waits.receipt,
    });
    return receipt.status === "success"
      ? { landed: true, txHash: pending.txHash }
      : { landed: false, reason: "FILL_REVERTED" };
  } catch {
    ctx.log("fill_outcome_unknown", { marketId });
  }
  return awaitFill(ctx, s, pending);
}

/** Records the end of a fill: the pending record is closed and a landed fill is remembered. */
async function closeFill(ctx: AgentContext, marketId: string, pending: PendingFill, fill: FillResult) {
  delete ctx.state.data.fills[marketId];
  if (fill.landed) actedOn(ctx, FILLED).push(marketId);
  await ctx.state.save();
  if (fill.landed)
    ctx.log("filled", { marketId, digest: pending.digest, txHash: fill.txHash });
  else ctx.log("fill_missed", { marketId, reason: fill.reason });
}

/** A fill left in flight by an earlier tick (or process) is settled before anything else is done. */
async function settlePending(ctx: AgentContext, s: Settings) {
  for (const [marketId, pending] of Object.entries(ctx.state.data.fills))
    await closeFill(ctx, marketId, pending, await awaitFill(ctx, s, pending));
}

/** True when the chain holds no position of this account in the market: nothing is left to redeem. */
async function positionIsEmpty(ctx: AgentContext, marketId: string): Promise<boolean> {
  const [yesShares, noShares] = await ctx.publicClient.readContract({
    address: ctx.deployment.generation.markets as Hex,
    abi: agentAbi.markets,
    functionName: "getPosition",
    args: [BigInt(marketId), ctx.account.address],
  });
  return yesShares === 0n && noShares === 0n;
}

/**
 * Redeems the markets this trader filled that have become FINAL. A redemption deletes the position,
 * so one that landed but was not recorded (a lost answer, a crash before the save) would revert
 * `NoPosition` if sent again and block every later market. The chain is therefore asked first, and
 * asked again when a send fails: an empty position is a completed redemption, recorded and skipped.
 */
async function redeemFinal(ctx: AgentContext) {
  const redeemed = actedOn(ctx, REDEEMED);
  const record = async (marketId: string, fields: Record<string, unknown>) => {
    redeemed.push(marketId);
    await ctx.state.save();
    ctx.log("redeemed", { marketId, ...fields });
  };
  for (const marketId of actedOn(ctx, FILLED).filter((id) => !redeemed.includes(id))) {
    const { market } = await ctx.client.getMarket({ marketId });
    if (market.state !== "FINAL") continue;
    if (await positionIsEmpty(ctx, marketId)) {
      await record(marketId, { alreadyRedeemed: true });
      continue;
    }
    let receipt: Awaited<ReturnType<typeof send>>;
    try {
      receipt = await send(ctx, "REDEEM", {
        address: ctx.deployment.generation.markets as Hex,
        abi: agentAbi.markets,
        functionName: "redeem",
        args: [BigInt(marketId)],
      });
    } catch (error) {
      // The redemption may have landed although this process never learned it.
      if (!(await positionIsEmpty(ctx, marketId).catch(() => false))) throw error;
      await record(marketId, { alreadyRedeemed: true });
      continue;
    }
    let payoutMicros = "0";
    for (const entry of receipt.logs) {
      try {
        const event = decodeEventLog({ abi: agentAbi.markets, ...entry });
        if (event.eventName === "PositionRedeemed") payoutMicros = event.args.payout.toString();
      } catch {
        // Not an event of the markets ABI.
      }
    }
    await record(marketId, {
      txHash: receipt.transactionHash,
      finalOutcome: market.finalOutcome ?? "INVALID",
      payoutMicros,
    });
  }
}

/** RFQ, verify, approve, fill, on the first OPEN market not traded yet. A quote that expires or is taken first is replaced. */
async function tradeOne(ctx: AgentContext, s: Settings) {
  const { client, publicClient } = ctx;
  const { params } = ctx.deployment;
  const markets = ctx.deployment.generation.markets as Hex;
  const address = ctx.account.address.toLowerCase();
  const filled = actedOn(ctx, FILLED);
  const now = Number(await chainSeconds(ctx));
  const passed = actedOn(ctx, PASSED);
  const page = await client.listMarkets({ state: "OPEN", limit: 100 });
  // The first open market that is not done with, whose spec can be read and that the model has a
  // view on. Without a view there is no price to hold a quote against, so it is not traded.
  let chosen: { marketId: string; probabilityBps: number } | undefined;
  for (const { market: m, spec } of page.items) {
    if (m.closeAt <= now || filled.includes(m.marketId) || passed.includes(m.marketId)) continue;
    if (!spec.ok) continue;
    const probabilityBps = await ctx.model.probabilityBps({
      marketId: BigInt(m.marketId),
      specHash: m.specHash as Hex,
      spec: spec.spec,
    });
    if (probabilityBps === null) continue;
    chosen = { marketId: m.marketId, probabilityBps };
    break;
  }
  if (!chosen) return;
  await ensureTakerRole(ctx);
  await ensureFunds(ctx, s.quantity);
  const { market } = await client.getMarket({ marketId: chosen.marketId });
  const marketId = market.marketId;
  const view = chosen.probabilityBps;
  const side = s.side ?? (view >= 5000 ? "YES" : "NO");
  // What the model thinks the shares it buys are worth.
  const worthBps = side === "YES" ? view : 10_000 - view;
  ctx.log("trading", { marketId, side });

  for (let attempt = 1; ; attempt++) {
    if (attempt > MAX_RFQ_ATTEMPTS) throw new Error("NO_USABLE_QUOTE");
    let rfq: Awaited<ReturnType<typeof client.createRfq>>;
    try {
      rfq = await client.createRfq({ marketId, side, quantity: s.quantity });
    } catch (error) {
      // The TAKER role may not be indexed yet: the next tick tries again.
      if (isRefusal(error, "ROLE_REQUIRED")) return;
      throw error;
    }
    ctx.log("rfq_posted", { rfqId: rfq.rfqId });
    const verifyAll = async (minValiditySeconds?: bigint) => {
      const blockTime = await chainSeconds(ctx);
      const verified = [];
      for (const { quote, signature } of (await client.listQuotes(rfq.rfqId)).items) {
        try {
          verified.push({
            quote,
            signature: signature as Hex,
            ...(await verifySignedQuote(quote, signature as Hex, {
              publicClient,
              deployment: ctx.deployment,
              market,
              rfq: { marketId, side, quantity: s.quantity, taker: address },
              now: blockTime,
              feeBps: params.feeBps,
              minValiditySeconds,
            })),
          });
        } catch (error) {
          if (!(error instanceof QuoteVerificationError)) throw error;
          ctx.log("quote_ignored", { maker: quote.maker, code: error.code });
        }
      }
      return verified;
    };
    // Quotes arrive while the RFQ is open (30 seconds); the API lists them cheapest first.
    // Only running out of time means "no quote": a refusal of the API (429, INDEX_STALE) or a node
    // error goes to the loop, which backs off instead of posting more RFQs.
    let best = await until(s, "a verified quote", s.waits.quotes, async () => (await verifyAll())[0]).catch(
      (error: unknown) => {
        if (error instanceof PollTimeout) return undefined;
        throw error;
      },
    );
    if (!best) continue;
    // Give the other makers a moment to undercut the first quote, then take the cheapest still good.
    await sleep(s.waits.grace);
    best = (await verifyAll())[0] ?? best;
    if (worthBps - Number(best.quote.priceBps) < MIN_EDGE_BPS) {
      // ponytail: a market passed on is not looked at again; re-quote later if prices should be revisited.
      passed.push(marketId);
      await ctx.state.save();
      ctx.log("no_edge", { marketId, priceBps: best.quote.priceBps, worthBps });
      return;
    }
    // The approval covers the cost and the fee, never more.
    await send(ctx, "APPROVE_FILL", {
      address: ctx.deployment.shared.busd as Hex,
      abi: agentAbi.usd,
      functionName: "approve",
      args: [markets, best.maxCost],
    });
    // The quote must still be usable and unused now that the approval has landed.
    const stillGood = (await verifyAll(1n)).find((v) => v.digest === best.digest);
    if (!stillGood || (await consumedNow(ctx, best.digest))) continue;
    const q = best.quote;
    ctx.log("fill_sent", { marketId, side, quantity: s.quantity, priceBps: q.priceBps });
    const fill = await sendFill(
      ctx,
      s,
      marketId,
      {
        marketId: BigInt(q.marketId),
        specHash: q.specHash as Hex,
        maker: q.maker as Hex,
        taker: q.taker as Hex,
        side: Number(q.side),
        quantity: BigInt(q.quantity),
        priceBps: Number(q.priceBps),
        validAfter: BigInt(q.validAfter),
        expiresAt: BigInt(q.expiresAt),
        nonce: BigInt(q.nonce),
        epoch: BigInt(q.epoch),
      },
      best.signature,
      best.digest,
    );
    await closeFill(ctx, marketId, ctx.state.data.fills[marketId]!, fill);
    if (fill.landed) return;
  }
}

/** A trader with its own waits and sides, for tests; `trader` below is the default one. */
export function createTrader(options: TraderOptions = {}): RoleTick {
  const s: Settings = {
    side: options.side,
    quantity: options.quantity ?? QUANTITY,
    pollMs: options.pollMs ?? 1000,
    waits: {
      quotes: options.waitMs?.quotes ?? 20_000,
      receipt: options.waitMs?.receipt ?? 180_000,
      settle: options.waitMs?.settle ?? 180_000,
      grace: options.waitMs?.grace ?? 2 * (options.pollMs ?? 1000),
    },
  };
  return async (ctx) => {
    await settlePending(ctx, s);
    await redeemFinal(ctx);
    await tradeOne(ctx, s);
  };
}

export const trader: RoleTick = createTrader();
