// The maker. It deposits a working balance once (by a saved nonce, so a deposit cannot land twice), then answers every open RFQ in a market where its
// model has a view with a signed quote: the model's probability for the RFQ's side, plus a fixed
// half-spread, living 30 seconds. The platform only relays the quote; the taker verifies and fills it.
// On shutdown `makerStop` raises the maker epoch, which voids every quote still out.
import { randomBytes } from "node:crypto";
import { type Hex } from "viem";
import { BlinkApiError, agentAbi, quoteTypedData } from "@blink/client";
import type { AgentContext } from "../lib/env.ts";
import type { RoleTick } from "../lib/loop.ts";
import { send } from "../lib/session.ts";
import { redeemFinal } from "./trader.ts";

const WORKING_BALANCE_MICROS = 100_000_000n;
const HALF_SPREAD_BPS = 300;
const QUOTE_LIFETIME_SECONDS = 30n;
/** A quote with less than this left before the market closes is not worth posting. */
const MIN_LIFETIME_SECONDS = 10n;
const DEPOSITED = "maker.deposited";
/** The RFQs this process has dealt with: the relay holds one quote per maker per RFQ. */
const answered = new WeakMap<AgentContext, Set<string>>();

const actedOn = (ctx: AgentContext, action: string) => (ctx.state.data.acted[action] ??= []);
const markets = (ctx: AgentContext) => ctx.deployment.generation.markets as Hex;

/** True when the chain holds a deposit of this maker: the one working balance is deposited once, ever. */
async function depositOnChain(ctx: AgentContext): Promise<boolean> {
  const events = await ctx.publicClient.getContractEvents({
    address: markets(ctx),
    abi: agentAbi.markets,
    eventName: "MakerDeposited",
    args: { maker: ctx.account.address },
    fromBlock: BigInt(ctx.deployment.startBlock),
  } as never);
  return events.length > 0;
}

/** Where the deposit attempt is saved (`state.acted`, one JSON string): the nonce it was given and its hash. */
const DEPOSIT_ATTEMPT = "maker.deposit-attempt";
type Attempt = { nonce: number; hash?: Hex };
const RECEIPT_TIMEOUT_MS = 180_000;
const NONCE_POLL_MS = 500;
const DEPOSIT_GAS = 500_000n;
/** What a node says when a send repeats one that is still in its pool. */
const ALREADY_IN_POOL = /already known|underpriced|nonce too low|nonce provided .* is lower/i;

const readAttempt = (ctx: AgentContext): Attempt | undefined => {
  const raw = actedOn(ctx, DEPOSIT_ATTEMPT)[0];
  return raw === undefined ? undefined : (JSON.parse(raw) as Attempt);
};
async function saveAttempt(ctx: AgentContext, attempt: Attempt | undefined) {
  ctx.state.data.acted[DEPOSIT_ATTEMPT] = attempt === undefined ? [] : [JSON.stringify(attempt)];
  await ctx.state.save();
}
const nonceAt = (ctx: AgentContext, blockTag: "latest" | "pending") =>
  ctx.publicClient.getTransactionCount({ address: ctx.account.address, blockTag });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Deposits the working balance once, by nonce. The deposit is sent with a nonce that is saved
 * first, so an unresolved send (a lost answer, a receipt that never came) is repeated with that same
 * nonce and can land at most once; a fresh nonce is used only after the saved one is mined by
 * something that was not the deposit. Every tick asks the chain for the `MakerDeposited` event first.
 */
async function ensureDeposit(ctx: AgentContext) {
  const deposited = actedOn(ctx, DEPOSITED);
  if (deposited.length > 0) return;
  let attempt = readAttempt(ctx);
  // The nonce is read before the event, so a deposit that mines in between is seen as an event.
  const mined = attempt === undefined ? false : (await nonceAt(ctx, "latest")) > attempt.nonce;
  if (await depositOnChain(ctx)) {
    deposited.push(WORKING_BALANCE_MICROS.toString());
    await saveAttempt(ctx, undefined);
    ctx.log("deposit_reconciled", { attempted: attempt !== undefined });
    return;
  }
  if (attempt && mined) {
    // The nonce is used and there is no deposit: the slot went to another transaction (or the deposit reverted).
    ctx.log("deposit_attempt_dropped", { nonce: attempt.nonce });
    await saveAttempt(ctx, undefined);
    attempt = undefined;
  }
  if (!attempt) {
    // The approval is mined before the nonce is read, so it can never take the deposit's nonce.
    await send(ctx, "APPROVE_DEPOSIT", {
      address: ctx.deployment.shared.busd as Hex,
      abi: agentAbi.usd,
      functionName: "approve",
      args: [markets(ctx), WORKING_BALANCE_MICROS],
    });
    attempt = { nonce: await nonceAt(ctx, "pending") };
    await saveAttempt(ctx, attempt);
  }
  try {
    const hash = await ctx.walletClient.writeContract({
      address: markets(ctx),
      abi: agentAbi.markets,
      functionName: "depositMaker",
      args: [WORKING_BALANCE_MICROS],
      nonce: attempt.nonce,
      // Fixed, so that no estimate is made: against the pool, a repeat would be simulated after the
      // deposit it repeats (the allowance already spent) and refused before it could be matched by nonce.
      gas: DEPOSIT_GAS,
    } as never);
    attempt = { ...attempt, hash };
    await saveAttempt(ctx, attempt);
  } catch (error) {
    // An earlier send with this nonce is still in the pool: wait for it instead of failing.
    if (!ALREADY_IN_POOL.test(String((error as Error).message))) throw error;
  }
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while ((await nonceAt(ctx, "latest")) <= attempt.nonce) {
    if (Date.now() >= deadline) throw new Error("DEPOSIT_PENDING");
    await sleep(NONCE_POLL_MS);
  }
  if (!(await depositOnChain(ctx))) {
    await saveAttempt(ctx, undefined);
    throw new Error("DEPOSIT_FAILED");
  }
  deposited.push(WORKING_BALANCE_MICROS.toString());
  await saveAttempt(ctx, undefined);
  ctx.log("deposited", { micros: WORKING_BALANCE_MICROS.toString(), ...(attempt.hash ? { txHash: attempt.hash } : {}) });
}

