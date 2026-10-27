// The challenger. It objects to a market in its creation window when its model finds a ground, and
// challenges a proposed result when its model computes a different outcome or when the proposal's
// evidence bytes cannot be fetched from `/v1/content` (an unsupported proposal). The CHALLENGER
// role is joined by `onboard`. Safety does not depend on this agent being online.
//
// An agent outside this repository imports the same names from "@blink/client".
import { CREATION_GROUND, OUTCOME, ROLE, agentAbi } from "@blink/client";
import type { AgentContext } from "../lib/env.ts";
import type { RoleTick } from "../lib/loop.ts";
import {
  actedOn,
  approveBond,
  attempt,
  bondOf,
  chainSeconds,
  evidenceAvailable,
  listAll,
  resolutionAddress,
  uploadEvidence,
  viewOf,
} from "../lib/resolution.ts";

/** Market ids this challenger has acted on (`state.acted`). */
const CHALLENGED = "challenger.challenged";
/** Another challenger got there first, or the window closed between the read and the send. */
const LOST = ["InvalidState", "DeadlineViolation"];

const utf8 = (text: string) => new TextEncoder().encode(text);

async function challenge(
  ctx: AgentContext,
  marketId: string,
  maxPairs: string,
  functionName: "challengeCreation" | "challengeResult",
  args: readonly unknown[],
) {
  await approveBond(ctx, await bondOf(ctx, ROLE.CHALLENGER, ctx.deployment.params.challengeBondBps, maxPairs));
  const fields = { marketId };
  const done = await attempt(
    ctx,
    functionName === "challengeCreation" ? "CHALLENGE_CREATION" : "CHALLENGE_RESULT",
    { address: resolutionAddress(ctx), abi: agentAbi.resolution, functionName, args } as never,
    LOST,
    fields,
  );
  actedOn(ctx, CHALLENGED).push(marketId);
  await ctx.state.save();
  if (done) ctx.log("challenged", { ...fields, kind: functionName === "challengeCreation" ? "CREATION" : "RESULT" });
}

async function objectToCreations(ctx: AgentContext, now: number) {
  const done = actedOn(ctx, CHALLENGED);
  for (const item of await listAll(ctx, "PENDING")) {
    const { market } = item;
    if (market.creationChallenged || now >= market.openAt || done.includes(market.marketId)) continue;
    if (market.creator.toLowerCase() === ctx.account.address.toLowerCase()) continue;
    const view = viewOf(item);
    const objection = view && (await ctx.model.creationObjection(view));
    if (!objection) continue;
    const evidenceHash = await uploadEvidence(ctx, objection.evidence);
    await challenge(ctx, market.marketId, market.maxPairs, "challengeCreation", [
      BigInt(market.marketId),
      CREATION_GROUND[objection.ground],
      evidenceHash,
    ]);
  }
}

async function challengeResults(ctx: AgentContext, now: number) {
  const done = actedOn(ctx, CHALLENGED);
  for (const item of await listAll(ctx, "PROPOSED")) {
    const { market } = item;
    if (done.includes(market.marketId)) continue;
    const { proposal } = await ctx.client.getMarket({ marketId: market.marketId });
    if (!proposal || now >= proposal.challengeEnd) continue;
    if (proposal.proposer.toLowerCase() === ctx.account.address.toLowerCase()) continue;
    let evidence: Uint8Array | null = null;
    if (!(await evidenceAvailable(ctx, proposal.evidenceHash))) {
      evidence = utf8(JSON.stringify({ reason: "EVIDENCE_UNAVAILABLE", evidenceHash: proposal.evidenceHash }));
    } else {
      const view = viewOf(item);
      const answer = view && (await ctx.model.outcome(view));
      if (answer && OUTCOME[answer.outcome] !== OUTCOME[proposal.outcome as "YES" | "NO"]) evidence = answer.evidence;
    }
    if (evidence === null) continue;
    await challenge(ctx, market.marketId, market.maxPairs, "challengeResult", [
      BigInt(market.marketId),
      await uploadEvidence(ctx, evidence),
    ]);
  }
}

export const challenger: RoleTick = async (ctx) => {
  const now = await chainSeconds(ctx);
  await objectToCreations(ctx, now);
  await challengeResults(ctx, now);
};
