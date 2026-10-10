// marked with a Blink renderer; one Marked instance per call so ids/toc stay local.
import { Marked } from "marked";
import { highlightCode } from "./highlight.ts";
import { renderSketch, SKETCHES, type SketchName } from "./sketches.ts";

export type TocItem = { id: string; text: string; depth: 2 | 3 };
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const decodeEntities = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const slugify = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
const ALERT = /^\s*<p>\[!(NOTE|PLANNED)\]\s*/;

export function renderDoc(body: string): { html: string; toc: TocItem[] } {
  const toc: TocItem[] = [];
  const used = new Map<string, number>();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        if (depth === 1) return "";
        const inner = this.parser.parseInline(tokens);
        const text = decodeEntities(inner.replace(/<[^>]+>/g, ""));
        const baseId = slugify(text);
        const n = (used.get(baseId) ?? 0) + 1;
        used.set(baseId, n);
        const id = n === 1 ? baseId : `${baseId}-${n}`;
        if (depth === 2 || depth === 3) toc.push({ id, text, depth });
        return `<h${depth} id="${id}">${inner} <a class="docs-anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a></h${depth}>\n`;
      },
      code({ text, lang }) {
        if (lang === "prompt")
          return `<figure class="docs-prompt"><figcaption><span>Prompt for your agent</span><button type="button" class="docs-copy">Copy prompt</button></figcaption><pre tabindex="0">${escapeHtml(text)}</pre></figure>\n`;
        return `<figure class="docs-code"><figcaption><span>${escapeHtml(lang || "text")}</span><button type="button" class="docs-copy">Copy</button></figcaption><pre tabindex="0"><code>${highlightCode(text, lang) ?? escapeHtml(text)}</code></pre></figure>\n`;
      },
      image({ href, title, text }) {
        const alt = escapeHtml(text);
        const m = /^\/docs-assets\/([a-z0-9-]+)\.svg$/.exec(href);
        const name = m?.[1];
        const caption = `<figcaption>${alt}</figcaption>`;
        if (name && (SKETCHES as readonly string[]).includes(name)) {
          const svg = renderSketch(name as SketchName).replace("<svg ", `<svg aria-label="${alt}" `);
          return `<figure class="docs-sketch"><div class="docs-sketch-sheet" role="region" aria-label="${alt}" tabindex="0">${svg}</div>${caption}</figure>\n`;
        }
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        return `<figure class="docs-sketch"><div class="docs-sketch-sheet"><img src="${escapeHtml(href)}" alt="${alt}"${t} loading="lazy" decoding="async"></div>${caption}</figure>\n`;
      },
      blockquote({ tokens }) {
        const inner = this.parser.parse(tokens);
        const m = ALERT.exec(inner);
        if (!m) return `<blockquote>${inner}</blockquote>\n`;
        const kind = m[1] === "NOTE" ? "note" : "planned";
        const label = kind === "note" ? "Note" : "Planned";
        return `<aside class="docs-callout docs-callout-${kind}"><p class="docs-callout-label">${label}</p><p>${inner.replace(ALERT, "")}</aside>\n`;
      },
    },
    hooks: {
      // Wrap default table output in a focusable scroll region.
      postprocess(html) {
        return html
          .replaceAll("<table>", '<div class="docs-table" role="region" aria-label="Table" tabindex="0"><table>')
          .replaceAll("</table>", "</table></div>");
      },
    },
  });
  const html = marked.parse(body, { async: false }) as string;
  return { html, toc };
}
