import { test } from "node:test";
import assert from "node:assert/strict";
import {
  plannedWindows,
  snapshotPriceBase,
} from "../packages/domain/src/forecast-windows.ts";

test("plans future UTC deadlines, including overlapping horizons, without backfill", () => {
  const closeAt = new Date("2026-10-17T01:00:00Z");
  const windows = plannedWindows({
    closeAt,
    now: new Date("2026-10-14T01:00:00Z"),
  });
  assert.equal(windows.length, 4);
  assert.deepEqual(
    windows.map((w) => [w.horizonType, w.scheduledAt.toISOString()]),
    [
      ["DAILY", "2026-10-15T00:00:00.000Z"],
      ["DAILY", "2026-10-16T00:00:00.000Z"],
      ["DAILY", "2026-10-17T00:00:00.000Z"],
      ["PRE_CLOSE", "2026-10-17T00:00:00.000Z"],
    ],
  );
  for (const w of windows) {
    assert.equal(w.deadline.getTime(), w.scheduledAt.getTime());
    assert.equal(w.deadline.getTime() - w.openAt.getTime(), 1_800_000);
  }
  assert.equal(
    plannedWindows({ closeAt, now: new Date("2026-10-16T23:50:00Z") }).length,
    2,
  );
  assert.equal(
    plannedWindows({ closeAt, now: new Date("2026-10-17T00:00:00Z") }).length,
    0,
  );
  assert.equal(
    plannedWindows({ closeAt, now: new Date("2026-10-17T00:01:00Z") }).length,
    0,
  );
});

test("snapshot price uses integer millionths and rounds each side upward", () => {
  for (const [sum, yes, no] of [
    [1200000, 6000, 4000],
    [1200001, 6001, 4000],
    [0, 0, 10000],
    [2000000, 10000, 0],
  ]) {
    assert.equal(
      snapshotPriceBase({ probabilitySumMillionths: sum!, side: "YES" }),
      yes,
    );
    assert.equal(
      snapshotPriceBase({ probabilitySumMillionths: sum!, side: "NO" }),
      no,
    );
  }
});
