// The juror. In every dispute round open for commitments where it is not conflicted it commits a
// vote, reveals it when the reveal phase opens, and after the dispute is final settles the votes
// and claims its rewards. The JUROR role and its stake are the runtime's (`onboard`).
//
// A vote is a commitment to (choice, salt). The salt and the choice are written to the saved state
// BEFORE the commit transaction is sent, so a restart still reveals what was committed. A commit
// whose answer was lost is treated like the trader's uncertain fill: the next tick asks the chain
// for the commitment (the VoteCommitted event) before it commits again, and never commits twice in
// one round.
//
// A creation dispute is voted 1 (upheld) iff the model objects. A result dispute is voted with the
// model's outcome; a proposal whose evidence bytes cannot be fetched from `/v1/content` is
// unsupported and is voted against (the archived-bytes rule). An agent outside this repository
// imports the same names from "@blink/client".
import { randomBytes } from "node:crypto";
import { bytesToHex, type Hex } from "viem";
import { OUTCOME, agentAbi, voteCommitment } from "@blink/client";
import type { AgentContext } from "../lib/env.ts";
import type { RoleTick } from "../lib/loop.ts";
import {
  actedOn,
  chainSeconds,
  evidenceAvailable,
  listAll,
  readDispute,
  isRevert,
  resolutionAddress,
  revertName,
  viewOf,
  type MarketItem,
} from "../lib/resolution.ts";
import { send } from "../lib/session.ts";

// `state.acted` lists of "<disputeId>:<round>" keys, and of dispute ids once rewards are claimed.
const COMMITTED = "juror.committed";
const REVEALED = "juror.revealed";
const SETTLED = "juror.settled";
const SKIPPED = "juror.skipped";
const CLAIMED = "juror.claimed";
/** Dispute ids whose claim the chain refused for certain; never tried again. */
const CLAIM_BLOCKED = "juror.claimBlocked";
/** Reverts of `commitVote` that say this juror may not vote in this round. */
const NOT_ELIGIBLE = ["ConflictedJuror", "InsufficientCredit", "NoWeight", "DeadlineViolation"];

type Dispute = Awaited<ReturnType<AgentContext["client"]["listDisputes"]>>["items"][number];

const key = (disputeId: bigint | string, round: bigint | number) => `${disputeId}:${round}`;
/** `state.salts[...]` holds "<choice>:<salt>" under this key. */
const saltKey = (voteKey: string) => `juror:${voteKey}`;
const parseKey = (voteKey: string) => {
  const [disputeId, round] = voteKey.split(":") as [string, string];
  return { disputeId: BigInt(disputeId), round: BigInt(round) };
};
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const resolutionCall = (ctx: AgentContext, functionName: string, args: readonly unknown[]) =>
  ({ address: resolutionAddress(ctx), abi: agentAbi.resolution, functionName, args }) as never;

/** True when the chain holds an event of this juror: its commitment or its reveal. */
async function eventSeen(
  ctx: AgentContext,
  eventName: "VoteCommitted" | "VoteRevealed",
  disputeId: bigint,
  round: bigint,
) {
  const logs = await ctx.publicClient.getContractEvents({
    address: resolutionAddress(ctx),
    abi: agentAbi.resolution,
    eventName,
    args: { disputeId, round, juror: ctx.account.address },
    fromBlock: BigInt(ctx.deployment.startBlock),
    toBlock: "latest",
  });
  return logs.length > 0;
}

/** The vote for this round, or why there is none. Conflicts are checked first: a conflicted juror creates no salt. */
async function decide(
  ctx: AgentContext,
  item: MarketItem,
  dispute: Dispute,
): Promise<{ choice: 0 | 1 } | { skip: string }> {
  const me = ctx.account.address;
  const { market } = item;
  if (sameAddress(market.creator, me) || sameAddress(dispute.challenger, me)) return { skip: "CONFLICTED" };
  const [yes, no] = await ctx.publicClient.readContract({
    address: ctx.deployment.generation.markets as Hex,
    abi: agentAbi.markets,
    functionName: "getPosition",
    args: [BigInt(market.marketId), me],
  });
  if (yes !== 0n || no !== 0n) return { skip: "CONFLICTED" };
  const view = viewOf(item);
  if (!view) return { skip: "NO_SPEC" };
  if (dispute.kind === "CREATION") return { choice: (await ctx.model.creationObjection(view)) ? 1 : 0 };
  const { proposal } = await ctx.client.getMarket({ marketId: market.marketId });
  if (!proposal) return { skip: "NO_PROPOSAL" };
  if (sameAddress(proposal.proposer, me)) return { skip: "CONFLICTED" };
  const proposed = OUTCOME[proposal.outcome as "YES" | "NO"];
  // Unsupported: the only vote against a proposal is the other outcome.
  if (!(await evidenceAvailable(ctx, proposal.evidenceHash))) return { choice: proposed === 0 ? 1 : 0 };
  const answer = await ctx.model.outcome(view);
  return answer ? { choice: OUTCOME[answer.outcome] } : { skip: "NO_ANSWER" };
}

