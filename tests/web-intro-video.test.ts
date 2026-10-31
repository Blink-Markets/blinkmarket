import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";

test("the committed video is at most 15 MB and has a poster", () => {
  assert.ok(statSync("apps/web/public/video/blink-intro.mp4").size <= 15 * 1024 * 1024);
  assert.ok(statSync("apps/web/public/video/blink-intro-poster.png").size > 0);
});
