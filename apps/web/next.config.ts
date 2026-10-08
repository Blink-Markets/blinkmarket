import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@blink/schemas"],
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/docs.md", destination: "/docs-md/index" },
        { source: "/docs/:slug([a-z0-9-]+)\\.md", destination: "/docs-md/:slug" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};
export default config;
