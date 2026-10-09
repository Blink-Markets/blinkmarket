import { expect, test } from "@playwright/test";
import { scrollThrough } from "./helpers.ts";

for (const route of ["/", "/how-it-works"]) {
  test(`scroll reveal completes on ${route}`, async ({ page }, info) => {
    await page.goto(route);
    const supportsViewTimeline = await page.evaluate(() => CSS.supports("animation-timeline: view()"));
    await scrollThrough(page);
    await page.waitForTimeout(1500);
    const state = await page.evaluate(() => ({
      fallback: document.documentElement.classList.contains("reveal-fallback"),
      total: document.querySelectorAll("[data-reveal]").length,
      hidden: Array.from(document.querySelectorAll("[data-reveal]"))
        .filter((el) => Number(getComputedStyle(el).opacity) < 0.99)
        .map((el) => `${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""}`),
    }));
    info.annotations.push({
      type: "reveal-fallback",
      description: `${route}: fallback=${state.fallback} view-timeline-supported=${supportsViewTimeline} data-reveal=${state.total}`,
    });
    console.log(`[reveal] ${info.project.name} ${route}: reveal-fallback=${state.fallback} animation-timeline:view()=${supportsViewTimeline} elements=${state.total}`);
    expect(state.total).toBeGreaterThan(0);
    expect(state.hidden).toEqual([]);
  });
}
