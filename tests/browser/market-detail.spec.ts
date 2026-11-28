import { expect, test } from "@playwright/test";
import { findMarket, sampleMarkets } from "../../apps/web/content/sample-markets.ts";

const first = sampleMarkets[0];

test("markets row link opens the sample-01 detail page with its chart", async ({ page }) => {
  expect(first).toBeDefined();
  await page.goto("./markets");
  await page.getByRole("link", { name: /Ostrander Kiln Works/ }).click();
  await expect(page).toHaveURL(/\/markets\/sample-01\/?$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Ostrander Kiln Works");
  await expect(page.getByRole("heading", { name: "How agents reasoned" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Line chart of the probability of YES/ })).toBeVisible();
});

test("chart hover shows a tooltip", async ({ page }, info) => {
  test.skip(!info.project.name.endsWith("-desktop"), "hover needs a pointer: desktop projects only");
  await page.goto("./markets/sample-01");
  const hit = page.getByTestId("chart-hit");
  await hit.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("chart-tip")).toHaveCount(0);
  const box = await hit.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const tip = page.getByTestId("chart-tip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Consensus");
  await expect(tip).toContainText("Last fill");
});

test("Show table reveals one row per window", async ({ page }) => {
  await page.goto("./markets/sample-01");
  const table = page.getByRole("table");
  await expect(table).toBeHidden();
  await page.getByRole("button", { name: "Show table" }).click();
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(first?.windows.length ?? 0);
  await expect(table).toContainText("No fill");
  const fillPath = page.getByRole("img", { name: /last fill/i }).locator("path[stroke-dasharray]");
  expect((await fillPath.getAttribute("d"))?.match(/M/g)).toHaveLength(2);
  await expect(page.getByRole("button", { name: "Hide table" })).toHaveAttribute("aria-expanded", "true");
});

test("unknown market ids return 404", async ({ page }) => {
  const res = await page.goto("./markets/sample-99");
  expect(res?.status()).toBe(404);
});

test("the facts row fits at 900 px", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto("./markets/sample-01");
  const tight = await page.locator('[class*="fact"]').evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className));
  expect(tight).toEqual([]);
});

