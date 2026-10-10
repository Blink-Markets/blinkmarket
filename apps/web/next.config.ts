import type { NextConfig } from "next";

// BLINK_PAGES=1 builds the static GitHub Pages export into out/ (see `pnpm build:pages`).
// trailingSlash emits docs/quickstart/index.html, which Pages serves at /docs/quickstart/ (and 301s /docs/quickstart to it),
// so a page directory never collides with docs/quickstart.md or a sibling docs.html.
const pages = process.env.BLINK_PAGES === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || undefined;

const config: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@blink/schemas"],
  ...(basePath ? { basePath } : {}),
  ...(pages ? { output: "export", trailingSlash: true } : {}),
};
export default config;
