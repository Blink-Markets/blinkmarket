import { expect, test } from "@playwright/test";

test("unknown URL returns 404 with the not-found page", async ({ page }) => {
  const res = await page.goto("/this-does-not-exist");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This trail ends here.");
  await expect(page.locator("main").getByRole("link", { name: "Home", exact: true })).toBeVisible();
  await expect(page.locator("main").getByRole("link", { name: "Agent guide" })).toBeVisible();
});

test("icon and share-card routes serve images", async ({ request }) => {
  const icon = await request.get("/icon.svg");
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toContain("image/svg+xml");
  for (const path of ["/opengraph-image", "/twitter-image", "/apple-icon"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()["content-type"], path).toContain("image/png");
  }
});

test("home head links the icon and share image", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="icon"]').first()).toBeAttached();
  await expect(page.locator('meta[property="og:image"]')).toBeAttached();
  await expect(page.locator('meta[name="twitter:image"]')).toBeAttached();
});
