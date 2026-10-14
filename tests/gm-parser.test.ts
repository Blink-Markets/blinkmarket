import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGrossMargin } from "../packages/domain/src/gm-parser.ts";
for (const [text, expected] of [
  ["GAAP gross margin was 61%", 6100],
  ["GAAP gross margin 61.25%", 6125],
  ["GAAP gross margin 61.2 percent", 6120],
  ["GAAP gross margin 61％", 6100],
  ["GAAP gross margin of 61.2 percent", 6120],
  ["GAAP gross margin 61% and GAAP gross margin 61.00%", 6100],
  ["GAAP gross margin 61% and GAAP gross margin 62%", "MULTIPLE_VALUES"],
  ["GAAP gross margin 61.255%", "PRECISION"],
  ["non-GAAP gross margin 61%", "NON_GAAP_ONLY"],
  ["Non GAAP gross margin 61%", "NON_GAAP_ONLY"],
  ["GAAP gross margin " + "x".repeat(81) + " 61%", "NONE"],
  ["gross margin 61%", "NONE"],
  ["GAAP gross margin 0%", 0],
  ["GAAP gross margin 100%", 10000],
  ["non-GAAP gross margin 80%; GAAP gross margin 61%", 6100],
] as const)
  test(`parse ${text.slice(0, 90)}`, () => {
    const result = parseGrossMargin(text);
    if (typeof expected === "string")
      assert.deepEqual(result, { ambiguous: true, reason: expected });
    else {
      assert.ok("valueBps" in result);
      assert.equal(result.valueBps, expected);
      assert.equal(
        text.slice(result.locator.start, result.locator.end),
        result.locator.excerpt,
      );
    }
  });
test("a single phrase with distinct nearby percentages requires review", () => {
  assert.deepEqual(parseGrossMargin("GAAP gross margin 61% versus 62%"), {
    ambiguous: true,
    reason: "MULTIPLE_VALUES",
  });
});

test("signed gross margins retain their value for outcome comparison", () => {
  const negative = parseGrossMargin("GAAP gross margin was -0.25%");
  assert.ok("valueBps" in negative);
  assert.equal(negative.valueBps, -25);
  const over100 = parseGrossMargin("GAAP gross margin was 101%");
  assert.ok("valueBps" in over100);
  assert.equal(over100.valueBps, 10100);
});
