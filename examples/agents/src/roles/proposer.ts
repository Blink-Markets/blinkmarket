// The proposer. After a market closes it proposes the outcome its model computes, with the evidence
// bytes archived in the content store, and posts the bond. When a dispute round goes against its
// proposal it appeals if its model says so (once per dispute). The PROPOSER role is joined by
// `onboard`.
//
// The platform only stores the evidence; it never proposes. An agent outside this repository
// imports the same names from "@blink/client".
import { OUTCOME, ROLE, agentAbi } from "@blink/client";
import type { AgentContext } from "../lib/env.ts";
import type { RoleTick } from "../lib/loop.ts";
import {
  actedOn,
  approveBond,
  attempt,
  bondOf,
  chainSeconds,
  listAll,
  readDispute,
  resolutionAddress,
  uploadEvidence,
  viewOf,
} from "../lib/resolution.ts";

/** Market ids this proposer has proposed on, and dispute ids it has appealed (`state.acted`). */
const PROPOSED = "proposer.proposed";
const APPEALED = "proposer.appealed";
const APPEAL_INTENT = "proposer.appeal-intent";

async function proposeDue(ctx: AgentContext, now: number) {
  const proposed = actedOn(ctx, PROPOSED);
  for (const item of await listAll(ctx, "OPEN")) {
    const { market } = item;
    // An OPEN market has no proposal: proposing moves it to PROPOSED.
    if (now < market.closeAt || now >= market.proposalDeadline || proposed.includes(market.marketId)) continue;
    const view = viewOf(item);
    const answer = view && (await ctx.model.outcome(view));
    if (!answer) continue;
    const evidenceHash = await uploadEvidence(ctx, answer.evidence);
    await approveBond(ctx, await bondOf(ctx, ROLE.PROPOSER, ctx.deployment.params.proposerBondBps, market.maxPairs));
    const fields = { marketId: market.marketId };
    const done = await attempt(
      ctx,
      "PROPOSE",
      {
        address: resolutionAddress(ctx),
        abi: agentAbi.resolution,
        functionName: "propose",
        args: [BigInt(market.marketId), OUTCOME[answer.outcome], evidenceHash, `/v1/content/${evidenceHash}`],
      },
      ["InvalidState"],
      fields,
    );
    // Lost to another proposer or not, this market is not this agent's to propose on again.
    proposed.push(market.marketId);
    await ctx.state.save();
    if (done) ctx.log("proposed", { ...fields, outcome: answer.outcome, evidenceHash });
  }
}

/** Appeals a settled round that went against this agent's proposal, once per dispute, while the appeal window is open. */
async function appealLost(ctx: AgentContext, now: number) {
  const appealed = actedOn(ctx, APPEALED);
  const { params } = ctx.deployment;
  for (const item of await listAll(ctx, "DISPUTED")) {
    const { market } = item;
    const { proposal } = await ctx.client.getMarket({ marketId: market.marketId });
    if (!proposal || proposal.proposer.toLowerCase() !== ctx.account.address.toLowerCase()) continue;
    const view = viewOf(item);
    for (const dispute of (await ctx.client.listDisputes({ marketId: market.marketId }, { limit: 100 })).items) {
      if (dispute.kind !== "RESULT" || dispute.settled || appealed.includes(dispute.disputeId)) continue;
      const intents = actedOn(ctx, APPEAL_INTENT);
      const existing = intents.map((value) => JSON.parse(value) as { disputeId: string; nonce: number }).find((value) => value.disputeId === dispute.disputeId);
      const nonce = existing && await ctx.publicClient.getTransactionCount({ address: ctx.account.address, blockTag: "latest" });
      const events = await ctx.publicClient.getContractEvents({
        address: resolutionAddress(ctx), abi: agentAbi.resolution, eventName: "Appealed",
        args: { disputeId: BigInt(dispute.disputeId), appellant: ctx.account.address }, fromBlock: BigInt(ctx.deployment.startBlock),
      });
      if (events.length) {
        appealed.push(dispute.disputeId);
        ctx.state.data.acted[APPEAL_INTENT] = intents.filter((value) => JSON.parse(value).disputeId !== dispute.disputeId);
        await ctx.state.save();
        continue;
      }
      if (existing && nonce! <= existing.nonce) {
        try {
          await ctx.walletClient.writeContract({ address: resolutionAddress(ctx), abi: agentAbi.resolution,
            functionName: "appeal", args: [BigInt(dispute.disputeId)], nonce: existing.nonce, gas: 1_000_000n });
        } catch (error) {
          if (!/already known|underpriced|nonce too low|nonce provided .* is lower/i.test(String(error))) throw error;
        }
        continue;
      }
      if (existing) {
        ctx.state.data.acted[APPEAL_INTENT] = intents.filter((value) => JSON.parse(value).disputeId !== dispute.disputeId);
        await ctx.state.save();
      }
      const { dispute: d, round } = await readDispute(ctx, BigInt(dispute.disputeId));
      // Lost: the settled round did not lead with the proposed outcome. Restarted rounds are not settled results.
      if (!round.settled || round.restarted || round.leadingChoice === OUTCOME[proposal.outcome]) continue;
      if (now >= Number(round.appealEnd) || d.appealRound + 1 >= params.maxRounds) continue;
      // An appeal starts a round that must still end before the market's hard deadline.
      if (now + params.commitSeconds + params.revealSeconds >= market.hardDeadline) continue;
      if (!view || !(await ctx.model.appeal(view))) continue;
      await approveBond(ctx, d.lastBond * 2n);
      const fields = { marketId: market.marketId, disputeId: dispute.disputeId };
      // A saved intent prevents another appeal while its transaction may still be pending.
      const appealNonce = await ctx.publicClient.getTransactionCount({ address: ctx.account.address, blockTag: "pending" });
      actedOn(ctx, APPEAL_INTENT).push(JSON.stringify({ disputeId: dispute.disputeId, nonce: appealNonce }));
      await ctx.state.save();
      const done = await attempt(
        ctx,
        "APPEAL",
        {
          address: resolutionAddress(ctx),
          abi: agentAbi.resolution,
          functionName: "appeal",
          args: [BigInt(dispute.disputeId)],
          nonce: appealNonce,
        },
        ["InvalidState", "DeadlineViolation"],
        fields,
      );
      appealed.push(dispute.disputeId);
      ctx.state.data.acted[APPEAL_INTENT] = actedOn(ctx, APPEAL_INTENT).filter((value) => JSON.parse(value).disputeId !== dispute.disputeId);
      await ctx.state.save();
      if (done) ctx.log("appealed", { ...fields, bond: (d.lastBond * 2n).toString() });
    }
  }
}

export const proposer: RoleTick = async (ctx) => {
  const now = await chainSeconds(ctx);
  await appealLost(ctx, now);
  await proposeDue(ctx, now);
};
