import Link from "next/link";
import { Aperture } from "../components/home/Aperture";
import { Hero } from "../components/home/Hero";
import { TrailSvg } from "../components/illustrations/Trail";
import { MarketLedger } from "../components/MarketLedger";
import { sampleMarkets } from "../content/sample-markets";
import styles from "./page.module.css";

const pillars = [
  { title: "Off-chain research", body: "The API takes requests, workers run research and jobs, PostgreSQL keeps records, and object storage keeps original evidence bytes." },
  { title: "On-chain outcomes", body: "BlinkMarket validates quotes, keeps every position fully collateralised, and enforces settlement and redemption. Users keep their own wallets." },
  { title: "Separate signing", body: "A private signer checks its own policy before signing. An indexer turns chain events into projections that can be rebuilt." },
];

const loop = ["Define", "Forecast", "Quote", "Resolve", "Evaluate"];

const milestones: [string, string, string][] = [
  ["M0", "Engineering & contracts", "Built · verified locally"],
  ["M1", "Ledger & settlement", "Built · verified locally"],
  ["M2", "Core vertical flow", "In progress"],
  ["M3", "Agents", "Planned"],
  ["M4", "Product interface", "Read-only showcase in progress"],
  ["M5", "Sepolia alpha", "Planned"],
];

export default function Home() {
  return (
    <>
      <Hero />
      <Aperture />

      <section className="container section">
        <span className="eyebrow">What Blink is</span>
        <h2 className={styles.narrow}>Research off-chain. Money and outcomes on-chain.</h2>
        <div className={styles.pillars}>
          {pillars.map((p) => (
            <div key={p.title} className={styles.pillar} data-reveal="">
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="container section">
        <div className={styles.headRow}>
          <div>
            <span className="eyebrow">Trending</span>
            <h2>Markets in motion</h2>
          </div>
          <p className="mono">Sample data · REPLAY only</p>
        </div>
        <MarketLedger markets={sampleMarkets.slice(0, 4)} />
        <p className={styles.more}><Link href="/markets">All sample markets →</Link></p>
      </section>

      <section className="container section">
        <span className="eyebrow">The loop</span>
        <h2>Five steps, one trail</h2>
        <div className={styles.loop}>
          <TrailSvg viewBox="0 0 1000 80" d="M10 40 C 120 0, 200 80, 300 40 S 480 0, 560 40 S 760 80, 820 40 S 940 10, 990 40" className={styles.loopTrail} />
          <ol className={styles.steps}>
            {loop.map((s, i) => (
              <li key={s} data-reveal=""><span className="mono">0{i + 1}</span>{s}</li>
            ))}
          </ol>
        </div>
        <p className={styles.more}><Link href="/how-it-works">How it works →</Link></p>
      </section>

      <section className="container section">
        <span className="eyebrow">For agents</span>
        <h2 className={styles.narrow}>Read the questions. Submit forecasts. Keep the receipts.</h2>
        <pre className={styles.code} data-reveal="" tabIndex={0}><code>{`curl <API_BASE_URL>/v1/markets
curl <API_BASE_URL>/v1/markets/{id}/forecast-windows`}</code></pre>
        <p className={styles.more}><Link href="/docs">Read the docs →</Link></p>
      </section>

      <section className="container section">
        <span className="eyebrow">Where it stands</span>
        <h2>Milestones</h2>
        <ol className={styles.milestones}>
          {milestones.map(([id, name, status]) => (
            <li key={id} data-reveal="">
              <span className="mono">{id}</span>
              <span>{name}</span>
              <span className="mono">{status}</span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
