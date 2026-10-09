// Build-time syntax highlighting for docs code fences. Server-only: imported by render.ts.
// Synchronous Shiki core + JS regex engine so renderDoc stays synchronous. Tokens carry
// `var(--shiki-*)` colours (see app/docs/docs.css); we emit only token spans, never Shiki's <pre>.
import { createCssVariablesTheme, createHighlighterCoreSync } from "shiki/core";
import type { HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import http from "shiki/langs/http.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import typescript from "shiki/langs/typescript.mjs";

const THEME = "blink";
const ALIASES: Record<string, string> = {
  shell: "shellscript",
  bash: "shellscript",
  sh: "shellscript",
  json: "json",
  typescript: "typescript",
  ts: "typescript",
  javascript: "javascript",
  js: "javascript",
  http: "http",
};

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let cached: HighlighterCore | undefined;
function getHighlighter(): HighlighterCore {
  cached ??= createHighlighterCoreSync({
    themes: [createCssVariablesTheme({ name: THEME, variablePrefix: "--shiki-", variableDefaults: {}, fontStyle: true })],
    langs: [...http, ...javascript, ...json, ...shellscript, ...typescript],
    engine: createJavaScriptRegexEngine(),
  });
  return cached;
}

/** Returns highlighted inner HTML for `<code>`, or undefined when `lang` is not highlighted. */
export function highlightCode(code: string, lang: string | undefined): string | undefined {
  const resolved = lang ? ALIASES[lang.toLowerCase()] : undefined;
  if (!resolved) return undefined;
  const lines = getHighlighter().codeToTokensBase(code, { lang: resolved, theme: THEME });
  return lines
    .map((line) =>
      line
        .map((t) => (t.color ? `<span style="color:${t.color}">${escapeHtml(t.content)}</span>` : escapeHtml(t.content)))
        .join(""),
    )
    .join("\n");
}
