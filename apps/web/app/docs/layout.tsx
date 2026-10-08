import type { ReactNode } from "react";
import { AudienceBar } from "../../components/docs/AudienceBar";
import { DocsCopyListener } from "../../components/docs/DocsCopyListener";
import { Sidebar } from "../../components/docs/Sidebar";
import { loadDocs, navGroups } from "../../lib/docs/registry.ts";
import "./docs.css";

export default function DocsLayout({ children }: { children: ReactNode }) {
  const groups = navGroups(loadDocs()).map((g) => ({
    group: g.group,
    pages: g.pages.map((p) => ({ href: p.href, title: p.meta.title })),
  }));
  return (
    <div className="docs-root">
      <AudienceBar />
      <div className="docs-shell">
        <Sidebar groups={groups} />
        {children}
      </div>
      <DocsCopyListener />
    </div>
  );
}
