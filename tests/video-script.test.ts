import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shots, screen, music } from "../video/src/script.ts";
import { shotFrames, totalFrames, BASE_SECONDS, timeScale } from "../video/src/time.ts";
import { assertShowcaseClean } from "./showcase-claims.ts";

test("the cut is 117 beats on the 120 BPM grid", () => {
  assert.deepEqual(shots.map((s) => [s.id, s.beats]), [["hook", 8], ["montage", 28], ["goes-live", 9], ["trading", 10], ["dispute", 14], ["human", 7], ["browse", 24], ["free", 6], ["ending", 11]]);
  assert.equal(BASE_SECONDS, 58.5);
  assert.deepEqual(shotFrames(30, 120).map((f) => f.from), [0, 120, 540, 675, 825, 1035, 1140, 1500, 1590]);
  assert.equal(totalFrames(30, 120), 1755);
});
test("a track from 115 to 125 BPM keeps the cut contiguous and within 55-62 s", () => {
  for (const bpm of [115, 125]) {
    const frames = shotFrames(30, bpm);
    frames.forEach((f, i) => assert.equal(f.from, i === 0 ? 0 : frames[i - 1]!.from + frames[i - 1]!.durationInFrames));
    const seconds = totalFrames(30, bpm) / 30;
    assert.ok(seconds >= 55 && seconds <= 62, String(seconds));
  }
  assert.equal(timeScale(120), 1);
});
test("every line is in the script doc, and every accent is part of its line", () => {
  const doc = readFileSync("docs/INTRO_VIDEO_SCRIPT.md", "utf8");
  for (const s of shots) for (const l of s.lines) {
    assert.ok(doc.includes(l.text), `${s.id}: ${l.text}`);
    if (l.accent) assert.ok(l.text.endsWith(l.accent), `${s.id}: ${l.accent}`);
  }
});
test("the video copy is true to the protocol", () => {
  const text = JSON.stringify({ shots, screen, music });
  assertShowcaseClean(text, "video/src/script.ts");
  assert.doesNotMatch(text, /\bsell/i);
  assert.doesNotMatch(text, /\b(thousands|hundreds|millions) of agents\b|\b\d[\d,]* agents\b|24\/7|around the clock|round-the-clock/i);
  assert.doesNotMatch(text, /https?:|www\.|\.github\.io/);
  assert.equal(screen.goesLive.newMarket.probability, null);
  assert.equal(screen.trading.consensusLabel, "Agent consensus");
  assert.deepEqual(screen.trading.traderLines, ["Buy YES!", "Buy NO."]);
  assert.deepEqual(shots.find((s) => s.id === "trading")!.lines.map((l) => l.text), ["They forecast.", "They trade.", "On what they believe."]);
});

test("product shot copy preserves the new market and dispute beats", () => {
  assert.equal(screen.goesLive.empty, "—");
  assert.equal(screen.goesLive.markets.length, 4);
  assert.deepEqual(screen.trading.forecasts, ["41%", "63%"]);
  assert.equal(screen.dispute.toast, "Challenge upheld · answer corrected");
});
