import { z } from "zod";
import { Hash, MarketSpec } from "./core.ts";
import { Probability } from "./http.ts";

// What a platform model may answer. Anything outside these shapes is a schema error;
// unknown keys are dropped, so output can never add fields (evidence, URLs) to a request.
const Label = z.string().trim().min(1).max(4000);
export const DiscoveryCandidateOutput = z.object({
  entityId: Label,
  fiscalPeriod: Label,
  thresholdBps: z.number().int().min(0).max(10000),
  thesis: z.string().trim().min(1).max(1000),
});
export const DiscoveryNoCandidateOutput = z.object({ candidate: z.null() });
export const DiscoveryOutput = z.union([
  DiscoveryCandidateOutput,
  DiscoveryNoCandidateOutput,
]);
export type DiscoveryOutput = z.infer<typeof DiscoveryOutput>;

export const ForecastOutput = z.object({
  probability: Probability,
  rationale: z.string().trim().min(1).max(4000),
  evidenceIds: z.array(z.uuid()).min(1).max(50),
});
export type ForecastOutput = z.infer<typeof ForecastOutput>;

// The parts of public API responses the platform agents act on. @blink/client has already
// validated the full contract; these give the worker typed access to what it reads.
export const CandidateCreated = z.object({ candidateId: z.uuid() });
export const MarketView = z.object({ specHash: Hash, spec: MarketSpec });
export const SubmissionReceipt = z.object({ submissionId: z.uuid() });
