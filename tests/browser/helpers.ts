import type { Page } from "@playwright/test";

/** Scroll to the bottom in small steps so scroll-driven and IntersectionObserver reveals both fire. */
export async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.max(100, Math.round(window.innerHeight / 4));
    let y = 0;
    for (;;) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 80));
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (y >= max) break;
      y = Math.min(y + step, max);
    }
  });
}

export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}
