import { test } from "node:test";
import assert from "node:assert/strict";
import { brierExact } from "../packages/domain/src/brier.ts";

test("Brier uses exact integer arithmetic including half-millionth ensembles", () => {
  assert.equal(brierExact(1400000n, 1), "0.09");
  assert.equal(brierExact(1300000n, 0), "0.4225");
  assert.equal(brierExact(246914n, 0), "0.015241630849");
  assert.equal(brierExact(246914n, 1), "0.768327630849");
  assert.equal(brierExact(1200001n, 0), "0.36000060000025");
  assert.equal(brierExact(0n, 0), "0");
  assert.equal(brierExact(0n, 1), "1");
  assert.equal(brierExact(2000000n, 1), "0");
  assert.throws(() => brierExact(-1n, 0));
  assert.throws(() => brierExact(2000001n, 1));
});
