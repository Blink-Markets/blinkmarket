import { expect, test } from "@playwright/test";

test("docs sidebar details is collapsible on mobile", async ({ page }, info) => {
  test.skip(!info.project.name.endsWith("-mobile"), "375px projects only");
  await page.goto("/docs/quickstart");
  const details = page.locator("details.docs-nav");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  await expect(details).toHaveJSProperty("open", true);
});

test("nav links visible on desktop", async ({ page }, info) => {
  test.skip(!info.project.name.endsWith("-desktop"), "desktop projects only");
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  for (const name of ["Markets", "How it works", "Docs"]) {
    await expect(nav.getByRole("link", { name })).toBeVisible();
  }
});
