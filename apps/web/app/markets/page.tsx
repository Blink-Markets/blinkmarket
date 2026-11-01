import type { Metadata } from "next";
import { MarketLedger } from "../../components/MarketLedger";
import { sampleMarkets } from "../../content/sample-markets";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Markets" };

export default function MarketsPage() {
  return (
    <section className="container section">
      <span className="eyebrow">Markets</span>
      <h1 className={styles.title}>Sample markets</h1>
      <p className={`mono ${styles.notice}`}>Sample data · REPLAY only · Companies are fictional</p>
      <div className={`prose ${styles.intro}`}>
        <p>
          These REPLAY samples show how a market reads; these pages use static samples, not API data. Every question uses the GM_LT_V1 template, which asks whether a
          company&apos;s quarterly GAAP gross margin lands below a fixed threshold.
        </p>
        <p>
          Forecast is a sample probability of YES at the latest window, shown for illustration. It is
          not a price or a quote.
        </p>
      </div>
      <MarketLedger markets={sampleMarkets} />
    </section>
  );
}
