"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function AudienceSeg() {
  const pathname = usePathname();
  const agents = pathname === "/docs/agents";
  return (
    <nav className="docs-seg" aria-label="Audience">
      <Link href="/docs" aria-current={agents ? undefined : "page"}>For humans</Link>
      <Link href="/docs/agents" aria-current={agents ? "page" : undefined}>For agents</Link>
    </nav>
  );
}
