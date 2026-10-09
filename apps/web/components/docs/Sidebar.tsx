"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

type Group = { group: string; pages: { href: string; title: string }[] };

export function Sidebar({ groups }: { groups: Group[] }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDetailsElement>(null);
  const current = groups.flatMap((g) => g.pages).find((p) => p.href === pathname);

  // Closed by default (no open-then-close jump on mobile). At >=768px the nav is always shown:
  // CSS does it via ::details-content; this keeps it open for browsers without that selector.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => {
      if (ref.current) ref.current.open = mq.matches;
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [pathname]);

  return (
    <aside className="docs-sidebar">
      <nav aria-label="Docs navigation">
      <details ref={ref} className="docs-nav">
        <summary>Menu · {current?.title ?? "Docs"}</summary>
        <div className="docs-navgroups">
          {groups.map((g) => (
            <div className="docs-navgroup" key={g.group}>
              <p className="docs-navgroup-label">{g.group}</p>
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
      </nav>
    </aside>
  );
}
