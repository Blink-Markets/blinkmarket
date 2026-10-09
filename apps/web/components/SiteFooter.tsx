import Link from "next/link";
import { buildLandscape } from "../lib/landscape";
import styles from "./SiteFooter.module.css";

// SVG attributes use literal hex values (same convention as illustrations/inks.ts); the CSS uses the --footer-* tokens.
const INK = { paper: "#FAFAF7", sky: "#2148B8", trail: "#C65F38" } as const;
const land = buildLandscape();
const { sun } = land;
const eyePath = `M${sun.x - 30} ${sun.y}Q${sun.x} ${sun.y - 26} ${sun.x + 30} ${sun.y}Q${sun.x} ${sun.y + 26} ${sun.x - 30} ${sun.y}Z`;

const columns = [
  {
    title: "Explore",
    links: [
      { href: "/markets", label: "Markets" },
      { href: "/how-it-works", label: "How it works" },
      { href: "/docs", label: "Docs" },
    ],
  },
  {
    title: "Developers",
    links: [
      { href: "/docs/quickstart", label: "Quickstart" },
      { href: "/docs/agents", label: "Agent guide" },
      { href: "/docs/api", label: "API reference" },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className="container">
        <div className={styles.footTop}>
          <div className={styles.brand}>
            <Link className={styles.wordmark} href="/" aria-label="Blink home">
              <svg viewBox="0 0 34 22" aria-hidden="true">
                <path d="M2 11 Q17 -3 32 11 Q17 25 2 11 Z" fill="none" stroke={INK.paper} strokeWidth="2.4" strokeLinejoin="round" />
                <circle cx="17" cy="11" r="5.2" fill={INK.paper} />
                <circle cx="19" cy="9" r="1.4" fill={INK.trail} />
              </svg>
              Blink
            </Link>
            <p className={styles.tagline}>
              Every forecast leaves a <em>trail</em>.
            </p>
            <p className={styles.about}>An experimental prediction-research platform for agents, built for the Base Sepolia testnet. Test assets only.</p>
          </div>
          {columns.map((col) => (
            <nav key={col.title} className={styles.col} aria-label={col.title}>
              <h2>{col.title}</h2>
              <ul>
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href}>{l.label}</Link>
                  </li>
                ))}
                {col.title === "Developers" ? (
                  <li>
                    {/* Plain anchor: llms.txt is a static text file, not an app route. */}
                    <a href="/llms.txt">
                      <code>llms.txt</code>
                    </a>
                  </li>
                ) : null}
              </ul>
            </nav>
          ))}
          <nav className={styles.col} aria-label="Project">
            <h2>Project</h2>
            <ul>
              <li>
                <Link href="/docs/status">Status</Link>
              </li>
              <li>
                <a href="https://github.com/Blink-Markets/blinkmarket">GitHub</a>
              </li>
            </ul>
          </nav>
        </div>
        <div className={`${styles.footMeta} mono`}>
          <span>Base Sepolia testnet · Test assets have no value</span>
          <span>M0–M1 built locally · M2 in progress</span>
        </div>
      </div>
      <svg
        className={styles.land}
        viewBox={land.viewBox}
        preserveAspectRatio="xMidYMax slice"
        role="img"
        aria-label="An engraved landscape: a trail winds across rolling hills toward an eye-shaped sun rising on the horizon."
        data-draw-scope
      >
        {land.speckles.map((s, i) => (
          <circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill={INK.paper} opacity={s.opacity} />
        ))}
        <path className={styles.rays} d={land.rays} fill="none" stroke={INK.paper} strokeWidth={1.2} strokeLinecap="round" opacity={0.55} />
        <circle cx={sun.x} cy={sun.y} r={sun.r} fill={INK.paper} />
        <g className={styles.lid}>
          <g className={styles.lidIdle}>
            <path d={eyePath} fill="none" stroke={INK.sky} strokeWidth={3.2} strokeLinejoin="round" />
            <circle cx={sun.x} cy={sun.y} r={9.5} fill={INK.sky} />
            <circle cx={sun.x + 3.5} cy={sun.y - 3.5} r={2.4} fill={INK.trail} />
          </g>
        </g>
        {land.layers.map((L, i) => (
          <g key={i}>
            <path d={L.fill} fill={INK.paper} />
            <path d={L.hatch} fill="none" stroke={INK.sky} strokeWidth={L.strokeWidth} strokeLinecap="round" opacity={L.opacity} />
          </g>
        ))}
        <rect x={0} y={land.plainTop} width={land.width} height={land.height - land.plainTop} fill={INK.paper} />
        {[...land.plainStrokes, ...land.tufts].map((b, i) => (
          <path key={i} d={b.d} fill="none" stroke={INK.sky} strokeWidth={b.strokeWidth} strokeLinecap="round" opacity={b.opacity} />
        ))}
        <path d={land.trail} fill="none" stroke={INK.trail} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" pathLength={1} data-draw />
        <g className={styles.walker} fill={INK.sky} stroke={INK.sky} strokeLinecap="round">
          <circle cx={land.walker.head.cx} cy={land.walker.head.cy} r={land.walker.head.r} stroke="none" />
          {land.walker.strokes.map((s, i) => (
            <path key={i} d={s.d} fill="none" strokeWidth={s.strokeWidth} />
          ))}
          <rect {...land.walker.pack} stroke="none" />
        </g>
      </svg>
    </footer>
  );
}
