import Link from "next/link";
import styles from "./SiteHeader.module.css";

const links = [
  { href: "/markets", label: "Markets" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/docs", label: "Docs" },
];

export function SiteHeader() {
  return (
    <header className={`container ${styles.header}`}>
      <Link href="/" className={styles.wordmark} aria-label="Blink home">
        <svg className={styles.eye} viewBox="0 0 34 22" aria-hidden="true">
          <g className={styles.lid}>
            <path d="M2 11 Q17 -3 32 11 Q17 25 2 11 Z" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
            <circle cx="17" cy="11" r="5.2" fill="currentColor" />
            <circle cx="19" cy="9" r="1.4" style={{ fill: "var(--terracotta)" }} />
          </g>
        </svg>
        <span>Blink</span>
      </Link>
      <nav aria-label="Primary" className={styles.nav}>
        {links.map((l) => (
          <Link key={l.href} href={l.href}>{l.label}</Link>
        ))}
        <a href="https://github.com/Blink-Markets/blinkmarket">GitHub</a>
      </nav>
    </header>
  );
}
