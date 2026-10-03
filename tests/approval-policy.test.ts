import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateReplayApproval,
  ApprovalPolicyError,
} from "../packages/domain/src/approval.js";
import { prepareReplayApproval } from "../packages/application/src/approval-preflight.js";
import { createSpecArchive } from "../packages/adapters/src/spec-archive.js";
import { fileObjectStore } from "../packages/adapters/src/file-object-store.js";

function fixture() {
  const id = "00000000-0000-4000-8000-000000000001";
  const evidenceId = "00000000-0000-4000-8000-000000000002";
  const sourceUrl = "https://ir.example.test/replay";
  const candidate = {
    candidateId: id,
    revision: 1,
    state: "DRAFT",
    templateId: "GM_LT_V1",
    entityId: "ACME",
    fiscalPeriod: "FY2025Q1",
    thresholdBps: 4000,
    evidenceIds: [evidenceId],
    thesis: "Replay only",
  };
  const request = {
    deploymentId: "test",
    expectedRevision: 1,
    budgetMicros: "2000000",
    reason: "Reviewed replay",
    spec: {
      schemaVersion: "blink.market.v0.1.1",
      mode: "REPLAY",
      templateId: "GM_LT_V1",
      entityId: "ACME",
      fiscalPeriod: "FY2025Q1",
      periodStart: "2025-01-01",
      periodEnd: "2025-03-31",
      metric: "quarterly_gaap_reported_gross_margin",
      thresholdBps: 4000,
      comparator: "LT",
      sourceAllowlist: [sourceUrl],
      valueVersion: "FIRST_QUALIFYING_RELEASE",
      missingValueOutcome: "INVALID",
      invalidYesPayoutMicros: 500000,
      invalidNoPayoutMicros: 500000,
      closeAt: "10000",
      proposalDeadline: "20000",
      hardDeadline: "200000",
      challengeSeconds: 120,
      fundingType: "PLATFORM_RESEARCH_SUBSIDY",
      sourceEvidenceIds: [evidenceId],
      resolutionPolicy: {
        hardDeadlineOutcome: "INVALID",
        unfinalizedProposalAtHardDeadline: "INVALID",
        invalidPayoutRule: "HALF_PER_SIDE_NOT_PURCHASE_REFUND",
        authorityModel: "TEAM_OPERATED_WHITELISTED_ROLES",
      },
    },
  };
  return {
    candidate,
    request,
    evidence: [
      {
        evidenceId,
        entityId: "ACME",
        sourceUrl,
        sourceEnabled: true,
        accessPolicy: "PUBLIC" as "PUBLIC" | "PRIVATE" | "EXCERPT",
      },
    ],
    nowSeconds: 1n,
  };
}

