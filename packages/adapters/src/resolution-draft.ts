import type { Pool } from "pg";
import { encodeFunctionData } from "viem";
import { DeploymentManifest, PositiveUint256, Hash } from "@blink/schemas";
import { blinkMarketAbi } from "./blink-abi.js";
export interface ResolutionDraftInput {
  deploymentId: string;
  marketId: string;
  action: "propose" | "challenge" | "arbitrate";
  outcome: "YES" | "NO" | "INVALID";
  evidenceHash: string;
}
export async function resolutionDraft(pool: Pool, input: ResolutionDraftInput) {
  const marketId = PositiveUint256.parse(input.marketId),
    evidenceHash = Hash.parse(input.evidenceHash) as `0x${string}`;
  if (
    !["propose", "challenge", "arbitrate"].includes(input.action) ||
    !["YES", "NO", "INVALID"].includes(input.outcome) ||
    /^0x0{64}$/i.test(evidenceHash)
  )
    throw new Error("INVALID_ARGUMENTS");
  const { rows } = await pool.query(
    `SELECT d.manifest,'0x'||encode(d.market_address,'hex') AS address,m.state,m.close_at::text,m.proposal_deadline::text,m.hard_deadline::text,m.proposed_at::text,m.challenge_seconds,
 floor(extract(epoch from blink.now()))::text AS now,c.block_timestamp::text,c.gate_reason,
 c.synced_at<blink.now()-interval '60 seconds' AS stale
 FROM markets.deployments d JOIN chain.markets m ON m.deployment_id=d.id LEFT JOIN chain.cursors c ON c.deployment_id=d.id WHERE d.id=$1 AND m.market_id=$2`,
    [input.deploymentId, marketId],
  );
  const row = rows[0];
  if (!row) throw new Error("NOT_FOUND");
  if (row.manifest.chainId === 8453) throw new Error("MAINNET_REFUSED");
  const manifest = DeploymentManifest.parse(row.manifest);
  if (
    manifest.deploymentId !== input.deploymentId ||
    manifest.contracts.BlinkMarket.toLowerCase() !== row.address.toLowerCase()
  )
    throw new Error("DEPLOYMENT_MISMATCH");
  const warnings: string[] = [];
  if (!row.block_timestamp) warnings.push("CHAIN_CURSOR_MISSING");
  if (row.stale || row.gate_reason) warnings.push("CHAIN_PROJECTION_UNTRUSTED");
  const times = [
    BigInt(row.now),
    ...(row.block_timestamp ? [BigInt(row.block_timestamp)] : []),
  ];
  const now = times.reduce((a, b) => (a > b ? a : b));
  if (input.action === "propose") {
    if (row.state !== "OPEN") warnings.push("INVALID_STATE");
    if (times.some((t) => t < BigInt(row.close_at)))
      warnings.push("PROPOSE_BEFORE_CLOSE");
    if (now >= BigInt(row.proposal_deadline))
      warnings.push("PROPOSAL_DEADLINE_PASSED");
  } else if (input.action === "challenge") {
    if (row.state !== "PROPOSED") warnings.push("INVALID_STATE");
    if (
      row.proposed_at === null ||
      now >= BigInt(row.proposed_at) + BigInt(row.challenge_seconds)
    )
      warnings.push("CHALLENGE_WINDOW_CLOSED");
    warnings.push("CHALLENGE_OUTCOME_NOT_ENCODED");
  } else {
    if (row.state !== "DISPUTED") warnings.push("INVALID_STATE");
    if (now >= BigInt(row.hard_deadline)) warnings.push("HARD_DEADLINE_PASSED");
  }
  const outcome = { YES: 0, NO: 1, INVALID: 2 }[input.outcome];
  const data =
    input.action === "challenge"
      ? encodeFunctionData({
          abi: blinkMarketAbi,
          functionName: "challengeOutcome",
          args: [BigInt(marketId), evidenceHash],
        })
      : encodeFunctionData({
          abi: blinkMarketAbi,
          functionName:
            input.action === "propose" ? "proposeOutcome" : "arbitrate",
          args: [BigInt(marketId), outcome, evidenceHash],
        });
  return {
    chainId: 84532 as const,
    to: manifest.contracts.BlinkMarket,
    requiredSender:
      manifest.roles[
        input.action === "propose"
          ? "resultProposer"
          : input.action === "challenge"
            ? "challenger"
            : "arbiter"
      ],
    data,
    value: "0" as const,
    warnings,
  };
}
