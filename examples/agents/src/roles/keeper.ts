// The keeper. Every state change after a deadline is permissionless, so each tick it looks at the
// markets and calls whichever transition is due: open a market after its creation window, finalize
// an unchallenged proposal or a market past its hard deadline, settle a dispute round and finalize
// a dispute, distribute the fees of a FINAL market, and anchor a forecast window's root nobody has.
// Several keepers may run at once; one that loses a race to another logs `raced` and goes on.
//
// The platform never does any of this. An agent outside this repository imports the same names
// from "@blink/client".
import type { Hex } from "viem";
import { agentAbi } from "@blink/client";
import type { AgentContext } from "../lib/env.ts";
import type { RoleTick } from "../lib/loop.ts";
import {
  actedOn,
  attempt,
  chainSeconds,
  listAll,
  readDispute,
  resolutionAddress,
  type MarketItem,
} from "../lib/resolution.ts";

/** Reverts that mean another keeper moved the market first. */
const LOST = ["InvalidState", "AlreadySettled", "AlreadyDistributed", "AlreadyAnchored"] as const;
/** Forecast windows of a FINAL market whose roots are all handled; the worker stores a root a little after the deadline. */
const ANCHORS_DONE = "keeper.anchorsDone";
const ROOT_GRACE_SECONDS = 300;
const WINDOW_PAGE = 100;

type Market = MarketItem["market"];

/** One BlinkResolution transition; logged under the lower-case name of `what` when it is this keeper's. */
async function resolve(
  ctx: AgentContext,
  what: string,
  functionName: string,
  args: readonly unknown[],
  fields: Record<string, unknown>,
) {
  const done = await attempt(
    ctx,
    what,
    { address: resolutionAddress(ctx), abi: agentAbi.resolution, functionName, args } as never,
    LOST,
    fields,
  );
  if (done) ctx.log(what.toLowerCase(), fields);
}

const markets = (ctx: AgentContext) => ctx.deployment.generation.markets as Hex;

/** The round of each open dispute of the market: settle it once revealing is over, finalize it once appealing is over. */
async function driveDisputes(ctx: AgentContext, market: Market, now: number) {
  const { items } = await ctx.client.listDisputes({ marketId: market.marketId }, { limit: 100 });
  for (const { disputeId, settled } of items) {
    if (settled) continue;
    const { round } = await readDispute(ctx, BigInt(disputeId));
    const fields = { marketId: market.marketId, disputeId };
    if (!round.settled && now >= Number(round.revealEnd))
      await resolve(ctx, "SETTLE_ROUND", "settleRound", [BigInt(disputeId)], fields);
    else if (round.settled && !round.restarted && now >= Number(round.appealEnd))
      await resolve(ctx, "FINALIZE_DISPUTE", "finalizeDispute", [BigInt(disputeId)], fields);
  }
}

async function advance(ctx: AgentContext, market: Market, now: number) {
  const marketId = BigInt(market.marketId);
  const fields = { marketId: market.marketId };
  if (now >= market.hardDeadline)
    return void (await resolve(ctx, "FINALIZE_TIMEOUT", "finalizeTimeout", [marketId], fields));
  if (market.state === "PENDING") {
    if (market.creationChallenged) return driveDisputes(ctx, market, now);
    if (now >= market.openAt) {
      const opened = await attempt(
        ctx,
        "OPEN",
        { address: markets(ctx), abi: agentAbi.markets, functionName: "open", args: [marketId] },
        LOST,
        fields,
      );
      if (opened) ctx.log("open", fields);
    }
  } else if (market.state === "PROPOSED") {
    const { proposal } = await ctx.client.getMarket({ marketId: market.marketId });
    if (proposal && now >= proposal.challengeEnd)
      await resolve(ctx, "FINALIZE_UNCHALLENGED", "finalizeUnchallenged", [marketId], fields);
  } else if (market.state === "DISPUTED") {
    await driveDisputes(ctx, market, now);
  }
}

/** Anchors every closed window root of the market that BlinkAnchor does not hold yet; true when nothing is left to do for good. */
async function anchorRoots(ctx: AgentContext, market: Market, now: number): Promise<boolean> {
  const anchor = ctx.deployment.shared.anchor as Hex;
  let settledForGood = true;
  let cursor: string | undefined;
  do {
    const page = await ctx.client.listForecastWindows(
      { marketId: market.marketId },
      { limit: WINDOW_PAGE, ...(cursor ? { cursor } : {}) },
    );
    for (const window of page.items) {
      if (window.status !== "CLOSED" || now < window.deadline + ROOT_GRACE_SECONDS) settledForGood = false;
      if (window.root === null) continue;
      const root = window.root as Hex;
      const at = await ctx.publicClient.readContract({
        address: anchor,
        abi: agentAbi.anchor,
        functionName: "anchoredAt",
        args: [root],
      });
      if (at !== 0n) continue;
      const fields = { marketId: market.marketId, windowId: window.windowId, root };
      const anchored = await attempt(
        ctx,
        "ANCHOR",
        { address: anchor, abi: agentAbi.anchor, functionName: "anchor", args: [root] },
        LOST,
        fields,
      );
      if (anchored) ctx.log("anchor", fields);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return settledForGood;
}

async function distributeFees(ctx: AgentContext, market: Market) {
  if (market.feesDistributed) return;
  const fields = { marketId: market.marketId };
  const done = await attempt(
    ctx,
    "DISTRIBUTE_FEES",
    { address: markets(ctx), abi: agentAbi.markets, functionName: "distributeFees", args: [BigInt(market.marketId)] },
    LOST,
    fields,
  );
  if (done) ctx.log("distribute_fees", fields);
}

export const keeper: RoleTick = async (ctx) => {
  const now = await chainSeconds(ctx);
  const anchored = actedOn(ctx, ANCHORS_DONE);
  for (const state of ["PENDING", "OPEN", "PROPOSED", "DISPUTED", "FINAL"] as const)
    for (const { market } of await listAll(ctx, state)) {
      if (state === "FINAL") await distributeFees(ctx, market);
      else await advance(ctx, market, now);
      if (state !== "PENDING" && !anchored.includes(market.marketId))
        if ((await anchorRoots(ctx, market, now)) && state === "FINAL") {
          anchored.push(market.marketId);
          await ctx.state.save();
        }
    }
};
