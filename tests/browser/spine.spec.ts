import { expect, test } from "@playwright/test";

test("how-it-works spine fully draws after scrolling chapters through", async ({ page }) => {
  await page.goto("./how-it-works");
  const spine = page.locator('svg[class*="spine"]');
  test.skip(!(await spine.evaluate((el) => getComputedStyle(el).display !== "none")), "spine is display:none at this viewport (max-width: 760px)");
  const viewTimeline = await page.evaluate(() => CSS.supports("animation-timeline: view()"));
  console.log(`[spine] view-timeline-supported=${viewTimeline}`);
  await page.evaluate(async () => {
    const svg = document.querySelector('svg[class*="spine"]');
    const section = svg?.parentElement;
    if (!section) throw new Error("no chapters section");
    const top = section.getBoundingClientRect().top + window.scrollY;
    const end = top + section.offsetHeight;
    const step = Math.round(window.innerHeight / 5);
    for (let y = top - window.innerHeight; y <= end + window.innerHeight; y += step) {
      window.scrollTo(0, Math.max(0, y));
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  await expect
    .poll(() => spine.locator("path").evaluate((p) => parseFloat(getComputedStyle(p).strokeDashoffset)), { timeout: 5_000 })
    .toBeLessThanOrEqual(0.02);
});
