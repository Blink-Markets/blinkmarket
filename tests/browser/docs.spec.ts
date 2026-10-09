import { expect, test, type Page } from "@playwright/test";

type ClipWindow = { __copied: string[] };

async function captureClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as ClipWindow;
    w.__copied = [];
    const stub = { writeText: (t: string) => { w.__copied.push(t); return Promise.resolve(); } };
    Object.defineProperty(navigator, "clipboard", { value: stub, configurable: true });
  });
}
const copied = (page: Page) => page.evaluate(() => (window as unknown as ClipWindow).__copied);

test("docs copy actions", async ({ page }) => {
  await captureClipboard(page);
  await page.goto("/docs/quickstart");
  await page.getByRole("button", { name: "Copy page", exact: true }).click();
  await expect.poll(async () => (await copied(page)).length).toBe(1);
  expect((await copied(page))[0]).toMatch(/^---\ntitle: Quickstart/);

  await page.getByRole("button", { name: "More copy options" }).click();
  await page.getByRole("button", { name: /Copy prompt for agent/ }).click();
  await expect.poll(async () => (await copied(page)).length).toBe(2);
  const prompt = (await copied(page))[1] ?? "";
  expect(prompt).toContain("/docs/agents.md");
  expect(prompt).toContain("/docs/quickstart.md");

  await page.locator(".docs-code .docs-copy").first().click();
  await expect.poll(async () => (await copied(page)).length).toBe(3);
  expect((await copied(page))[2]).toMatch(/^git clone/);
});

test("theme toggle persists to light marketing pages", async ({ page }) => {
  await page.goto("/docs/quickstart");
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const before = await bg();
  await page.locator(".docs-theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", /^(light|dark)$/);
  await expect.poll(bg).not.toBe(before);
  await page.goto("/");
  expect(await bg()).toBe("rgb(250, 250, 247)");
});
