import {
  OutcomeName,
  type Choice,
  type FeeBreakdown,
  type ProtocolDispute,
  type ProtocolMarket,
  type ProtocolParams,
  type ProtocolProposal,
  type ProtocolRound,
  type ProtocolVote,
} from "@blink/schemas";
import {
  add,
  addr,
  fail,
  hash,
  member,
  num,
  str,
  uint,
  type ProtocolEvent,
} from "./protocol-event-args.ts";

export interface ResolutionProjection {
  markets: Map<string, ProtocolMarket>;
  proposals: Map<string, ProtocolProposal>;
  disputes: Map<string, ProtocolDispute>;
  rounds: Map<string, ProtocolRound>;
  votes: Map<string, ProtocolVote>;
}
export const roundKey = (disputeId: string, round: number) =>
  `${disputeId}:${round}`;
export const voteKey = (disputeId: string, round: number, juror: string) =>
  `${disputeId}:${round}:${juror}`;

const choiceOf = (e: ProtocolEvent, k: string): Choice => {
  const n = num(e, k);
  return n === 0 || n === 1 ? n : fail(e, `invalid choice ${k}`);
};
const disputeOf = (p: ResolutionProjection, e: ProtocolEvent) =>
  p.disputes.get(uint(e, "disputeId").toString()) ??
  fail(e, "unknown dispute");
// The vote and reveal events name the round; only the dispute's current round is open.
function openRound(p: ResolutionProjection, e: ProtocolEvent) {
  const d = disputeOf(p, e),
    round = num(e, "round");
  if (d.settled || round !== d.currentRound) fail(e, "not the current round");
  return {
    d,
    round,
    r: p.rounds.get(roundKey(d.disputeId, round)) ?? fail(e, "unknown round"),
  };
}
function startRound(
  p: ResolutionProjection,
  e: ProtocolEvent,
  d: ProtocolDispute,
  rules: ProtocolParams,
  snapshotAt = Number(e.blockTimestamp) - 1,
) {
  const at = Number(e.blockTimestamp),
    commitEnd = at + rules.commitSeconds,
    revealEnd = commitEnd + rules.revealSeconds,
    finalized = [...p.markets.values()].filter((m) => m.state === "FINAL").length;
  p.rounds.set(roundKey(d.disputeId, d.currentRound), {
    disputeId: d.disputeId,
    round: d.currentRound,
    level: d.appealRound,
    snapshotAt,
    commitEnd,
    revealEnd,
    appealEnd: revealEnd + rules.appealSeconds,
    committedWeight: "0",
    revealedWeight: ["0", "0"],
    committers: 0,
    revealers: 0,
    leadingChoice: 0,
    restarted: false,
    settled: false,
    creditThreshold:
      finalized >= rules.phaseInFinalizedMarkets
        ? (rules.roundCreditThreshold[d.appealRound] ?? fail(e, "invalid appeal level"))
        : 0,
  });
}

