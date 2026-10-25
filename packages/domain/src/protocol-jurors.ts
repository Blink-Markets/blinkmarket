import type { JurorState } from "@blink/schemas";
import {
  add,
  addr,
  fail,
  num,
  uint,
  type ProtocolEvent,
} from "./protocol-event-args.ts";

/** BlinkJurors.REWARD_STREAM_SECONDS: notified bUSD streams to stakers over seven days. */
const STREAM_SECONDS = 604_800n;
const RATE_PRECISION = 10n ** 18n;
const REWARD_PRECISION = 10n ** 36n;

/** A juror row plus the reward-stream checkpoint that settling needs; the API serves only JurorState. */
export interface JurorLedger extends JurorState {
  /** BlinkJurors.userRewardPerTokenPaid */
  rewardPaid: string;
}
/** The shared reward stream (Synthetix StakingRewards), kept in one row under the key "pool". */
export interface RewardPool {
  totalStaked: string;
  rewardPerToken: string;
  rate: string;
  periodFinish: number;
  lastUpdate: number;
}
export interface JurorProjection {
  jurors: Map<string, JurorLedger>;
  rewardPool: Map<string, RewardPool>;
}
export const POOL_KEY = "pool";

const emptyPool = (): RewardPool => ({
  totalStaked: "0",
  rewardPerToken: "0",
  rate: "0",
  periodFinish: 0,
  lastUpdate: 0,
});
const emptyJuror = (address: string): JurorLedger => ({
  address,
  staked: "0",
  pendingUnstake: "0",
  unstakeReadyAt: 0,
  openVotes: 0,
  rewardsOwed: "0",
  rewardPaid: "0",
});

/** BlinkJurors._accrue: moves the stream up to `at` into the per-token accumulator. */
function accrue(pool: RewardPool, at: number) {
  const to = Math.min(at, pool.periodFinish);
  if (to <= pool.lastUpdate) return;
  const total = BigInt(pool.totalStaked);
  if (total > 0n)
    pool.rewardPerToken = (
      BigInt(pool.rewardPerToken) +
      (BigInt(to - pool.lastUpdate) * BigInt(pool.rate) * RATE_PRECISION) /
        total
    ).toString();
  pool.lastUpdate = to;
}
/** BlinkJurors._settle: credits the juror what the stream gave their current stake. */
function settle(pool: RewardPool, j: JurorLedger, at: number) {
  accrue(pool, at);
  const delta = BigInt(pool.rewardPerToken) - BigInt(j.rewardPaid);
  if (delta === 0n) return;
  j.rewardsOwed = (
    BigInt(j.rewardsOwed) +
    (BigInt(j.staked) * delta) / REWARD_PRECISION
  ).toString();
  j.rewardPaid = pool.rewardPerToken;
}

// Known gap, by design: the read model is derived from events alone. BlinkJurors.claimRewards settles
// the caller and returns without an event when nothing is owed, and slash settles before returning
// when nothing is taken. Those silent settles move the contract's per-juror checkpoint, so the sum of
// fractions the fold floors later can exceed the contract by under 1 micro per silent call. Every
// RewardsClaimed event resets the juror to exactly what the contract holds after a claim (0), and the
// claim always pays the contract value. rewardsOwed is therefore never gated against the chain.
export function applyJurorEvent(p: JurorProjection, e: ProtocolEvent): void {
  const at = Number(e.blockTimestamp);
  const pool = p.rewardPool.get(POOL_KEY) ?? emptyPool();
  p.rewardPool.set(POOL_KEY, pool);
  if (e.name === "RewardNotified") {
    accrue(pool, at);
    // The event carries the accumulator after its own accrual: trust it over the simulation.
    pool.rewardPerToken = uint(e, "rewardPerToken").toString();
    const leftover =
      at < pool.periodFinish ? BigInt(pool.periodFinish - at) * BigInt(pool.rate) : 0n;
    pool.rate = (
      (uint(e, "amount") * RATE_PRECISION + leftover) /
      STREAM_SECONDS
    ).toString();
    pool.lastUpdate = at;
    pool.periodFinish = at + Number(STREAM_SECONDS);
    return;
  }
  const address = addr(e, "juror");
  const j = p.jurors.get(address) ?? emptyJuror(address);
  p.jurors.set(address, j);
  switch (e.name) {
    case "Staked":
      settle(pool, j, at);
      j.staked = add(j.staked, uint(e, "amount"), e);
      pool.totalStaked = add(pool.totalStaked, uint(e, "amount"), e);
      return;
    case "UnstakeRequested": {
      const amount = uint(e, "amount");
      settle(pool, j, at);
      j.staked = add(j.staked, -amount, e);
      j.pendingUnstake = add(j.pendingUnstake, amount, e);
      j.unstakeReadyAt = num(e, "unlockAt");
      pool.totalStaked = add(pool.totalStaked, -amount, e);
      return;
    }
    case "UnstakeWithdrawn":
      if (uint(e, "amount") !== BigInt(j.pendingUnstake))
        fail(e, "withdrawal differs from the pending unstake");
      j.pendingUnstake = "0";
      j.unstakeReadyAt = 0;
      return;
    case "Slashed": {
      // BlinkJurors.slash takes from the stake first, then from the pending unstake.
      settle(pool, j, at);
      const taken = uint(e, "slashed"),
        fromStake = taken < BigInt(j.staked) ? taken : BigInt(j.staked);
      j.staked = add(j.staked, -fromStake, e);
      j.pendingUnstake = add(j.pendingUnstake, -(taken - fromStake), e);
      pool.totalStaked = add(pool.totalStaked, -fromStake, e);
      return;
    }
    case "RewardsClaimed":
      // The contract settles, pays everything it holds and zeroes the balance: reset, never subtract,
      // so any accumulated difference is dropped here. The checkpoint is the current accumulator.
      uint(e, "amount");
      settle(pool, j, at);
      j.rewardsOwed = "0";
      j.rewardPaid = pool.rewardPerToken;
      return;
    case "VoteLocked":
    case "VoteUnlocked":
      j.openVotes = num(e, "openVotes");
      return;
    default:
      fail(e, "unhandled event");
  }
}
