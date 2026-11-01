import { expect, test, type Locator, type Page } from "@playwright/test";
import { advantages } from "../../apps/web/content/advantages.ts";
import { FOR_AGENTS, FOR_PEOPLE } from "../../apps/web/content/positioning.ts";

test("home hero headline and trail", async ({ page }) => {
  await page.goto("./");
  const hero = page.locator("section").filter({ has: page.getByRole("heading", { level: 1 }) });
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName("every forecast leaves a trail");
  await expect(hero.getByText(FOR_PEOPLE, { exact: true })).toBeVisible();
  await expect(hero.getByText(FOR_AGENTS, { exact: true })).toBeVisible();
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

test("the video sits inline under the hero: controls, poster, muted, no transcript, fits a phone", async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("./");
  const video = page.locator("video");
  await expect(video).toHaveCount(1);
  await expect(video).toHaveAttribute("aria-label", /^Blink introduction, about one minute, with music/);
  await expect(video).toHaveAttribute("controls", "");
  await expect(video).toHaveAttribute("preload", "none");
  await expect(video).toHaveAttribute("poster", /\/video\/blink-intro-poster\.png$/);
  for (const attr of ["autoplay", "loop"]) expect(await video.getAttribute(attr)).toBeNull();
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  const src = await video.evaluate((v: HTMLVideoElement) => v.querySelector("source")?.src ?? v.src);
  expect((await request.get(src)).status()).toBe(200);
  expect((await video.boundingBox())!.width).toBeLessThanOrEqual(375);
  await expect(page.getByText("Transcript")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Watch" })).toHaveCount(0);
  const order = await page.evaluate(() => {
    const at = (el: Element | null) => (el ? Array.from(document.querySelectorAll("*")).indexOf(el) : -1);
    return [at(document.querySelector("h1")), at(document.querySelector("video")), at(Array.from(document.querySelectorAll("h2")).find((h) => h.textContent?.startsWith("Coordination off-chain")) ?? null)];
  });
  expect(order[0]).toBeLessThan(order[1]!);
  expect(order[1]).toBeLessThan(order[2]!);
});

// Each engine decodes MP4 differently, so these tests fake playback and check only the scroll logic.
async function fakePlayback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: string[] = [];
    const playing = new WeakSet<HTMLMediaElement>();
    Object.assign(window, { mediaCalls: calls });
    Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get(this: HTMLMediaElement) { return !playing.has(this); } });
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) { playing.add(this); calls.push("play"); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) { playing.delete(this); calls.push("pause"); };
  });
}
const mediaCalls = (page: Page) => page.evaluate(() => (window as unknown as { mediaCalls: string[] }).mediaCalls);
const scrollToEnd = (page: Page) => page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
// Waits until the video has left the viewport, then lets the page's own observer run.
async function scrollAway(page: Page, video: Locator): Promise<void> {
  await scrollToEnd(page);
  await expect(video).not.toBeInViewport();
  await settle(page);
}
// Waits until at least half of the video is in view, then lets the page's own observer run.
async function scrollTo(page: Page, video: Locator): Promise<void> {
  await video.scrollIntoViewIfNeeded();
  await expect(video).toBeInViewport({ ratio: 0.5 });
  await settle(page);
}
const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

test("the video plays in view, pauses out of view, and a viewer's pause sticks", async ({ page }) => {
  await fakePlayback(page);
  await page.goto("./");
  const video = page.locator("video");
  await video.scrollIntoViewIfNeeded();
  await expect.poll(() => mediaCalls(page)).toEqual(["play"]);
  await scrollToEnd(page);
  await expect.poll(() => mediaCalls(page)).toEqual(["play", "pause"]);
  await video.scrollIntoViewIfNeeded();
  await expect.poll(() => mediaCalls(page)).toEqual(["play", "pause", "play"]);
  await video.evaluate((v: HTMLVideoElement) => v.pause());
  await scrollAway(page, video);
  await scrollTo(page, video);
  expect(await mediaCalls(page)).toEqual(["play", "pause", "play", "pause"]);
});

test("with reduced motion the video waits for the viewer", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fakePlayback(page);
  await page.goto("./");
  await expect(page.locator("svg[data-ready]").first()).toBeAttached();
  await scrollTo(page, page.locator("video"));
  expect(await mediaCalls(page)).toEqual([]);
});

test("the advantages continue the home page and /advantages is gone", async ({ page }) => {
  await page.goto("./");
  const section = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Liquidity on request, and no custody" }) });
  await expect(section.locator("article h3")).toHaveText(advantages.map((a) => a.title));
  for (const a of advantages) await expect(section.locator(`article#${a.id}`).getByRole("link", { name: "Read more →" })).toHaveAttribute("href", new RegExp(`${a.docs}/?$`));
  expect((await page.goto("./advantages"))?.status()).toBe(404);
});
