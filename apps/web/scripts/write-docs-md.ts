// Writes every doc's raw Markdown to public/ (/docs.md, /docs/<slug>.md) so both `next start` and the static export serve real files.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { publicMarkdown, loadDocs } from "../lib/docs/registry.ts";

const publicDir = join(process.cwd(), "public");
rmSync(join(publicDir, "docs"), { recursive: true, force: true }); // generated only; drops pages that no longer exist
for (const page of loadDocs()) {
  const file = join(publicDir, page.mdHref);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, publicMarkdown(page));
}
