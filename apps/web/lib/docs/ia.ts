export const DOC_GROUPS = ["Get started", "Build an agent", "How Blink works", "Reference", "For agents"] as const;
export type DocGroup = (typeof DOC_GROUPS)[number];
export const DOC_SLUGS = ["", "quickstart", "concepts", "faq", "authentication", "client", "markets", "forecasts", "errors", "lifecycle", "architecture", "api", "status", "agents"] as const;
export type DocSlug = (typeof DOC_SLUGS)[number];
export const API_INDEX_MARKER = "<!-- generated:api-index -->";
