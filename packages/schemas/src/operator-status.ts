import { HealthResponse } from "./health.ts";
import { z } from "zod";
import { Uint256, DeploymentId } from "./core.ts";
export const JobState = z.enum(["QUEUED", "LEASED", "SUCCEEDED", "DEAD"]);
export const AdminJobsResponse = z.strictObject({
  items: z.array(
    z.strictObject({
      jobId: z.uuid(),
      state: JobState,
      attempt: z.number().int().nonnegative(),
      maxAttempts: z.number().int().positive(),
      createdAt: z.iso.datetime(),
      finishedAt: z.iso.datetime().nullable(),
    }),
  ),
  truncated: z.boolean(),
});
export type AdminJobsResponse = z.infer<typeof AdminJobsResponse>;
export const AdminPauseState = z.strictObject({
  deploymentId: DeploymentId,
  globalPaused: z.boolean().nullable(),
  markets: z.array(z.strictObject({ marketId: Uint256, paused: z.boolean() })),
});
export type AdminPauseState = z.infer<typeof AdminPauseState>;
export const AdminPauseResponse = AdminPauseState.extend({
  health: HealthResponse,
});
