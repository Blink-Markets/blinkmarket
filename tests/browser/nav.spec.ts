import { expect, test } from "@playwright/test";

test("docs sidebar details is collapsible on mobile", async ({ page }, info) => {
  test.skip(!info.project.name.endsWith("-mobile"), "375px projects only");
  await page.goto("./docs/concepts");
  const details = page.locator("details.docs-nav");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  await expect(details).toHaveJSProperty("open", true);
});

test("nav links visible at desktop and mobile widths", async ({ page }) => {
  await page.goto("./");
  const nav = page.getByRole("navigation", { name: "Primary" });
  for (const name of ["Markets", "How it works", "Advantages", "Docs"]) {
    await expect(nav.getByRole("link", { name })).toBeVisible();
  }
});
