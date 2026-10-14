import { test } from "node:test";
import assert from "node:assert/strict";
import { keeperDecision } from "../packages/domain/src/keeper.ts";

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
