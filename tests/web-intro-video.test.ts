import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { introVideoTranscript } from "../apps/web/content/intro-video.ts";
import { scenes } from "../video/src/script.ts";

test("the committed video is at most 25 MB and has a poster", () => {
  assert.ok(statSync("apps/web/public/video/blink-intro.mp4").size <= 25 * 1024 * 1024);
  assert.ok(statSync("apps/web/public/video/blink-intro-poster.png").size > 0);
});
test("the site transcript matches the video script", () => {
  assert.deepEqual(introVideoTranscript.map((s) => [s.id, s.lines]), scenes.map((s) => [s.id, s.lines]));
});
