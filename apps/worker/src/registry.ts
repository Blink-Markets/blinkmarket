import type { JobType } from "@blink/domain";
export const jobs = [
  "evidence.fetch", "discovery.scan", "candidate.validate", "market.deploy",
  "forecast.schedule", "forecast.dispatch", "forecast.run", "baseline.run",
  "budget.reconcile", "quote.reconcile", "chain.reconcile", "tx.dispatch",
  "tx.track", "resolution.parse", "resolution.alerts", "keeper.finalize",
  "alert.deliver", "alert.evaluate", "faucet.mint", "trader.evaluate", "evaluation.score",
] as const satisfies readonly JobType[];
