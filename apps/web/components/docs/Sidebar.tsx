"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

type Group = { group: string; pages: { href: string; title: string }[] };

export function Sidebar({ groups }: { groups: Group[] }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDetailsElement>(null);
  const current = groups.flatMap((g) => g.pages).find((p) => p.href === pathname);

  useEffect(() => {
    if (window.matchMedia("(max-width: 767px)").matches && ref.current) ref.current.open = false;
  }, [pathname]);

  return (
    <aside className="docs-sidebar" aria-label="Docs navigation">
      <details ref={ref} className="docs-nav" open>
        <summary>Menu · {current?.title ?? "Docs"}</summary>
        <div className="docs-navgroups">
          {groups.map((g) => (
            <div className="docs-navgroup" key={g.group}>
              <h2>{g.group}</h2>
              <ul>
                {g.pages.map((p) => (
                  <li key={p.href}>
                    <Link href={p.href} aria-current={pathname === p.href ? "page" : undefined}>{p.title}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </details>
    </aside>
  );
}
