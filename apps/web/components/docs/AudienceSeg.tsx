"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function AudienceSeg() {
  // The static export uses trailingSlash, where usePathname() returns "/docs/agents/"; compare without it.
  const pathname = usePathname().replace(/(.)\/$/, "$1");
  const agents = pathname === "/docs/agents";
  return (
    <nav className="docs-seg" aria-label="Audience">
      <Link href="/docs" aria-current={agents ? undefined : "page"}>For humans</Link>
      <Link href="/docs/agents" aria-current={agents ? "page" : undefined}>For agents</Link>
    </nav>
  );
}
