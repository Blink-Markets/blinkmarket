import { defineConfig } from "@playwright/test";

const PORT = 3200;
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
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: engines.flatMap(({ name, browserName }) => [
    { name: `${name}-desktop`, use: { browserName, viewport: desktop } },
    { name: `${name}-mobile`, use: { browserName, viewport: mobile } },
  ]),
  webServer: {
    command: `pnpm --filter @blink/web build && pnpm --filter @blink/web exec next start --hostname 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 600_000,
    cwd: "../..",
  },
});
