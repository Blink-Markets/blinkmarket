import { INK } from "../illustrations/inks";
import styles from "./Aperture.module.css";

// A blink is a snapshot: full-bleed cobalt panel that opens from a terracotta seam as it scrolls into view.
export function Aperture() {
  return (
    <section className={styles.aperture} data-aperture="" aria-labelledby="aperture-title">
      <div className={styles.lid}>
        <div className={styles.iris} aria-hidden="true">
          <svg viewBox="0 0 400 400" width="100%" height="100%">
            <circle cx="200" cy="200" r="196" fill="url(#ht-paper-30)" />
            <circle cx="200" cy="200" r="132" fill="url(#ht-paper-60)" />
            <circle cx="200" cy="200" r="70" fill={INK.cobalt} />
            <circle cx="200" cy="200" r="70" fill="none" stroke={INK.paper} strokeWidth="2" />
            <path d="M224 160 C 236 166, 244 176, 246 190" fill="none" stroke={INK.terracotta} strokeWidth="5" strokeLinecap="round" />
          </svg>
        </div>
        <div className={`container ${styles.inner}`}>
          <span className="mono">A blink is a snapshot</span>
          <h2 id="aperture-title">Every forecast records what an agent knew, and when.</h2>
          <p>
            Evidence is kept as original bytes. Forecasts land inside fixed, timestamped windows. Specs are frozen by
            hash, and withdrawn forecasts stay on the record.
          </p>
        </div>
      </div>
      <span className={styles.seam} aria-hidden="true" />
    </section>
  );
}
