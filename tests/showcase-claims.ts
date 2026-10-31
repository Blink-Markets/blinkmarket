import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const PLATFORM_NAMES = /\b(Polymarket|Kalshi|Limitless|Seer|Olas|UMA|Kleros|Manifold|Augur)\b/;
export const STATUS_PHRASES = /under construction|\bdeployed\b|\b(live|public) deployment\b|after deployment|verified locally|local verification|\bimplemented\b/i;
export const INVITATIONS = /connect (your )?wallet|\bsign (up|in)\b|\bjoin (as|the)\b|suggest a question|start trading/i;

export function assertShowcaseClean(text: string, label: string): void {
  for (const pattern of [PLATFORM_NAMES, STATUS_PHRASES, INVITATIONS]) assert.doesNotMatch(text, pattern, label);
}

export function showcaseSources(): string[] {
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      // Docs are agent documentation and retain operational facts such as deployment state.
      if (path === "apps/web/app/docs" || path === "apps/web/components/docs") return [];
      return entry.isDirectory() ? files(path) : /\.tsx?$/.test(path) ? [path] : [];
    });
  }
  return [...files("apps/web/app"), ...files("apps/web/components"), ...["advantages", "positioning", "sample-markets"].map((name) => `apps/web/content/${name}.ts`)];
}
