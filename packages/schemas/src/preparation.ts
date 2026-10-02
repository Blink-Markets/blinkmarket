import { z } from "zod";
import { Hash } from "./core.js";

const Label = z.string().trim().min(1).max(4000);
export const CandidateInput = z.strictObject({
  templateId: z.literal("GM_LT_V1"),
  entityId: Label,
  fiscalPeriod: Label,
  thresholdBps: z.number().int().min(0).max(10000),
  evidenceIds: z
    .array(z.uuid().transform((v) => v.toLowerCase()))
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate evidence")
    .transform((ids) => [...ids].sort()),
  thesis: Label,
});
export const CandidateRevisionInput = CandidateInput.extend({
  expectedRevision: z.number().int().positive(),
});
export const CandidateRecord = CandidateInput.extend({
  candidateId: z.uuid(),
  revision: z.number().int().positive(),
  state: z.enum([
    "DRAFT",
    "VALIDATING",
    "NEEDS_REVISION",
    "REJECTED",
    "APPROVED",
    "DEPLOY_PENDING",
    "DEPLOYED",
  ]),
});
export const EvidenceMetadata = z.strictObject({
  evidenceId: z.uuid(),
  sourceUrl: z.url(),
  observedAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullable(),
  contentHash: Hash,
  accessPolicy: z.enum(["PUBLIC", "EXCERPT", "PRIVATE"]),
  excerpt: z.string().max(4000).nullable(),
});
export const EvidenceImport = z
  .strictObject({
    sourceId: z.uuid(),
    operatorId: z.uuid(),
    publishedAt: z.iso.datetime().nullable(),
    accessPolicy: EvidenceMetadata.shape.accessPolicy,
    excerpt: EvidenceMetadata.shape.excerpt,
    reason: Label,
  })
  .refine(
    (v) => v.accessPolicy !== "EXCERPT" || !!v.excerpt?.trim(),
    "EXCERPT requires reviewed text",
  );
export type CandidateInput = z.infer<typeof CandidateInput>;
export type CandidateRecord = z.infer<typeof CandidateRecord>;
export type EvidenceMetadata = z.infer<typeof EvidenceMetadata>;
