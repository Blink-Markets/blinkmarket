import { expect, test } from "@playwright/test";

test("home hero headline and trail", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName("every forecast leaves a trail");
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
