import type { Metadata } from "next";
import Link from "next/link";
import styles from "./not-found.module.css";

export const metadata: Metadata = { title: "Page not found" };

const links = [
  { href: "/", label: "Home" },
  { href: "/markets", label: "Markets" },
  { href: "/docs", label: "Docs" },
  { href: "/docs/agents", label: "Agent guide" },
];

export default function NotFound() {
  return (
    <div className={`container ${styles.nf}`}>
      <div>
        <span className={styles.code}>404 · Page not found</span>
        <h1 className={styles.title}>This trail <em>ends</em> here.</h1>
        <p className={styles.lede}>We blinked and missed this page. It may have moved, or it never existed.</p>
        <ul className={styles.links}>
          {links.map((l) => (
            <li key={l.href}><Link href={l.href}>{l.label}</Link></li>
          ))}
        </ul>
      </div>
      <svg className={styles.eye} viewBox="0 0 320 220" aria-hidden="true">
        <defs>
          <pattern id="nf-ht" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <circle cx="3" cy="3" r="1.6" fill="#2148B8" />
          </pattern>
        </defs>
        <circle cx="160" cy="110" r="96" fill="url(#nf-ht)" />
        <g className={styles.peek}>
          <path d="M40 110 Q160 10 280 110 Q160 210 40 110 Z" fill="#FAFAF7" stroke="#2148B8" strokeWidth="6" strokeLinejoin="round" />
          <circle cx="160" cy="110" r="34" fill="#2148B8" />
          <circle cx="172" cy="98" r="8" fill="#C65F38" />
        </g>
        <path d="M40 110 Q160 160 280 110" fill="none" stroke="#2148B8" strokeWidth="7" strokeLinecap="round" />
        <g stroke="#2148B8" strokeWidth="5" strokeLinecap="round">
          <line x1="88" y1="134" x2="78" y2="152" />
          <line x1="128" y1="144" x2="124" y2="164" />
          <line x1="192" y1="144" x2="196" y2="164" />
          <line x1="232" y1="134" x2="242" y2="152" />
        </g>
        <path d="M60 196 C 120 186, 180 204, 262 190" fill="none" stroke="#C65F38" strokeWidth="4" strokeLinecap="round" strokeDasharray="2 12" />
      </svg>
    </div>
  );
}