test("approval preflight: rejects mismatched, stale, private, excessive-budget and LIVE proposals", () => {
  const cases: [string, (s: ReturnType<typeof fixture>) => void][] = [
    [
      "REVISION_CONFLICT",
      (s) => {
        s.request.expectedRevision = 2;
      },
    ],
    [
      "CANDIDATE_NOT_APPROVABLE",
      (s) => {
        s.candidate.state = "DEPLOY_PENDING";
      },
    ],
    [
      "CANDIDATE_NOT_APPROVABLE",
      (s) => {
        s.candidate.state = "REJECTED";
      },
    ],
    [
      "CANDIDATE_SPEC_MISMATCH",
      (s) => {
        s.request.spec.thresholdBps++;
      },
    ],
    [
      "CANDIDATE_SPEC_MISMATCH",
      (s) => {
        s.request.spec.entityId = "OTHER";
      },
    ],
    [
      "CANDIDATE_SPEC_MISMATCH",
      (s) => {
        s.request.spec.fiscalPeriod = "FY2025Q2";
      },
    ],
    [
      "CANDIDATE_EVIDENCE_MISMATCH",
      (s) => {
        s.request.spec.sourceEvidenceIds.push(
          s.request.spec.sourceEvidenceIds[0]!,
        );
      },
    ],
    [
      "CANDIDATE_EVIDENCE_MISMATCH",
      (s) => {
        s.request.spec.sourceEvidenceIds = ["unreviewed"];
      },
    ],
    [
      "EVIDENCE_SNAPSHOT_MISMATCH",
      (s) => {
        s.evidence = [];
      },
    ],
    [
      "EVIDENCE_SNAPSHOT_MISMATCH",
      (s) => {
        s.evidence.push(s.evidence[0]!);
      },
    ],
    [
      "EVIDENCE_NOT_ALLOWED",
      (s) => {
        s.evidence[0]!.sourceEnabled = false;
      },
    ],
    [
      "EVIDENCE_NOT_ALLOWED",
      (s) => {
        s.evidence[0]!.entityId = "OTHER";
      },
    ],
    [
      "EVIDENCE_NOT_ALLOWED",
      (s) => {
        s.evidence[0]!.sourceUrl = "http://ir.example.test/replay";
      },
    ],
    [
      "PRIVATE_APPROVAL_EVIDENCE",
      (s) => {
        s.evidence[0]!.accessPolicy = "PRIVATE";
      },
    ],
    [
      "SPEC_SOURCE_MISMATCH",
      (s) => {
        s.request.spec.sourceAllowlist.push("https://unreviewed.example.test/");
      },
    ],
    [
      "SPEC_SOURCE_MISMATCH",
      (s) => {
        s.request.spec.sourceAllowlist.push(s.request.spec.sourceAllowlist[0]!);
      },
    ],
    [
      "RESEARCH_BUDGET_OUT_OF_RANGE",
      (s) => {
        s.request.budgetMicros = "2000001";
      },
    ],
    [
      "RESEARCH_BUDGET_OUT_OF_RANGE",
      (s) => {
        s.request.budgetMicros = "0";
      },
    ],
    [
      "INVALID_APPROVAL_INPUT",
      (s) => {
        s.request.reason = "  ";
      },
    ],
    [
      "INVALID_APPROVAL_INPUT",
      (s) => {
        s.request.budgetMicros = "1.5";
      },
    ],
    [
      "MARKET_CLOSED",
      (s) => {
        s.nowSeconds = 10000n;
      },
    ],
    [
      "INVALID_APPROVAL_CLOCK",
      (s) => {
        s.nowSeconds = -1n;
      },
    ],
    [
      "LIVE_APPROVAL_DISABLED",
      (s) => {
        s.request.spec.mode = "LIVE";
        s.request.spec.challengeSeconds = 86400;
      },
    ],
  ];
  for (const [code, mutate] of cases) {
    const s = fixture();
    mutate(s);
    assert.throws(
      () => validateReplayApproval(s),
      (error: unknown) =>
        error instanceof ApprovalPolicyError && error.code === code,
      code,
    );
  }
  const good = fixture();
  good.request.budgetMicros = "1";
  good.evidence[0]!.accessPolicy = "EXCERPT";
  assert.equal(validateReplayApproval(good).request.budgetMicros, "1");
});

test("approval preflight: company-period capacity key ignores threshold and deployment", () => {
  const first = validateReplayApproval(fixture());
  const alternate = fixture();
  alternate.candidate.thresholdBps = alternate.request.spec.thresholdBps = 5000;
  alternate.request.deploymentId = "another-deployment";
  const second = validateReplayApproval(alternate);
  assert.equal(first.activeSlotKey, second.activeSlotKey);
  assert.notEqual(first.canonicalKey, second.canonicalKey);
  const differentPeriod = fixture();
  differentPeriod.candidate.fiscalPeriod =
    differentPeriod.request.spec.fiscalPeriod = "FY2025Q2";
  assert.notEqual(
    validateReplayApproval(differentPeriod).activeSlotKey,
    first.activeSlotKey,
  );
});

test("approval preflight: archives exact validated bytes but never claims DB approval or deployment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blink-approval-"));
  try {
    const archive = createSpecArchive(fileObjectStore(directory));
    const snapshot = fixture();
    const result = await prepareReplayApproval(archive, snapshot);
    assert.equal(result.state, "PREPARED_NOT_APPROVED");
    assert.deepEqual(
      await archive.read(result.specUri, result.specHash),
      result.bytes,
    );
    assert.deepEqual(
      JSON.parse(new TextDecoder().decode(result.bytes)),
      snapshot.request.spec,
    );
    assert.ok(!("approvalId" in result) && !("creationIntentId" in result));
    assert.equal(
      (await prepareReplayApproval(archive, snapshot)).specHash,
      result.specHash,
    );
    let writes = 0;
    const invalid = fixture();
    invalid.evidence[0]!.sourceEnabled = false;
    await assert.rejects(
      prepareReplayApproval(
        {
          async freeze() {
            writes++;
            throw new Error("must not write");
          },
          read: archive.read,
        },
        invalid,
      ),
      /EVIDENCE_NOT_ALLOWED/,
    );
    assert.equal(writes, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
