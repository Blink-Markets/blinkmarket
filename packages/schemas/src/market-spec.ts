import { z } from "zod";
import { Hash } from "./core.ts";

const text = (max: number) => z.string().min(1).max(max);

export const MarketSpecV02 = z
  .strictObject({
    schema: z.literal("blink.market-spec/0.2"),
    title: text(200),
    question: text(2000),
    class: z.enum(["A", "B", "C"]),
    resolution: z.strictObject({
      yes: text(2000),
      no: text(2000),
      invalid: z.string().max(2000).optional(),
    }),
    sources: z.array(z.url({ protocol: /^https$/ })).max(10),
    computation: z
      .strictObject({
        templateId: Hash,
        parserHash: Hash,
        extraction: z.string().max(2000),
      })
      .optional(),
    suggestionId: z.uuid().optional(),
  })
  .superRefine((spec, ctx) => {
    if (spec.class === "A" && !spec.computation)
      ctx.addIssue({
        code: "custom",
        path: ["computation"],
        message: "Class A requires computation",
      });
  });
export type MarketSpecV02 = z.infer<typeof MarketSpecV02>;

export type ParsedMarketSpec =
  | { ok: true; spec: MarketSpecV02; bytes: Uint8Array }
  | { ok: false; reason: string };

/**
 * Parses frozen spec bytes. The spec hash is keccak256 of exactly these bytes, so the result hands
 * the input back untouched and nothing here ever serializes the spec again.
 */
export function parseMarketSpec(bytes: Uint8Array): ParsedMarketSpec {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { ok: false, reason: "BOM" };
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "INVALID_UTF8" };
  }
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return { ok: false, reason: "INVALID_JSON" };
  }
  const parsed = MarketSpecV02.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return {
      ok: false,
      reason: `INVALID_SPEC: ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    };
  }
  return { ok: true, spec: parsed.data, bytes };
}
