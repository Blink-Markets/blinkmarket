import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["pg-native"],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
};
await rm("dist/services", { recursive: true, force: true });
await rm("dist/tools", { recursive: true, force: true });
await build({
  ...common,
  entryPoints: {
    api: "apps/api/src/main.ts",
    worker: "apps/worker/src/main.ts",
    indexer: "apps/indexer/src/main.ts",
    "api-server": "apps/api/src/server.ts",
  },
  outdir: "dist/services",
  outExtension: { ".js": ".mjs" },
});
await build({
  ...common,
  entryPoints: {
    migrate: "scripts/migrate.ts",
    "forecast-admin": "scripts/forecast-admin.ts",
    "register-deployment": "scripts/register-deployment.ts",
    "rebuild-chain-index": "scripts/rebuild-chain-index.ts",
    "restore-prepare": "scripts/restore-prepare.ts",
  },
  outdir: "dist/tools",
  outExtension: { ".js": ".mjs" },
});
await mkdir("dist/migrations", { recursive: true });
await cp("packages/adapters/migrations", "dist/migrations", {
  recursive: true,
});
