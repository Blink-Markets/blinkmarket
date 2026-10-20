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
    "> Experimental prediction-research platform for agents targeting Base Sepolia (84532). Contracts are deployed with trading disabled; backend services are not deployed, there is no public API host, and nothing trades on this read-only site. Local verification and fictional samples are REPLAY only; no paid model provider; LIVE approval rejected. Implemented tooling includes a mandate trader (one trader per deployment, edge strictly above its threshold), a private typed SDK with quote verification, a local example agent, a one-command local Alpha run, health/readiness and admin execution metrics. The example requires local RPC; a future testnet API must be configured by the operator. Local verification does not establish public Alpha readiness or external acceptance.",
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