function market(id: string) {
  const m = findMarket(id);
  expect(m).toBeDefined();
  return m!;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

test("the consensus card of an open sample market shows the freshness line with the level and the latest window", async ({ page }) => {
  for (const id of ["sample-01", "sample-02"]) {
    const m = market(id);
    const latest = m.windows.at(-1)!;
    await page.goto(`./markets/${id}`);
    const line = page.getByTestId("freshness-line");
    await expect(line).toHaveCount(1);
    await expect(line).toBeVisible();
    await expect(page.getByTestId("freshness-level")).toHaveText("Current");
    await expect(line).toContainText(`Latest window ${latest.date}`);
    await expect(line).toContainText("0 windows behind");
    await expect(line).toContainText(`${latest.analysed} of ${latest.forecasters} answers reported a new analysis`);
    await expect(line).toContainText(`${plural(latest.changes.length, "source", "sources")} changed (reported)`);
    await expect(line).toContainText("Sample data");
    // The line sits in the consensus card, under the number.
    await expect(page.locator('[class*="fact"]:not([class*="facts"])').filter({ hasText: "Agent consensus" }).getByTestId("freshness-line")).toHaveCount(1);
  }
});

test('a FINAL sample market (sample-05) and sample-06 show "Forecasting ended at close" and no level word', async ({ page }) => {
  for (const id of ["sample-05", "sample-06"]) {
    const m = market(id);
    await page.goto(`./markets/${id}`);
    const line = page.getByTestId("freshness-line");
    await expect(line).toHaveCount(1);
    await expect(line).toContainText(`Forecasting ended at close; last window ${m.windows.at(-1)!.date}`);
    await expect(line).not.toContainText(/Current|Aging|Stale/);
    await expect(page.getByTestId("freshness-level")).toHaveCount(0);
  }
});

test("the What changed section lists the sample changes newest first and carries the reported-by-forecasters line", async ({ page }) => {
  const m = market("sample-01");
  const expected = m.windows
    .flatMap((w) => w.changes)
    .map((c) => c.observedAt)
    .sort()
    .reverse();
  expect(expected.length).toBeGreaterThanOrEqual(2);
  await page.goto("./markets/sample-01");
  await expect(page.getByRole("heading", { level: 2, name: "What changed" })).toBeVisible();
  const section = page.locator('section[aria-labelledby="changes-h"]');
  await expect(section).toContainText("Reported by the forecasters; an archived snapshot can be checked against its hash.");
  await expect(section).toContainText("Sample data");
  const items = section.getByTestId("change");
  await expect(items).toHaveCount(expected.length);
  expect(await items.evaluateAll((els) => els.map((el) => el.getAttribute("data-observed")))).toEqual(expected);
  await expect(items.first()).toContainText("example.com");
  await expect(items.first()).toContainText(/changed between \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC and \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  await expect(items.first()).toContainText(/\d+\.\d% to \d+\.\d%/);
  // The static site cannot check a snapshot, so nothing in the section links to one.
  await expect(section.locator("a")).toHaveCount(0);
  // The section sits between the chart and "How it resolves".
  const order = await page.locator("h2").allTextContents();
  expect(order.indexOf("What changed")).toBeGreaterThan(order.indexOf("Forecast history"));
  expect(order.indexOf("What changed")).toBeLessThan(order.indexOf("How it resolves"));
});

test("a snapshot that is not available is named, and a market without changes says so", async ({ page }) => {
  const withMissing = sampleMarkets.find((m) => m.windows.some((w) => w.changes.some((c) => c.snapshot === null)));
  expect(withMissing).toBeDefined();
  await page.goto(`./markets/${withMissing!.id}`);
  await expect(page.locator('section[aria-labelledby="changes-h"]')).toContainText("Snapshot not available");
  const quiet = sampleMarkets.find((m) => m.windows.every((w) => w.changes.length === 0));
  expect(quiet).toBeDefined();
  await page.goto(`./markets/${quiet!.id}`);
  const section = page.locator('section[aria-labelledby="changes-h"]');
  await expect(section.getByTestId("change")).toHaveCount(0);
  await expect(section).toContainText("No source change was reported");
});

test("the chart table has the New analysis / carried and Sources changed columns and one row per window", async ({ page }) => {
  const m = market("sample-01");
  await page.goto("./markets/sample-01");
  await page.getByRole("button", { name: "Show table" }).click();
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "New analysis / carried" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Sources changed" })).toBeVisible();
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(m.windows.length);
  for (const [i, w] of m.windows.entries()) {
    const cells = rows.nth(i).locator("td");
    await expect(cells.nth(0)).toHaveText(w.date);
    await expect(cells.nth(4)).toHaveText(`${w.analysed} / ${w.carried}`);
    await expect(cells.nth(5)).toHaveText(String(w.changes.length));
  }
});

test("the chart aria label counts the windows with changed sources", async ({ page }) => {
  const m = market("sample-01");
  const n = m.windows.filter((w) => w.changes.length > 0).length;
  await page.goto("./markets/sample-01");
  const chart = page.getByRole("img", { name: /Line chart of the probability of YES/ });
  await expect(chart).toHaveAttribute("aria-label", new RegExp(`Sources changed \\(reported\\) in ${n} of ${m.windows.length} windows\\.`));
});

test("a chart marker exists for each window with changes, and the tooltip names the changed sources", async ({ page }, info) => {
  const m = market("sample-01");
  const changed = m.windows.flatMap((w, i) => (w.changes.length > 0 ? [{ w, i }] : []));
  expect(changed.length).toBeGreaterThanOrEqual(2);
  await page.goto("./markets/sample-01");
  const chart = page.getByRole("img", { name: /Line chart of the probability of YES/ });
  const markers = chart.getByTestId("chart-change-marker");
  await expect(markers).toHaveCount(changed.length);
  expect(await markers.evaluateAll((els) => els.map((el) => el.getAttribute("data-window")))).toEqual(changed.map(({ w }) => w.date));
  // A window whose answers were all carried forward has its own point style.
  const carriedDates = m.windows.filter((w) => w.analysed === 0).map((w) => w.date);
  expect(carriedDates.length).toBeGreaterThanOrEqual(1);
  const hollow = chart.locator('[data-testid="chart-point"][data-carried="true"]');
  await expect(hollow).toHaveCount(carriedDates.length);
  expect(await hollow.evaluateAll((els) => els.map((el) => el.getAttribute("data-window")))).toEqual(carriedDates);
  await expect(chart.getByTestId("chart-point")).toHaveCount(m.windows.length);

  test.skip(!info.project.name.endsWith("-desktop"), "hover needs a pointer: desktop projects only");
  // The table button reads "Show table" only after the client effect has run, so the pointer handlers are attached.
  await expect(page.getByRole("button", { name: "Show table" })).toBeVisible();
  const last = m.windows.length - 1;
  // Moves the pointer over window i. The box is read after scrolling and again for every move, so a
  // scroll or a layout shift cannot leave it stale.
  async function hoverWindow(i: number) {
    await chart.scrollIntoViewIfNeeded();
    const svg = await chart.boundingBox();
    expect(svg).not.toBeNull();
    const scale = svg!.width / 1000;
    // Plot geometry of ForecastChart: left 52, right margin 150, width 1000 in viewBox units.
    await page.mouse.move(svg!.x + (52 + (i * (1000 - 52 - 150)) / last) * scale, svg!.y + 150 * scale);
  }
  for (const { w, i } of changed) {
    await hoverWindow(i);
    const tip = page.getByTestId("chart-tip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(w.date);
    await expect(tip).toContainText(`Sources changed: ${w.changes.length} (reported)`);
    await expect(tip).toContainText(`New analysis ${w.analysed}, carried ${w.carried}`);
  }
  // A window without a change says so.
  const quiet = m.windows.findIndex((w) => w.changes.length === 0);
  await hoverWindow(quiet);
  await expect(page.getByTestId("chart-tip")).toContainText(m.windows[quiet]!.date);
  await expect(page.getByTestId("chart-tip")).toContainText("Sources changed: 0 (reported)");
});

test("the market page does not overflow at 375 px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const id of ["sample-01", "sample-05"]) {
    await page.goto(`./markets/${id}`);
    const overflow = await page.evaluate(() => {
      const limit = window.innerWidth + 1;
      const out: string[] = [];
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        if (el.closest('svg, pre, [class*="tableWrap"]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > limit) out.push(`${el.tagName.toLowerCase()}.${String(el.getAttribute("class") ?? "")} right=${r.right.toFixed(1)}`);
      }
      return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, out: out.slice(0, 10) };
    });
    expect(overflow.out, `${id}: elements beyond the viewport`).toEqual([]);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  }
});
