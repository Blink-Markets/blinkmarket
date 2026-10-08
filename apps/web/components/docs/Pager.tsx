import Link from "next/link";
import type { DocPage } from "../../lib/docs/registry.ts";

export function Pager({ prev, next }: { prev: DocPage | null; next: DocPage | null }) {
  if (!prev && !next) return null;
  return (
    <nav className="docs-pager" aria-label="Pagination">
      {prev ? <Link href={prev.href} rel="prev"><span>Previous</span>{prev.meta.title}</Link> : <div />}
      {next ? <Link href={next.href} rel="next"><span>Next</span>{next.meta.title}</Link> : <div />}
    </nav>
  );
}