async function markSkipped(ctx: AgentContext, voteKey: string, reason: string) {
  actedOn(ctx, SKIPPED).push(voteKey);
  await ctx.state.save();
  ctx.log("skipped_vote", { vote: voteKey, reason });
}

/** Sends the commitment of the saved (choice, salt) and records the landing. */
async function sendCommit(ctx: AgentContext, voteKey: string) {
  const { disputeId, round } = parseKey(voteKey);
  const [choice, salt] = ctx.state.data.salts[saltKey(voteKey)]!.split(":") as [string, Hex];
  const request = resolutionCall(ctx, "commitVote", [
    disputeId,
    voteCommitment({ disputeId, round, juror: ctx.account.address, choice: Number(choice), salt }),
  ]);
  try {
    await send(ctx, "COMMIT_VOTE", request);
  } catch (error) {
    const name = await revertName(ctx, error, request);
    if (name !== undefined && NOT_ELIGIBLE.includes(name)) return markSkipped(ctx, voteKey, name);
    // InvalidVote: the vote exists already, so an earlier send landed; anything else is a failure.
    if (name !== "InvalidVote" || !(await eventSeen(ctx, "VoteCommitted", disputeId, round))) throw error;
  }
  actedOn(ctx, COMMITTED).push(voteKey);
  await ctx.state.save();
  ctx.log("committed", { vote: voteKey });
}

/**
 * A salt in the saved state with no landing recorded is a commit whose answer was lost (or whose
 * process died): the chain says whether it landed. Whatever the commit window, the vote is then
 * known and can still be revealed.
 */
async function reconcileCommits(ctx: AgentContext) {
  const known = [...actedOn(ctx, COMMITTED), ...actedOn(ctx, SKIPPED)];
  for (const saltAt of Object.keys(ctx.state.data.salts).filter((k) => k.startsWith("juror:"))) {
    const voteKey = saltAt.slice("juror:".length);
    const { disputeId, round } = parseKey(voteKey);
    if (known.includes(voteKey) || !(await eventSeen(ctx, "VoteCommitted", disputeId, round))) continue;
    actedOn(ctx, COMMITTED).push(voteKey);
    await ctx.state.save();
    ctx.log("commit_recovered", { vote: voteKey });
  }
}

async function commitOpenRounds(ctx: AgentContext, now: number) {
  const done = [...actedOn(ctx, COMMITTED), ...actedOn(ctx, SKIPPED)];
  const items = [
    ...(await listAll(ctx, "DISPUTED")),
    ...(await listAll(ctx, "PENDING")).filter((i) => i.market.creationChallenged),
  ];
  for (const item of items)
    for (const dispute of (await ctx.client.listDisputes({ marketId: item.market.marketId }, { limit: 100 })).items) {
      if (dispute.settled) continue;
      const { dispute: d, round } = await readDispute(ctx, BigInt(dispute.disputeId));
      const voteKey = key(dispute.disputeId, d.currentRound);
      if (round.settled || now >= Number(round.commitEnd) || done.includes(voteKey)) continue;
      const saltAt = saltKey(voteKey);
      // With a salt saved and no landing on the chain, the same commitment is sent again; the
      // contract takes one vote per juror and round, so this can never commit twice.
      if (ctx.state.data.salts[saltAt] === undefined) {
        const decision = await decide(ctx, item, dispute);
        if ("skip" in decision) {
          await markSkipped(ctx, voteKey, decision.skip);
          continue;
        }
        ctx.state.data.salts[saltAt] = `${decision.choice}:${bytesToHex(randomBytes(32))}`;
      }
      // Saved before the transaction is sent, on every try: a save that failed on an earlier tick
      // left the salt in memory only, and no commitment is sent until the file holds it.
      await ctx.state.save();
      await sendCommit(ctx, voteKey);
    }
}

async function revealCommitted(ctx: AgentContext, now: number) {
  const revealed = actedOn(ctx, REVEALED);
  for (const voteKey of actedOn(ctx, COMMITTED).filter((k) => !revealed.includes(k))) {
    const { disputeId, round } = parseKey(voteKey);
    const { dispute: d, round: r } = await readDispute(ctx, disputeId);
    // The reveal is for the dispute's current round only, between the end of commits and of reveals.
    if (d.currentRound !== round || r.settled || now < Number(r.commitEnd) || now >= Number(r.revealEnd)) continue;
    const [choice, salt] = ctx.state.data.salts[saltKey(voteKey)]!.split(":") as [string, Hex];
    const request = resolutionCall(ctx, "revealVote", [disputeId, Number(choice), salt]);
    try {
      await send(ctx, "REVEAL_VOTE", request);
    } catch (error) {
      const name = await revertName(ctx, error, request);
      if (name !== "InvalidVote" || !(await eventSeen(ctx, "VoteRevealed", disputeId, round))) throw error;
    }
    revealed.push(voteKey);
    await ctx.state.save();
    ctx.log("revealed", { vote: voteKey });
  }
}

