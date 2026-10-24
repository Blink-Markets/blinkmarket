import { z } from "zod";
import { Hash } from "./core.ts";

const Label = z.string().trim().min(1).max(4000);
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
export type EvidenceMetadata = z.infer<typeof EvidenceMetadata>;
