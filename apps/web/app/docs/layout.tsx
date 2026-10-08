import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./docs.module.css";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`container ${styles.docs}`}>
      <nav aria-label="Docs" className={`mono ${styles.subnav}`}>
        <Link href="/docs">Overview</Link>
        <Link href="/docs/api">API index</Link>
      </nav>
      {children}
    </div>
  );
}
