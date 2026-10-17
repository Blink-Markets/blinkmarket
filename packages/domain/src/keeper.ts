export interface KeeperMarket {
  state: "OPEN" | "PROPOSED" | "DISPUTED" | "FINAL";
  proposedAt: bigint | null;
  challengeSeconds: number | bigint;
  hardDeadline: bigint;
}
export type KeeperDecision = "FINALIZE_UNCHALLENGED" | "FINALIZE_TIMEOUT";

/** The chain time from which the keeper must finalize this market, or null once it is FINAL. */
export function keeperDueSince(market: KeeperMarket): bigint | null {
  if (market.state === "FINAL") return null;
  const unchallenged =
    market.state === "PROPOSED" && market.proposedAt !== null
      ? market.proposedAt + BigInt(market.challengeSeconds)
      : null;
  return unchallenged !== null && unchallenged < market.hardDeadline
    ? unchallenged
    : market.hardDeadline;
}

export function keeperDecision(
  market: KeeperMarket,
  nowChain: bigint,
): KeeperDecision | null {
  const dueSince = keeperDueSince(market);
  if (dueSince === null || nowChain < dueSince) return null;
  return nowChain >= market.hardDeadline
    ? "FINALIZE_TIMEOUT"
    : "FINALIZE_UNCHALLENGED";
}
