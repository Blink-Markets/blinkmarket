import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

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
await build({
  ...common,
  entryPoints: {
    api: "apps/api/src/main.ts",
    worker: "apps/worker/src/main.ts",
    indexer: "apps/indexer/src/main.ts",
    signer: "apps/signer/src/main.ts",
    "api-server": "apps/api/src/server.ts",
  },
  outdir: "dist/services",
  outExtension: { ".js": ".mjs" },
});
await build({
  ...common,
  entryPoints: {
    migrate: "scripts/migrate.ts",
    "identity-admin": "scripts/identity-admin.ts",
    "evidence-admin": "scripts/evidence-admin.ts",
  },
  outdir: "dist/tools",
  outExtension: { ".js": ".mjs" },
});
await mkdir("dist/migrations", { recursive: true });
await cp("packages/adapters/migrations", "dist/migrations", {
  recursive: true,
});
