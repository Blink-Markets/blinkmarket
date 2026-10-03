import { CandidateApprovalRequest, CandidateRecord } from "@blink/schemas";

/** Trusted database snapshot, not an HTTP authorization assertion. */
export interface ApprovalEvidence {
  evidenceId: string;
  entityId: string;
  sourceUrl: string;
  sourceEnabled: boolean;
  accessPolicy: "PUBLIC" | "EXCERPT" | "PRIVATE";
}

export class ApprovalPolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new ApprovalPolicyError(code);
};
const sameSet = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  a.length === b.length &&
  a.every((value) => b.includes(value));

/** Pure preflight policy. The final approval transaction must repeat it under locks. */
export function validateReplayApproval(input: {
  candidate: unknown;
  request: unknown;
  evidence: readonly ApprovalEvidence[];
  nowSeconds: bigint;
}) {
  const parsedCandidate = CandidateRecord.safeParse(input.candidate);
  const parsedRequest = CandidateApprovalRequest.safeParse(input.request);
  if (!parsedCandidate.success || !parsedRequest.success)
    fail("INVALID_APPROVAL_INPUT");
  const candidate = parsedCandidate.data!;
  const request = parsedRequest.data!;
  const spec = request.spec;
  if (input.nowSeconds < 0n) fail("INVALID_APPROVAL_CLOCK");
  if (request.expectedRevision !== candidate.revision)
    fail("REVISION_CONFLICT");
  if (!["DRAFT", "VALIDATING"].includes(candidate.state))
    fail("CANDIDATE_NOT_APPROVABLE");
  // Official LIVE entities/source policy is not configured. Never silently downgrade LIVE.
  if (spec.mode !== "REPLAY") fail("LIVE_APPROVAL_DISABLED");
  if (BigInt(spec.closeAt) <= input.nowSeconds) fail("MARKET_CLOSED");
  if (
    BigInt(request.budgetMicros) < 1n ||
    BigInt(request.budgetMicros) > 2_000_000n
  )
    fail("RESEARCH_BUDGET_OUT_OF_RANGE");
  for (const field of [
    "templateId",
    "entityId",
    "fiscalPeriod",
    "thresholdBps",
  ] as const)
    if (candidate[field] !== spec[field]) fail("CANDIDATE_SPEC_MISMATCH");
  const ids = spec.sourceEvidenceIds.map((id) => id.toLowerCase());
  if (!sameSet(candidate.evidenceIds, ids)) fail("CANDIDATE_EVIDENCE_MISMATCH");
  if (
    !sameSet(
      ids,
      input.evidence.map((e) => e.evidenceId.toLowerCase()),
    )
  )
    fail("EVIDENCE_SNAPSHOT_MISMATCH");
  for (const evidence of input.evidence) {
    if (!evidence.sourceEnabled || evidence.entityId !== candidate.entityId)
      fail("EVIDENCE_NOT_ALLOWED");
    // Approved specifications are intended to be public. Do not publish private citations.
    if (evidence.accessPolicy === "PRIVATE") fail("PRIVATE_APPROVAL_EVIDENCE");
    let url: URL;
    try {
      url = new URL(evidence.sourceUrl);
    } catch {
      return fail("EVIDENCE_NOT_ALLOWED");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      fail("EVIDENCE_NOT_ALLOWED");
  }
  const urls = [...new Set(input.evidence.map((e) => e.sourceUrl))];
  if (!sameSet(spec.sourceAllowlist, urls)) fail("SPEC_SOURCE_MISMATCH");
  return {
    candidate,
    request,
    // Structural encoding avoids delimiter collisions in company/period identifiers.
    canonicalKey: JSON.stringify([
      spec.mode,
      spec.templateId,
      spec.entityId,
      spec.fiscalPeriod,
      spec.thresholdBps,
    ]),
    // Different thresholds and deployments must still compete for the same company-period slot.
    activeSlotKey: JSON.stringify([
      spec.mode,
      spec.entityId,
      spec.fiscalPeriod,
    ]),
  };
}
