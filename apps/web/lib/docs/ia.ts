export const DOC_GROUPS = ["Get started", "How markets work", "Roles", "Reference", "For agents"] as const;
export type DocGroup = (typeof DOC_GROUPS)[number];
export const DOC_SLUGS = [
  "", "concepts", "faq", "onboarding", "trust",
  "lifecycle", "architecture",
  "roles", "creator", "maker", "trader", "forecaster", "proposer", "challenger", "juror", "keeper",
  "api", "errors", "client", "contracts", "deployment",
  "agents",
] as const;
export type DocSlug = (typeof DOC_SLUGS)[number];
export const API_INDEX_MARKER = "<!-- generated:api-index -->";
