// The maker. It deposits a working balance once, then answers every open RFQ in a market where its
// model has a view with a signed quote: the model's probability for the RFQ's side, plus a fixed
// half-spread, living 30 seconds. The platform only relays the quote; the taker verifies and fills it.
// On shutdown `makerStop` raises the maker epoch, which voids every quote still out.
import { randomBytes } from "node:crypto";
import { type Hex } from "viem";
import { BlinkApiError, agentAbi, quoteTypedData } from "@blink/client";
import type { AgentContext } from "../lib/env.ts";
import type { RoleTick } from "../lib/loop.ts";
import { send } from "../lib/session.ts";

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

async function ensureDeposit(ctx: AgentContext) {
  const deposited = actedOn(ctx, DEPOSITED);
  if (deposited.length > 0) return;
  await send(ctx, "APPROVE_DEPOSIT", {
    address: ctx.deployment.shared.busd as Hex,
    abi: agentAbi.usd,
    functionName: "approve",
    args: [markets(ctx), WORKING_BALANCE_MICROS],
  });
  await send(ctx, "DEPOSIT_MAKER", {
    address: markets(ctx),
    abi: agentAbi.markets,
    functionName: "depositMaker",
    args: [WORKING_BALANCE_MICROS],
  });
  deposited.push(WORKING_BALANCE_MICROS.toString());
  await ctx.state.save();
  ctx.log("deposited", { micros: WORKING_BALANCE_MICROS.toString() });
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
