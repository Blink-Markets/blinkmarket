// Minimal "key: value" frontmatter; no library.
import { DOC_GROUPS, type DocGroup } from "./ia.ts";

export type DocMeta = { title: string; description: string; group: DocGroup; order: number; agentTask: string };
const FIELDS = ["title", "description", "group", "order", "agentTask"] as const;

export function parseFrontmatter(source: string): { meta: DocMeta; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) throw new Error("frontmatter: missing block");
  const raw: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) raw[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const f of FIELDS) if (!raw[f]) throw new Error(`frontmatter: missing ${f}`);
  const group = raw["group"] as DocGroup;
  if (!(DOC_GROUPS as readonly string[]).includes(group)) throw new Error(`frontmatter: unknown group ${raw["group"]}`);
  const order = Number(raw["order"]);
  if (!Number.isInteger(order)) throw new Error("frontmatter: order must be an integer");
  return {
    meta: { title: raw["title"]!, description: raw["description"]!, group, order, agentTask: raw["agentTask"]! },
    body: source.slice(match[0].length),
  };
}
