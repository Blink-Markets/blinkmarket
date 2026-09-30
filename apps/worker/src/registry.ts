import type { JobType } from "@blink/domain";
export const jobs = [
  "evidence.fetch", "discovery.scan", "candidate.validate", "market.deploy",
  "forecast.run", "baseline.run", "budget.reconcile", "quote.reconcile",
  "chain.reconcile", "resolution.parse", "keeper.finalize", "faucet.mint", "evaluation.score",
] as const satisfies readonly JobType[];
