import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunRecord } from "../video/src/run-record.ts";

const scenarios = ["normal", "dispute", "creation", "timeout", "suggestion"] as const;
const kept = new Set(["registered", "joined_role", "juror_staked", "market_created", "challenged", "suggestion_claimed", "rfq_posted", "quote_posted", "filled", "forecast_submitted", "anchor", "proposed", "committed", "revealed", "appealed", "distribute_fees", "redeemed", "claimed_rewards"]);

export function buildRunRecord(report: unknown, logs: ReadonlyMap<string, string>, meta: { commit: string; capturedOn: string }): RunRecord {
  const r = report as { result?: string; durationSeconds?: number; scenarios?: Record<string, { status?: string; durationSeconds?: number }>; roster?: string[] } | null;
  if (!r || r.result !== "pass" || !r.scenarios || scenarios.some(name => r.scenarios?.[name]?.status !== "pass" || typeof r.scenarios[name]?.durationSeconds !== "number") || Object.values(r.scenarios).some(s => s?.status !== "pass")) throw new Error("RUN_NOT_PASSED");
  if (!Array.isArray(r.roster)) throw new Error("RUN_ROSTER_INCOMPLETE");
  const roster: { agent: string; roles: string[] }[] = [];
  const events: { timestamp: number; agent: string; event: string; market?: string }[] = [];
  for (const agent of r.roster) {
    let roles: string[] | undefined;
    for (const line of (logs.get(agent) ?? "").split("\n")) {
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== "object") continue;
      if (entry.event === "started" && entry.agent === agent && Array.isArray(entry.roles) && entry.roles.every((role: unknown) => typeof role === "string")) roles = entry.roles;
      if (!kept.has(entry.event) || entry.agent !== agent || typeof entry.ts !== "string") continue;
      const timestamp = Date.parse(entry.ts);
      if (!Number.isFinite(timestamp)) continue;
      events.push({ timestamp, agent, event: entry.event, ...(typeof entry.marketId === "string" ? { market: entry.marketId.slice(0, 10) } : {}) });
    }
    if (!roles) throw new Error(`RUN_ROSTER_INCOMPLETE:${agent}`);
    roster.push({ agent, roles });
  }
  if (!events.length) throw new Error("RUN_EVENTS_MISSING");
  const earliest = Math.min(...events.map(event => event.timestamp));
  const normalized = events.map(({ timestamp, ...event }) => ({ t: Math.floor((timestamp - earliest) / 1000), ...event }));
  normalized.sort((a, b) => a.t - b.t || (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
  return { schema: "blink.video-run/1", source: "pnpm alpha:autonomous", ...meta, chainId: 84532, durationSeconds: r.durationSeconds!, scenarios: scenarios.map(name => ({ name, status: "pass", durationSeconds: r.scenarios![name]!.durationSeconds! })), roster, events: normalized };
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const input = resolve(root, "tmp/alpha-autonomous");
  const report = JSON.parse(await readFile(resolve(input, "report.json"), "utf8"));
  const logs = new Map<string, string>();
  for (const agent of Array.isArray(report?.roster) ? report.roster : []) logs.set(agent, await readFile(resolve(input, "agents", `${agent}.log`), "utf8"));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const record = buildRunRecord(report, logs, { commit, capturedOn: new Date().toISOString().slice(0, 10) });
  await writeFile(resolve(root, "video/data/drill-run.json"), JSON.stringify(record, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
