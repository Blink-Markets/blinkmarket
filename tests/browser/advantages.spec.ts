import { expect, test } from "@playwright/test";
import { FOR_PEOPLE } from "../../apps/web/content/positioning.ts";

test("advantages page labels every status in text", async ({ page }) => {
  await page.goto("./advantages");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Implemented", { exact: true })).toHaveCount(8);
  await expect(page.getByText("Under construction", { exact: true })).toHaveCount(4);
  await expect(page.getByText(FOR_PEOPLE)).toBeVisible();
  await expect(page.getByRole("region", { name: "Comparison with other markets" })).toBeVisible();
  await expect(page.getByText(/Nothing is deployed yet/)).toBeVisible();
});
test("the header links the advantages page", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Advantages" }).click();
  await expect(page).toHaveURL(/\/advantages\/?$/);
});
