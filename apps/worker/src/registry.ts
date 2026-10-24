import type { JobType } from "@blink/domain";
export const jobs = [
  "forecast.schedule",
  "alert.deliver",
  "alert.evaluate",
  "evaluation.score",
  "operations.prune",
] as const satisfies readonly JobType[];
