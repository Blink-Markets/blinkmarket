import type { JobType } from "@blink/domain";
export const jobs = [
  "evidence.fetch",
  "discovery.scan",
  "candidate.validate",
  "market.deploy",
  "forecast.schedule",
  "forecast.dispatch",
  "forecast.run",
  "baseline.run",
  "budget.reconcile",
  "resolution.parse",
  "resolution.alerts",
  "alert.deliver",
  "alert.evaluate",
  "evaluation.score",
  "operations.prune",
] as const satisfies readonly JobType[];
