import { groupOperations, indexOpenApi } from "../../content/openapi-index.ts";

export function apiIndexMarkdown(doc: unknown): string {
  const lines: string[] = [];
  for (const { group, operations } of groupOperations(indexOpenApi(doc))) {
    lines.push(`## ${group}`, "", "| Method | Path | Access |", "| --- | --- | --- |");
    // Operations without an access value are public reads (only GET /v1/config, public per the MVP spec §10.2).
    for (const op of operations) lines.push(`| ${op.method} | \`${op.path}\` | ${op.access ?? "public"} |`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
