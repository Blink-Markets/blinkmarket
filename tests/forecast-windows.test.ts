import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WINDOW_SCHEDULE,
  assertWindowSchedule,
  plannedWindows,
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

test("schedule shortens PRE_CLOSE for alpha", () => {
  const closeAt = new Date("2026-10-14T10:10:00Z");
  const now = new Date("2026-10-14T10:00:00Z");
  const windows = plannedWindows({
    closeAt,
    now,
    schedule: { preCloseLeadSeconds: 120, openSeconds: 60 },
  });
  assert.deepEqual(
    windows.map((w) => [w.horizonType, w.openAt.toISOString(), w.deadline.toISOString()]),
    [["PRE_CLOSE", "2026-10-14T10:07:00.000Z", "2026-10-14T10:08:00.000Z"]],
  );
  // Past the shortened deadline, nothing is planned.
  assert.equal(
    plannedWindows({
      closeAt,
      now: new Date("2026-10-14T10:08:00Z"),
      schedule: { preCloseLeadSeconds: 120, openSeconds: 60 },
    }).length,
    0,
  );
  // DAILY windows keep their 30 minutes whatever the schedule says.
  const daily = plannedWindows({
    closeAt: new Date("2026-10-16T00:30:00Z"),
    now: new Date("2026-10-14T10:00:00Z"),
    schedule: { preCloseLeadSeconds: 120, openSeconds: 60 },
  }).filter((w) => w.horizonType === "DAILY");
  assert.equal(daily.length, 2);
  for (const w of daily) assert.equal(w.deadline.getTime() - w.openAt.getTime(), 1_800_000);
});

test("the default schedule is the one-hour lead and half-hour window", () => {
  assert.deepEqual(DEFAULT_WINDOW_SCHEDULE, { preCloseLeadSeconds: 3600, openSeconds: 1800 });
});

test("an invalid schedule is refused", () => {
  for (const schedule of [
    { preCloseLeadSeconds: 0, openSeconds: 0 },
    { preCloseLeadSeconds: 60, openSeconds: 61 },
    { preCloseLeadSeconds: 1.5, openSeconds: 1 },
    { preCloseLeadSeconds: -60, openSeconds: 30 },
    { preCloseLeadSeconds: Number.NaN, openSeconds: 30 },
  ])
    assert.throws(
      () => assertWindowSchedule(schedule),
      /INVALID_FORECAST_WINDOW_SCHEDULE/,
    );
  assertWindowSchedule({ preCloseLeadSeconds: 60, openSeconds: 60 });
});
