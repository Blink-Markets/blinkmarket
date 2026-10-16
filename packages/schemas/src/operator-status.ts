import { HealthResponse } from "./health.ts";
import { z } from "zod";
import { CandidateRecord } from "./preparation.ts";
import { Uint256, DeploymentId } from "./core.ts";
export const CandidateStatus = CandidateRecord.shape.state;
export const AdminCandidatesResponse = z.strictObject({
  items: z.array(
    z.strictObject({
      candidateId: z.uuid(),
      revision: z.number().int().positive(),
      status: CandidateStatus,
      approval: z
        .strictObject({
          approvalId: z.uuid(),
          deploymentId: DeploymentId,
          budgetMicros: Uint256,
          creationIntentId: z.uuid().nullable(),
          state: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
});
export type AdminCandidatesResponse = z.infer<typeof AdminCandidatesResponse>;
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
});
export type AdminJobsResponse = z.infer<typeof AdminJobsResponse>;
export const AdminBudgetsResponse = z.strictObject({
  daily: z.strictObject({
    day: z.iso.date(),
    capUsdMicros: Uint256,
    spentUsdMicros: Uint256,
    reservedUsdMicros: Uint256,
    unknownUsdMicros: Uint256,
  }),
});
export type AdminBudgetsResponse = z.infer<typeof AdminBudgetsResponse>;
export const AdminPauseState = z.strictObject({
  deploymentId: DeploymentId,
  globalPaused: z.boolean().nullable(),
  markets: z.array(z.strictObject({ marketId: Uint256, paused: z.boolean() })),
});
export type AdminPauseState = z.infer<typeof AdminPauseState>;
export const AdminPauseResponse = AdminPauseState.extend({
  health: HealthResponse,
});
export const AdminResolutionsResponse = z.strictObject({
  items: z.array(
    z.strictObject({
      marketId: Uint256,
      state: z.enum(["OPEN", "PROPOSED", "DISPUTED"]),
      closeAt: Uint256,
      proposalDeadline: Uint256,
      hardDeadline: Uint256,
      challengeEndsAt: Uint256.nullable(),
      openReports: Uint256,
    }),
  ),
});
export type AdminResolutionsResponse = z.infer<typeof AdminResolutionsResponse>;
