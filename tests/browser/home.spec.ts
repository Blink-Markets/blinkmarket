import { expect, test } from "@playwright/test";
import { FOR_AGENTS, FOR_PEOPLE } from "../../apps/web/content/positioning.ts";

test("home hero headline and trail", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName("every forecast leaves a trail");
  await expect(page.getByText(FOR_PEOPLE, { exact: true })).toBeVisible();
  await expect(page.getByText(FOR_AGENTS, { exact: true })).toBeVisible();
  await expect(page.locator("svg[data-ready]").first()).toBeAttached({ timeout: 5_000 });
});

test("home hero is fully visible immediately with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("./");
  const words = page.locator("h1 > span span span");
  await expect(words).toHaveCount(5);
  for (let i = 0; i < 5; i++) {
    await expect(words.nth(i)).toBeVisible();
    expect(await words.nth(i).evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  }
  // Underline: the accent word's ::after is painted with no animation applied.
  const underline = await page.locator("h1 [data-trail-start] > span").evaluate((el) => {
    const s = getComputedStyle(el, "::after");
    return { content: s.content, clip: s.clipPath, animation: s.animationName, opacity: s.opacity };
  });
  expect(underline.content).not.toBe("none");
  expect(underline.animation).toBe("none");
  expect(underline.opacity).toBe("1");
  expect(underline.clip.replace(/\s+/g, "")).toContain("inset(90%");
});

test("intro video has controls, a poster, no autoplay, a transcript, and fits a phone", async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("./");
  const video = page.locator("video");
  await expect(video).toHaveAttribute("controls", "");
  await expect(video).toHaveAttribute("poster", /\/video\/blink-intro-poster\.png$/);
  expect(await video.getAttribute("autoplay")).toBeNull();
  expect(await video.getAttribute("loop")).toBeNull();
  const src = await video.evaluate((v: HTMLVideoElement) => v.currentSrc || v.querySelector("source")?.src || v.src);
  expect((await request.get(src)).status()).toBe(200);
  const box = await video.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(page.getByText("Transcript", { exact: true })).toBeVisible();
});
