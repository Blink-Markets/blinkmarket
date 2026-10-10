// Checks the GitHub Pages export in apps/web/out (run after `pnpm build:pages`):
// 1. key files exist; 2. every root-relative href/src in the exported HTML, every url(/...) in exported CSS and every
// link in llms.txt carries the /blinkmarket base path and resolves to a file without a redirect, using GitHub Pages
// rules ("/x/" -> x/index.html, "/x" -> x or x.html); 3. og:image/twitter:image are absolute URLs under the site URL.
// With PAGES_URL (e.g. http://127.0.0.1:3300, see scripts/serve-pages.mjs) every URL is also fetched and must return 200.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const OUT = join(import.meta.dirname, "../apps/web/out");
const BASE = "/blinkmarket";
const SITE = "https://blink-markets.github.io/blinkmarket/";
const KEY_FILES = [
  ".nojekyll",
  "index.html",
  "404.html",
  "docs/index.html",
  "docs/quickstart/index.html",
  "docs/agents/index.html",
  "markets/index.html",
  "markets/sample-01/index.html",
  "how-it-works/index.html",
  "docs.md",
  "docs/quickstart.md",
  "docs/agents.md",
  "llms.txt",
  "footer-landscape.svg",
  "footer-stars.svg",
  "docs-assets/lifecycle.svg",
  "docs-assets/architecture-sketch.jpg",
  "icon.svg",
  "apple-touch-icon.png",
  "share-card.png",
];

const errors = [];
const isFile = (p) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));

for (const f of KEY_FILES) if (!isFile(join(OUT, f))) errors.push(`missing ${f}`);

const files = existsSync(OUT) ? walk(OUT) : [];
const refs = new Map(); // url -> first file that references it
const add = (url, from) => {
  if (!refs.has(url)) refs.set(url, relative(OUT, from));
};
const decode = (s) => s.replace(/&amp;/g, "&");

for (const file of files) {
  const text = file.endsWith(".html") || file.endsWith(".css") || file.endsWith("llms.txt") ? readFileSync(file, "utf8") : null;
  if (text === null) continue;
  if (file.endsWith(".html")) {
    for (const m of text.matchAll(/\s(?:href|src)="(\/(?!\/)[^"]*)"/g)) add(decode(m[1]), file);
    for (const m of text.matchAll(/<meta (?:property="og:image"|name="twitter:image") content="([^"]*)"/g)) {
      if (!m[1].startsWith(SITE)) errors.push(`${relative(OUT, file)}: share image ${m[1]} is not under ${SITE}`);
      else add(BASE + "/" + m[1].slice(SITE.length), file);
    }
  }
  for (const m of text.matchAll(/url\((["']?)(\/(?!\/)[^"')]*)\1\)/g)) add(decode(m[2]), file);
  if (file.endsWith("llms.txt")) for (const m of text.matchAll(/\]\((\/[^)]*)\)/g)) add(m[1], file);
}

for (const [url, from] of refs) {
  const path = decodeURIComponent(url.replace(/[?#].*$/, ""));
  if (!path.startsWith(`${BASE}/`)) {
    errors.push(`${from}: ${url} lacks the ${BASE} base path`);
    continue;
  }
  const rel = path.slice(BASE.length);
  const ok = rel.endsWith("/") ? isFile(join(OUT, rel, "index.html")) : isFile(join(OUT, rel)) || isFile(join(OUT, `${rel}.html`));
  if (!ok) errors.push(`${from}: ${url} does not resolve${isFile(join(OUT, rel, "index.html")) ? " without a redirect (add a trailing slash)" : ""}`);
}

if (process.env.PAGES_URL) {
  const origin = process.env.PAGES_URL.replace(/\/$/, "");
  await Promise.all(
    [...refs.keys()].map(async (url) => {
      const res = await fetch(origin + url, { redirect: "manual" });
      if (res.status !== 200) errors.push(`GET ${url} -> ${res.status}`);
    }),
  );
}

console.log(`Checked ${KEY_FILES.length} key files and ${refs.size} internal URLs from ${files.length} exported files${process.env.PAGES_URL ? " (also fetched over HTTP)" : ""}.`);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
