import { test } from "node:test";
import assert from "node:assert/strict";
import { keeperDecision, keeperDueSince } from "../packages/domain/src/keeper.ts";

test("keeper decisions use inclusive chain-time boundaries and never finalize FINAL", () => {
  const market = {
    state: "PROPOSED" as const,
    proposedAt: 100n,
    challengeSeconds: 120n,
    hardDeadline: 400n,
  };
  assert.equal(keeperDecision(market, 219n), null);
  assert.equal(keeperDecision(market, 220n), "FINALIZE_UNCHALLENGED");
  assert.equal(
    keeperDecision({ ...market, challengeSeconds: 120 }, 220n),
    "FINALIZE_UNCHALLENGED",
  );
  assert.equal(keeperDecision(market, 399n), "FINALIZE_UNCHALLENGED");
  assert.equal(keeperDecision(market, 400n), "FINALIZE_TIMEOUT");
  assert.equal(keeperDecision({ ...market, state: "DISPUTED" }, 399n), null);
  assert.equal(
    keeperDecision({ ...market, state: "DISPUTED" }, 400n),
    "FINALIZE_TIMEOUT",
  );
  assert.equal(
    keeperDecision({ ...market, state: "OPEN", proposedAt: null }, 400n),
    "FINALIZE_TIMEOUT",
  );
  assert.equal(keeperDecision({ ...market, state: "FINAL" }, 400n), null);
});

test("keeperDueSince is exactly when keeperDecision starts returning a decision", () => {
  const states = ["OPEN", "PROPOSED", "DISPUTED", "FINAL"] as const;
  for (const state of states)
    for (const proposedAt of [null, 100n])
      for (const challengeSeconds of [0, 120, 300n])
        for (const hardDeadline of [150n, 220n, 400n]) {
          const market = { state, proposedAt, challengeSeconds, hardDeadline };
          const dueSince = keeperDueSince(market);
          for (let now = 0n; now <= 500n; now += 1n)
            assert.equal(
              keeperDecision(market, now) !== null,
              dueSince !== null && now >= dueSince,
              JSON.stringify([state, proposedAt, challengeSeconds, hardDeadline, now].map(String)),
            );
        }
  const proposed = {
    state: "PROPOSED" as const,
    proposedAt: 100n,
    challengeSeconds: 120,
    hardDeadline: 400n,
  };
  assert.equal(keeperDueSince(proposed), 220n);
  assert.equal(keeperDueSince({ ...proposed, state: "DISPUTED" }), 400n);
});