type Rfq = Awaited<ReturnType<AgentContext["client"]["listRfqs"]>>["items"][number];

/** Signs and posts a quote for the RFQ, or says why not (the reason is logged). */
async function quote(ctx: AgentContext, rfq: Rfq): Promise<string> {
  const detail = await ctx.client.getMarket({ marketId: rfq.marketId });
  if (!detail.spec.ok) return "UNREADABLE_SPEC";
  const probabilityBps = await ctx.model.probabilityBps({
    marketId: BigInt(rfq.marketId),
    specHash: rfq.specHash as Hex,
    spec: detail.spec.spec,
  });
  if (probabilityBps === null) return "NO_VIEW";
  const now = (await ctx.publicClient.getBlock({ blockTag: "latest" })).timestamp;
  const expiresAt = [now + QUOTE_LIFETIME_SECONDS, BigInt(detail.market.closeAt)].reduce((a, b) => (b < a ? b : a));
  if (expiresAt - now < MIN_LIFETIME_SECONDS) return "CLOSING";
  // The price is the taker's price for the side it asked for: our probability of that side, plus the spread.
  const sideBps = rfq.side === "YES" ? probabilityBps : 10_000 - probabilityBps;
  const priceBps = Math.min(9999, Math.max(1, sideBps + HALF_SPREAD_BPS));
  const epoch = await ctx.publicClient.readContract({
    address: markets(ctx),
    abi: agentAbi.markets,
    functionName: "makerEpoch",
    args: [ctx.account.address],
  });
  const fields = {
    marketId: rfq.marketId,
    specHash: rfq.specHash,
    maker: ctx.account.address,
    taker: rfq.taker,
    side: rfq.side === "YES" ? ("0" as const) : ("1" as const),
    quantity: rfq.quantity,
    priceBps: String(priceBps),
    validAfter: now.toString(),
    expiresAt: expiresAt.toString(),
    nonce: BigInt("0x" + randomBytes(16).toString("hex")).toString(),
    epoch: epoch.toString(),
  };
  const signature = await ctx.walletClient.signTypedData(quoteTypedData(fields, ctx.deployment));
  await ctx.client.postQuote(rfq.rfqId, { quote: fields, signature });
  ctx.log("quote_posted", { rfqId: rfq.rfqId, marketId: rfq.marketId, side: rfq.side, priceBps });
  return "";
}

export const maker: RoleTick = async (ctx) => {
  await ensureDeposit(ctx);
  const fills = await ctx.publicClient.getContractEvents({
    address: markets(ctx), abi: agentAbi.markets, eventName: "QuoteFilled", fromBlock: BigInt(ctx.deployment.startBlock),
  });
  const filled = [...new Set(fills.filter((fill) => fill.args.maker?.toLowerCase() === ctx.account.address.toLowerCase()).map((fill) => fill.args.marketId!.toString()))];
  await redeemFinal(ctx, filled, "maker.redeemed");
  const seen = answered.get(ctx) ?? new Set<string>();
  answered.set(ctx, seen);
  for (const rfq of (await ctx.client.listRfqs()).items) {
    if (seen.has(rfq.rfqId)) continue;
    let skipped: string;
    try {
      skipped = await quote(ctx, rfq);
    } catch (error) {
      // Another quote of ours is there already, or the RFQ ended while we priced it: not a failure.
      if (!(error instanceof BlinkApiError && error.status === 409 && ["QUOTE_ALREADY_POSTED", "RFQ_CLOSED"].includes(error.body.code)))
        throw error;
      skipped = error.body.code;
    }
    seen.add(rfq.rfqId);
    if (skipped) ctx.log("quote_skipped", { rfqId: rfq.rfqId, marketId: rfq.marketId, reason: skipped });
  }
};

/** Raises the maker epoch so that every quote still out is void; `main` calls it after SIGTERM. */
export async function makerStop(ctx: AgentContext) {
  await send(ctx, "INCREMENT_MAKER_EPOCH", {
    address: markets(ctx),
    abi: agentAbi.markets,
    functionName: "incrementMakerEpoch",
  });
  ctx.log("maker_epoch_raised");
}
