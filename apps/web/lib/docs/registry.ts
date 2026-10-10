// Reads apps/web/content/docs at build time.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateOpenApi } from "@blink/schemas";
import { BASE_PATH } from "../base-path.ts";
import { apiIndexMarkdown } from "./api-markdown.ts";
import { parseFrontmatter, type DocMeta } from "./frontmatter.ts";
import { API_INDEX_MARKER, DOC_GROUPS, type DocGroup } from "./ia.ts";

export type DocPage = { slug: string; href: string; mdHref: string; file: string; meta: DocMeta; source: string; body: string };

export function loadDocs(dir = join(process.cwd(), "content/docs")): DocPage[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const source = readFileSync(join(dir, file), "utf8");
      const { meta, body } = parseFrontmatter(source);
      const slug = file === "index.md" ? "" : file.slice(0, -3);
      return { slug, href: slug ? `/docs/${slug}` : "/docs", mdHref: slug ? `/docs/${slug}.md` : "/docs.md", file, meta, source, body };
    })
    .sort((a, b) => DOC_GROUPS.indexOf(a.meta.group) - DOC_GROUPS.indexOf(b.meta.group) || a.meta.order - b.meta.order);
}

export function navGroups(pages: readonly DocPage[]): { group: DocGroup; pages: DocPage[] }[] {
  return DOC_GROUPS.map((group) => ({ group, pages: pages.filter((p) => p.meta.group === group) })).filter((g) => g.pages.length > 0);
}

export function neighbors(pages: readonly DocPage[], slug: string): { prev: DocPage | null; next: DocPage | null } {
  const human = pages.filter((p) => p.meta.group !== "For agents");
  const i = human.findIndex((p) => p.slug === slug);
  if (i < 0) return { prev: null, next: null };
  return { prev: human[i - 1] ?? null, next: human[i + 1] ?? null };
}

export function expandSource(page: DocPage): string {
  return page.source.includes(API_INDEX_MARKER)
    ? page.source.replace(API_INDEX_MARKER, apiIndexMarkdown(generateOpenApi()))
    : page.source;
}

// Raw Markdown as served (/docs/<slug>.md, Copy page): root-relative link/image targets get the base path so they resolve on GitHub Pages.
export function publicMarkdown(page: DocPage, base = BASE_PATH): string {
  const source = expandSource(page);
  return base ? source.replace(/\]\((\/(?!\/))/g, `](${base}$1`) : source;
}
