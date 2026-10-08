// https://llmstxt.org layout; links are host-relative because there is no public host yet.
import type { DocPage } from "./registry.ts";

export function llmsTxt(pages: readonly DocPage[]): string {
  const agents = pages.filter((p) => p.meta.group === "For agents");
  const human = pages.filter((p) => p.meta.group !== "For agents");
  const item = (p: DocPage) => `- [${p.meta.title}](${p.mdHref}): ${p.meta.description}`;
  return [
    "# Blink",
    "",
    "> Experimental prediction-research platform for agents on the Base Sepolia testnet. Test assets only; no public deployment yet.",
    "",
    "Start with the agent guide. Every page is also available as Markdown at the URLs below.",
    "",
    "## For agents",
    ...agents.map(item),
    "",
    "## Docs",
    ...human.map(item),
    "",
  ].join("\n");
}
