export interface KeeperMarket {
  state: "OPEN" | "PROPOSED" | "DISPUTED" | "FINAL";
  proposedAt: bigint | null;
  challengeSeconds: number | bigint;
  hardDeadline: bigint;
}
export type KeeperDecision = "FINALIZE_UNCHALLENGED" | "FINALIZE_TIMEOUT";

export function keeperDecision(
  market: KeeperMarket,
  nowChain: bigint,
): KeeperDecision | null {
  if (market.state === "FINAL") return null;
  if (nowChain >= market.hardDeadline) return "FINALIZE_TIMEOUT";
  if (
    market.state === "PROPOSED" &&
    market.proposedAt !== null &&
    nowChain >= market.proposedAt + BigInt(market.challengeSeconds)
  )
    return "FINALIZE_UNCHALLENGED";
  return null;
}