/** Settles one vote. A vote that is settled already counts as settled; a winner whose losers are not all settled yet waits. */
async function settleVote(ctx: AgentContext, disputeId: bigint, round: bigint, juror: Hex) {
  const request = resolutionCall(ctx, "settleVote", [disputeId, round, juror]);
  try {
    await send(ctx, "SETTLE_VOTE", request);
    return "settled" as const;
  } catch (error) {
    const name = await revertName(ctx, error, request);
    if (name === "AlreadySettled") return "settled" as const;
    if (name === "LosersPending") return "waiting" as const;
    throw error;
  }
}

/**
 * Once a dispute is final: settle its votes, losers before winners (a winner's reward waits until
 * every loser is settled), then claim. Anyone may settle any vote, so a juror that never comes
 * back cannot block the others; the committers come from the chain's VoteCommitted events.
 */
async function settleFinished(ctx: AgentContext) {
  const settled = actedOn(ctx, SETTLED);
  const open = actedOn(ctx, COMMITTED).filter((k) => !settled.includes(k));
  for (const disputeId of new Set(open.map((k) => parseKey(k).disputeId))) {
    if (!(await readDispute(ctx, disputeId)).dispute.settled) continue;
    const votes = await ctx.publicClient.getContractEvents({
      address: resolutionAddress(ctx),
      abi: agentAbi.resolution,
      eventName: "VoteCommitted",
      args: { disputeId },
      fromBlock: BigInt(ctx.deployment.startBlock),
      toBlock: "latest",
    });
    const mine = (juror: string) => sameAddress(juror, ctx.account.address);
    const ordered = [...votes.filter((v) => !mine(v.args.juror!)), ...votes.filter((v) => mine(v.args.juror!))];
    // Two passes: the first settles the losers, the second the winners that were waiting for them.
    const done = new Set<string>();
    for (let pass = 0; pass < 2; pass++)
      for (const { args } of ordered) {
        const id = key(args.juror!, args.round!);
        if (done.has(id)) continue;
        if ((await settleVote(ctx, disputeId, args.round!, args.juror!)) === "waiting") continue;
        done.add(id);
        if (mine(args.juror!)) {
          settled.push(key(disputeId, args.round!));
          ctx.log("settled_vote", { vote: key(disputeId, args.round!) });
        }
      }
    await ctx.state.save();
  }
}

/**
 * Claims the rewards of every dispute whose votes of this juror are all settled, until the claim
 * succeeds: it is selected from the saved state alone, so a claim that failed (or a crash after the
 * votes were recorded) is tried again on the next tick. A repeated claim is harmless on chain. A
 * claim the chain refuses (a revert) is recorded as blocked, logged once and not tried again.
 */
async function claimSettled(ctx: AgentContext) {
  const settled = actedOn(ctx, SETTLED);
  const claimed = actedOn(ctx, CLAIMED);
  const blocked = actedOn(ctx, CLAIM_BLOCKED);
  const committed = actedOn(ctx, COMMITTED);
  for (const disputeId of new Set(committed.map((k) => parseKey(k).disputeId))) {
    const id = disputeId.toString();
    const votes = committed.filter((k) => parseKey(k).disputeId === disputeId);
    if (claimed.includes(id) || blocked.includes(id) || !votes.every((k) => settled.includes(k))) continue;
    const request = {
      address: ctx.deployment.generation.jurors as Hex,
      abi: agentAbi.jurors,
      functionName: "claimRewards",
    } as const;
    try {
      await send(ctx, "CLAIM_REWARDS", request);
    } catch (error) {
      // Only a refusal by the chain is final; anything else (RPC, timeout, 429, a stale index) is tried again.
      if (!isRevert(error)) throw error;
      blocked.push(id);
      await ctx.state.save();
      ctx.log("claim_blocked", { disputeId: id, error: (await revertName(ctx, error, request)) ?? "REVERTED" });
      continue;
    }
    claimed.push(id);
    await ctx.state.save();
    ctx.log("claimed_rewards", { disputeId: id });
  }
}

export const juror: RoleTick = async (ctx) => {
  const now = await chainSeconds(ctx);
  // The time-critical steps first: a reveal has a window of its own.
  await reconcileCommits(ctx);
  await revealCommitted(ctx, now);
  await commitOpenRounds(ctx, now);
  // Settling and claiming have no deadline of their own, so they come after anything with one.
  await settleFinished(ctx);
  await claimSettled(ctx);
};
