import { expect, test } from "@playwright/test";

for (const route of ["/", "/docs/quickstart"]) {
  test(`footer on ${route}: landscape, links, fixed cobalt even in docs dark theme`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("blink-theme", "dark"));
    await page.goto(route, { waitUntil: "load" });
    const footer = page.locator("footer").last();
    await footer.scrollIntoViewIfNeeded();
    const land = footer.locator('svg[role="img"]');
    await expect(land).toBeVisible();
    await expect(land.locator("path[data-draw]")).toHaveCount(1);
    await expect(footer.locator('a[href="/docs/agents"]')).toHaveCount(1);
    await expect(footer.locator('a[href="/llms.txt"]')).toHaveCount(1);
    await expect(footer).toHaveCSS("background-color", "rgb(33, 72, 184)");
  });
}
