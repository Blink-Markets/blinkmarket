import { test } from "node:test";
import assert from "node:assert/strict";
import type { JobType } from "../packages/domain/src/index.js";
import { jobs } from "../apps/worker/src/registry.js";

const expected = [
  "forecast.schedule",
  "alert.deliver",
  "alert.evaluate",
  "evaluation.score",
  "operations.prune",
] as const;
// Fails to compile if JobType gains or loses a member relative to the list above.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const exactJobType: Same<JobType, (typeof expected)[number]> = true;

test("JobType and the worker registry list exactly the planned job types", () => {
  assert.equal(exactJobType, true);
  assert.deepEqual([...jobs], [...expected]);
});
