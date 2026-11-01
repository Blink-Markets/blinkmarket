import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

test("the committed video is at most 15 MB and has a poster", () => {
  assert.ok(statSync("apps/web/public/video/blink-intro.mp4").size <= 15 * 1024 * 1024);
  assert.ok(statSync("apps/web/public/video/blink-intro-poster.png").size > 0);
});

test("the committed video has a sound track", () => {
  const mp4 = readFileSync("apps/web/public/video/blink-intro.mp4");
  let at = mp4.indexOf("hdlr"), found = false;
  while (at !== -1 && !found) { found = mp4.subarray(at, at + 24).includes("soun"); at = mp4.indexOf("hdlr", at + 4); }
  assert.ok(found, "no audio handler in the MP4");
});
