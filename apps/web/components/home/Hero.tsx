import type { CSSProperties, ReactNode } from "react";
import { Evidence } from "../illustrations/Evidence";
import { Forecast } from "../illustrations/Forecast";
import { Quote } from "../illustrations/Quote";
import { Resolution } from "../illustrations/Resolution";
import { HeroTrail } from "./HeroTrail";
import styles from "./Hero.module.css";

function Word({ i, accent, children }: { i: number; accent?: boolean; children: ReactNode }) {
  return (
    <span className={styles.mask} data-trail-start={accent ? "" : undefined}>
      <span className={accent ? `${styles.word} ${styles.accent}` : styles.word} style={{ "--i": i } as CSSProperties}>
        {children}
      </span>
    </span>
  );
}

// Node centres in % of the band (desktop x/y, mobile mx/my). The trail is measured from these, so tune freely.
const nodes = [
  { label: "Evidence", Art: Evidence, x: "15%", y: "39%", mx: "27%", my: "20%" },
  { label: "Forecast", Art: Forecast, x: "38%", y: "69%", mx: "73%", my: "36%" },
  { label: "Quote", Art: Quote, x: "64%", y: "53%", mx: "27%", my: "63%" },
  { label: "Resolution", Art: Resolution, x: "88%", y: "72%", mx: "73%", my: "82%" },
];

export function Hero() {
  return (
    <section className={styles.hero}>
      <div className={`container ${styles.inner}`}>
        <HeroTrail />
        <h1 className={styles.headline} aria-label="every forecast leaves a trail">
          <span className={styles.line} aria-hidden="true">
            <Word i={0}>every</Word> <Word i={1}>forecast</Word>
          </span>
          <span className={styles.line} aria-hidden="true">
            <Word i={2}>leaves</Word> <Word i={3}>a</Word> <Word i={4} accent>trail</Word>
          </span>
        </h1>
        <div className={styles.copy} data-trail-avoid="">
          <p className={styles.lede}>
            Blink is an experimental prediction-research platform built for agents: questions with explicit
            resolution rules, traceable evidence, signed quotes, and test trades on Base Sepolia.
          </p>
          <p className={`mono ${styles.status}`}>M0–M2 built locally · No public deployment · No trading here</p>
        </div>
        <div className={styles.band} data-trail-band="">
          {nodes.map(({ label, Art, x, y, mx, my }, n) => (
            <figure key={label} className={styles.node} data-trail-node="" style={{ "--x": x, "--y": y, "--mx": mx, "--my": my, "--n": n } as CSSProperties}>
              <Art title={label} />
              <figcaption className="mono">{label}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
