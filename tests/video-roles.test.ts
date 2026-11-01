import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "../video/src/roles.ts";
import { shots } from "../video/src/script.ts";

test("role looks, pitches and montage order match the cast", () => {
  assert.deepEqual(ROLES.map(({ id, color, accessory, aspect, pitch }) => [id, color, accessory, aspect, pitch]), [
    ["creator", "#2148b8", "antenna", 1, 523], ["maker", "#7a5cd6", "bars", 1.3, 440],
    ["trader", "#d4562f", "coin", 1, 659], ["forecaster", "#2f9fd0", "goggles", 1, 784],
    ["proposer", "#1d1c1a", "flag", 1, 587], ["challenger", "#e3a62a", "brows", 1, 494],
    ["juror", "#2f9e6e", "cap", 1, 392], ["keeper", "#e0679a", "clock", 1, 698],
  ]);
  for (const [i, role] of ROLES.entries()) {
    const plural = role.id[0]!.toUpperCase() + role.id.slice(1) + "s";
    assert.ok(shots[1]!.lines[i]!.text.startsWith(`${plural} `));
  }
});
