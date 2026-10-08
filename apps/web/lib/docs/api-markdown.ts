import { groupOperations, indexOpenApi } from "../../content/openapi-index.ts";

export function apiIndexMarkdown(doc: unknown): string {
  const lines: string[] = [];
  for (const { group, operations } of groupOperations(indexOpenApi(doc))) {
    lines.push(`### ${group}`, "", "| Method | Path | Planned access | Status |", "| --- | --- | --- | --- |");
    for (const op of operations) lines.push(`| ${op.method} | \`${op.path}\` | ${op.access ?? "—"} | ${op.status} |`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
