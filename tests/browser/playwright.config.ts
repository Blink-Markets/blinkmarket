import { defineConfig } from "@playwright/test";

const PORT = 3200;
// Set PW_BASE_URL (e.g. http://127.0.0.1:3300/blinkmarket/ from scripts/serve-pages.mjs) to test an already-served static export.
const PAGES_URL = process.env["PW_BASE_URL"];
const desktop = { width: 1440, height: 900 };
const mobile = { width: 375, height: 812 };

const engines = [
  { name: "chromium", browserName: "chromium" },
  { name: "firefox", browserName: "firefox" },
  { name: "webkit", browserName: "webkit" },
] as const;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  workers: 4,
  // CI retries once to absorb timing flakes; a test that passes only on retry is still reported as flaky.
  retries: process.env["CI"] ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env["CI"]
    ? [["list"], ["json", { outputFile: "test-results/results.json" }], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"], ["json", { outputFile: "test-results/results.json" }]],
  use: { baseURL: PAGES_URL ?? `http://127.0.0.1:${PORT}`, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: engines.flatMap(({ name, browserName }) => [
    { name: `${name}-desktop`, use: { browserName, viewport: desktop } },
    { name: `${name}-mobile`, use: { browserName, viewport: mobile } },
  ]),
  ...(PAGES_URL
    ? {}
    : {
        webServer: {
          command: `pnpm --filter @blink/web build && pnpm --filter @blink/web exec next start --hostname 127.0.0.1 --port ${PORT}`,
          url: `http://127.0.0.1:${PORT}`,
          reuseExistingServer: false,
          timeout: 600_000,
          cwd: "../..",
        },
      }),
});
