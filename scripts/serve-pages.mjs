// Serves apps/web/out under /blinkmarket the way GitHub Pages does, for local checks of `pnpm build:pages`:
// "/x/" -> x/index.html, "/x" -> x, else x.html, else 301 to "/x/" when x/index.html exists, else 404.html with status 404.
// Usage: node scripts/serve-pages.mjs [port]   (default 3300)
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const ROOT = join(import.meta.dirname, "../apps/web/out");
const BASE = "/blinkmarket";
const PORT = Number(process.argv[2] ?? 3300);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const isFile = (p) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

function send(res, status, file) {
  res.writeHead(status, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === BASE) {
    res.writeHead(301, { location: `${BASE}/` });
    return res.end();
  }
  if (!pathname.startsWith(`${BASE}/`)) return send(res, 404, join(ROOT, "404.html"));
  const rel = normalize(decodeURIComponent(pathname.slice(BASE.length)));
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 404, join(ROOT, "404.html"));
  if (rel.endsWith("/")) {
    if (isFile(join(file, "index.html"))) return send(res, 200, join(file, "index.html"));
  } else {
    if (isFile(file)) return send(res, 200, file);
    if (isFile(`${file}.html`)) return send(res, 200, `${file}.html`);
    if (isFile(join(file, "index.html"))) {
      res.writeHead(301, { location: `${pathname}/` });
      return res.end();
    }
  }
  send(res, 404, join(ROOT, "404.html"));
}).listen(PORT, "127.0.0.1", () => console.log(`Serving ${ROOT} at http://127.0.0.1:${PORT}${BASE}/`));
