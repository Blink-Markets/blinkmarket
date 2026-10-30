import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunRecord } from "../scripts/video-capture.ts";

const meta = { commit: "a".repeat(40), capturedOn: "2026-11-01" };
const passingReport = { result: "pass", durationSeconds: 10, roster: ["maker-1"], scenarios: Object.fromEntries(["normal", "dispute", "creation", "timeout", "suggestion"].map(name => [name, { status: "pass", durationSeconds: 1 }])) };
const started = (agent: string) => JSON.stringify({ agent, event: "started", roles: ["maker"], secret: "SECRET" });

test("capture keeps only whitelisted events and fields", () => {
  const logs = new Map([["maker-1", [started("maker-1"), JSON.stringify({ ts: "2026-11-01T00:00:10Z", agent: "maker-1", event: "quote_posted", marketId: "0xabcdef0123456789", rfqId: "r1", apiKey: "blink_sk_SECRET", key: "0x" + "11".repeat(32) }), JSON.stringify({ ts: "2026-11-01T00:00:05Z", agent: "maker-1", event: "api_key_issued", secret: "SECRET" }), "not json"].join("\n")]]);
  const r = buildRunRecord(passingReport, logs, meta);
  assert.deepEqual(r.events, [{ t: 0, agent: "maker-1", event: "quote_posted", market: "0xabcdef01" }]);
  assert.deepEqual(r.roster, [{ agent: "maker-1", roles: ["maker"] }]);
  assert.ok(!JSON.stringify(r).includes("SECRET") && !JSON.stringify(r).includes("11".repeat(32)));
});

test("capture refuses a failed or missing scenario", () => {
  assert.throws(() => buildRunRecord({ ...passingReport, result: "fail" }, new Map(), meta), /RUN_NOT_PASSED/);
  assert.throws(() => buildRunRecord({ ...passingReport, scenarios: { ...passingReport.scenarios, normal: { status: "fail" } } }, new Map(), meta), /RUN_NOT_PASSED/);
  assert.throws(() => buildRunRecord({ ...passingReport, scenarios: {} }, new Map(), meta), /RUN_NOT_PASSED/);
});

test("a roster agent needs a started line", () => {
  assert.throws(() => buildRunRecord(passingReport, new Map([["maker-1", "{}"]]), meta), /RUN_ROSTER_INCOMPLETE/);
});

test("events are ordered by time, then agent", () => {
  const line = (agent: string, ts: string) => JSON.stringify({ agent, ts, event: "registered" });
  const logs = new Map([["b", [started("b"), line("b", "2026-11-01T00:00:02Z"), line("b", "2026-11-01T00:00:01Z")].join("\n")], ["a", [started("a"), line("a", "2026-11-01T00:00:02Z")].join("\n")]]);
  const r = buildRunRecord({ ...passingReport, roster: ["b", "a"] }, logs, meta);
  assert.deepEqual(r.events.map(({ t, agent }) => [t, agent]), [[0, "b"], [1, "a"], [1, "b"]]);
});
