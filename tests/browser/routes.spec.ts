import { expect, test } from "@playwright/test";
import { scrollThrough, watchErrors } from "./helpers.ts";

const routes = ["/", "/markets", "/markets/sample-01", "/markets/sample-06", "/how-it-works", "/docs", "/docs/quickstart", "/docs/agents", "/docs/api", "/docs/lifecycle", "/docs/architecture"];
const IGNORE = 'pre, .docs-table, [class*="tableWrap"], [class*="archScroll"], .docs-sketch-sheet, svg, [class*="iris"]';

for (const route of routes) {
  test(`route ${route}: 200, no errors, no horizontal overflow`, async ({ page }) => {
    const errors = watchErrors(page);
    const res = await page.goto(route, { waitUntil: "load" });
    expect(res?.status()).toBe(200);
    await scrollThrough(page);
    const overflowing = await page.evaluate((ignore) => {
      const limit = window.innerWidth + 1;
      const out: string[] = [];
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        if (el.closest(ignore)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > limit) out.push(`${el.tagName.toLowerCase()}.${String(el.getAttribute("class") ?? "")} right=${r.right.toFixed(1)}`);
      }
      return out.slice(0, 10);
    }, IGNORE);
    expect(overflowing, "elements beyond viewport width").toEqual([]);
    expect(errors).toEqual([]);
  });
}
