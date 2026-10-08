import type { TocItem } from "../../lib/docs/render.ts";

export function Toc({ items }: { items: TocItem[] }) {
  if (items.length === 0) return <div />;
  return (
    <nav className="docs-toc" aria-label="On this page">
      <h2>On this page</h2>
      <ul>
        {items.map((t) => (
          <li key={t.id}><a href={`#${t.id}`}>{t.text}</a></li>
        ))}
      </ul>
    </nav>
  );
}
