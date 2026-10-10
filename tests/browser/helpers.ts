import type { Page } from "@playwright/test";

/**
 * PW_BASE_URL runs the suite against the GitHub Pages export (e.g. http://127.0.0.1:3300/blinkmarket/, served by
 * scripts/serve-pages.mjs). Tests navigate with "./path" so it resolves under that base path; attribute checks use href().
 */
export const BASE_PATH = new URL(process.env["PW_BASE_URL"] ?? "http://127.0.0.1/").pathname.replace(/\/$/, "");

/** The URL the app renders for a root-relative path: base path prefix, plus the export's trailing slash on page paths. */
export function href(path: string): string {
  const slash = BASE_PATH && !/\.[^/]+$/.test(path) ? "/" : "";
  return `${BASE_PATH}${path}${slash}`;
}

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
