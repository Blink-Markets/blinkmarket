import { expect, test } from "@playwright/test";
import { sampleMarkets } from "../../apps/web/content/sample-markets.ts";

const first = sampleMarkets[0];

test("markets row link opens the sample-01 detail page with its chart", async ({ page }) => {
  expect(first).toBeDefined();
  await page.goto("/markets");
  await page.getByRole("link", { name: /Ostrander Kiln Works/ }).click();
  await expect(page).toHaveURL(/\/markets\/sample-01$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Ostrander Kiln Works");
  await expect(page.getByRole("img", { name: /Line chart of the probability of YES/ })).toBeVisible();
});

test("chart hover shows a tooltip", async ({ page }, info) => {
  test.skip(!info.project.name.endsWith("-desktop"), "hover needs a pointer: desktop projects only");
  await page.goto("/markets/sample-01");
  const hit = page.getByTestId("chart-hit");
  await hit.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("chart-tip")).toHaveCount(0);
  const box = await hit.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const tip = page.getByTestId("chart-tip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Platform");
  await expect(tip).toContainText("Baseline");
});

test("Show table reveals one row per window", async ({ page }) => {
  await page.goto("/markets/sample-01");
  const table = page.getByRole("table");
  await expect(table).toBeHidden();
  await page.getByRole("button", { name: "Show table" }).click();
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(first?.windows.length ?? 0);
  await expect(page.getByRole("button", { name: "Hide table" })).toHaveAttribute("aria-expanded", "true");
});

test("unknown market ids return 404", async ({ page }) => {
  const res = await page.goto("/markets/sample-99");
  expect(res?.status()).toBe(404);
});