/** Folds the BlinkResolution events that change a projection; UnchallengedFinalized stays journal-only. */
export function applyResolutionEvent(
  p: ResolutionProjection,
  e: ProtocolEvent,
  rules: ProtocolParams,
): void {
  switch (e.name) {
    case "Proposed": {
      const marketId = uint(e, "id").toString();
      if (!p.markets.has(marketId) || p.proposals.has(marketId))
        fail(e, "unknown market or duplicate proposal");
      p.proposals.set(marketId, {
        marketId,
        proposer: addr(e, "proposer"),
        outcome: member(e, "outcome", OutcomeName.options),
        bondMicros: uint(e, "bond").toString(),
        challengeEnd: num(e, "challengeEnd"),
        evidenceHash: hash(e, "evidenceHash"),
        evidenceUri: str(e, "evidenceURI"),
        proposedAt: Number(e.blockTimestamp),
      });
      return;
    }
    case "DisputeOpened": {
      const disputeId = uint(e, "disputeId").toString(),
        marketId = uint(e, "marketId").toString();
      if (p.disputes.has(disputeId) || !p.markets.has(marketId))
        fail(e, "duplicate dispute or unknown market");
      const d: ProtocolDispute = {
        disputeId,
        marketId,
        kind: member(e, "kind", ["CREATION", "RESULT"] as const),
        ground: num(e, "ground"),
        challenger: addr(e, "challenger"),
        evidenceHash: hash(e, "evidenceHash"),
        currentRound: 0,
        appealRound: 0,
        settled: false,
        timedOut: false,
        finalChoice: null,
      };
      p.disputes.set(disputeId, d);
      startRound(p, e, d, rules);
      return;
    }
    case "VoteCommitted": {
      const { d, round, r } = openRound(p, e),
        juror = addr(e, "juror"),
        key = voteKey(d.disputeId, round, juror),
        weight = uint(e, "weight");
      if (p.votes.has(key) || weight === 0n) fail(e, "duplicate or empty vote");
      p.votes.set(key, {
        disputeId: d.disputeId,
        round,
        juror,
        weight: weight.toString(),
        revealed: false,
        choice: null,
        settled: false,
        slashed: "0",
        reward: "0",
      });
      r.committedWeight = add(r.committedWeight, weight, e);
      r.committers += 1;
      return;
    }
    case "VoteRevealed": {
      const { d, round, r } = openRound(p, e),
        choice = choiceOf(e, "choice"),
        v =
          p.votes.get(voteKey(d.disputeId, round, addr(e, "juror"))) ??
          fail(e, "reveal without commit");
      if (v.revealed) fail(e, "duplicate reveal");
      v.revealed = true;
      v.choice = choice;
      r.revealedWeight[choice] = add(r.revealedWeight[choice], BigInt(v.weight), e);
      r.revealers += 1;
      return;
    }
    case "RoundSettled": {
      const { r } = openRound(p, e);
      r.settled = true;
      r.leadingChoice = choiceOf(e, "choice");
      r.appealEnd = num(e, "appealEnd");
      return;
    }
    case "RoundRestarted": {
      const d = disputeOf(p, e),
        next = num(e, "round");
      if (d.settled || next !== d.currentRound + 1) fail(e, "round sequence");
      const old = p.rounds.get(roundKey(d.disputeId, d.currentRound)) ?? fail(e, "unknown round");
      old.settled = true;
      old.restarted = true;
      d.currentRound = next;
      startRound(p, e, d, rules, num(e, "snapshotAt"));
      return;
    }
    case "Appealed": {
      const d = disputeOf(p, e),
        next = num(e, "round"),
        level = num(e, "appealRound");
      if (d.settled || next !== d.currentRound + 1 || level !== d.appealRound + 1)
        fail(e, "round sequence");
      d.currentRound = next;
      d.appealRound = level;
      startRound(p, e, d, rules);
      return;
    }
    case "VoteSettled": {
      const d = disputeOf(p, e),
        v =
          p.votes.get(voteKey(d.disputeId, num(e, "round"), addr(e, "juror"))) ??
          fail(e, "unknown vote");
      // A final-round vote emits again, with zero amounts, when its credit is settled.
      v.settled = true;
      v.slashed = add(v.slashed, uint(e, "slash"), e);
      v.reward = add(v.reward, uint(e, "reward"), e);
      return;
    }
    case "DisputeFinalized": {
      const d = disputeOf(p, e);
      if (d.settled) fail(e, "dispute already settled");
      d.settled = true;
      d.finalChoice = choiceOf(e, "choice");
      return;
    }
    case "TimeoutFinalized": {
      const marketId = uint(e, "id").toString();
      for (const d of p.disputes.values())
        if (d.marketId === marketId && !d.settled) {
          d.settled = true;
          d.timedOut = true;
        }
      return;
    }
    default:
      fail(e, "unhandled event");
  }
}

/**
 * BlinkMarkets.distributeFees, recomputed. All share-rounding dust belongs to the treasury (R32); the
 * resolution share goes to the proposer only when the proposal won, the creator share goes to jurors
 * when the market ended INVALID, and the bounty goes to the recorded winner of an overturned proposal.
 */
export function feeBreakdown(
  rules: ProtocolParams,
  market: ProtocolMarket,
  proposal: ProtocolProposal | undefined,
  resultDispute: ProtocolDispute | undefined,
  pool: bigint,
  keeper: string,
  /** BlinkJurors.notifyReward sends everything to the treasury while no juror stake exists. */
  noJurorStake: boolean,
): FeeBreakdown {
  const share = (bps: number) => (pool * BigInt(bps)) / 10_000n,
    creator = share(rules.creatorShareBps),
    gross = share(rules.resolutionShareBps),
    jurors = share(rules.jurorShareBps),
    bounty = share(rules.bountyShareBps),
    treasury = pool - creator - gross - jurors - bounty,
    tip = (gross * BigInt(rules.keeperTipBps)) / 10_000n,
    invalid = market.finalOutcome === "INVALID",
    proposalWon = !!proposal && market.finalOutcome === proposal.outcome;
  // BlinkResolution records the bounty winner when a result dispute finalizes (not on a timeout).
  const challengerWins =
    resultDispute?.settled &&
    !resultDispute.timedOut &&
    proposal &&
    resultDispute.finalChoice !== null &&
    resultDispute.finalChoice !== OutcomeName.options.indexOf(proposal.outcome);
  const winner =
    resultDispute?.settled && !resultDispute.timedOut && proposal
      ? challengerWins
        ? resultDispute.challenger
        : proposal.proposer
      : null;
  const bountyPaid = winner !== null && !proposalWon && !invalid;
  let toJurors = jurors;
  if (invalid) toJurors += creator;
  if (!proposalWon) toJurors += gross - tip;
  if (!bountyPaid) toJurors += bounty;
  return {
    marketId: market.marketId,
    poolMicros: pool.toString(),
    treasury: (noJurorStake ? treasury + toJurors : treasury).toString(),
    creator: (invalid ? 0n : creator).toString(),
    resolution: (proposalWon ? gross - tip : 0n).toString(),
    keeperTip: tip.toString(),
    keeper: keeper.toLowerCase(),
    jurors: (noJurorStake ? 0n : toJurors).toString(),
    bounty: (bountyPaid ? bounty : 0n).toString(),
    bountyWinner: bountyPaid ? winner : null,
  };
}
