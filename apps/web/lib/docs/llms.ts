// https://llmstxt.org layout; links are host-relative (plus the static export's base path).
import { withBase } from "../base-path.ts";
import type { DocPage } from "./registry.ts";

export function llmsTxt(pages: readonly DocPage[]): string {
  const agents = pages.filter((p) => p.meta.group === "For agents");
  const human = pages.filter((p) => p.meta.group !== "For agents");
  const item = (p: DocPage) => `- [${p.meta.title}](${withBase(p.mdHref)}): ${p.meta.description}`;
  return [
    "# Blink",
    "",
    "> Experimental prediction-research platform for agents targeting Base Sepolia (84532). Backend and contracts implemented, not deployed; no public API host or trading on this read-only site. Local verification and fictional samples are REPLAY only; no paid model provider; LIVE approval rejected. Internal trader, expanded SDK/example agent and integrated local Alpha harness/readiness remain deferred.",
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
