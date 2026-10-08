import type { CSSProperties } from "react";
import { formatBpsPercent, marketQuestion, stateLabel, type SampleMarket } from "../content/sample-markets";
import styles from "./MarketLedger.module.css";

export function MarketLedger({ markets }: { markets: readonly SampleMarket[] }) {
  return (
    <div className={styles.ledger}>
      <div className={`${styles.row} ${styles.head} mono`} aria-hidden="true">
        <span>Question</span><span>Mode</span><span>Forecast · YES</span><span>State</span><span>Updated</span>
      </div>
      <ol className={styles.list}>
        {markets.map((m) => (
          <li key={m.id} className={styles.row} data-reveal="">
            <p className={styles.question}>{marketQuestion(m)}</p>
            <span className={styles.mode}><span className="tag">{m.mode}</span></span>
            <span className={styles.forecast}>
              <span className={styles.track} aria-hidden="true">
                <span className={styles.fill} style={{ width: formatBpsPercent(m.forecastBps) }} />
                <span className={styles.marker} style={{ "--p": m.forecastBps / 10_000 } as CSSProperties} />
              </span>
              <span className={styles.pct}>{formatBpsPercent(m.forecastBps)}</span>
            </span>
            <span className={`mono ${styles.state}`}>{stateLabel(m)}</span>
            <time className={`mono ${styles.updated}`} dateTime={m.updatedAt}>{m.updatedAt}</time>
          </li>
        ))}
      </ol>
    </div>
  );
}
