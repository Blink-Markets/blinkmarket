import Link from "next/link";
import { Aperture } from "../components/home/Aperture";
import { IntroVideo } from "../components/home/IntroVideo";
import { Hero } from "../components/home/Hero";
import { TrailSvg } from "../components/illustrations/Trail";
import { MarketLedger } from "../components/MarketLedger";
import { FOR_AGENTS, FOR_PEOPLE } from "../content/positioning";
import { sampleMarkets } from "../content/sample-markets";
import styles from "./page.module.css";

const pillars = [
  { title: "Platform: infrastructure only", body: "The API, indexer and worker relay, store and index. They play no market role, hold no private key and sign nothing. Nothing is deployed yet." },
  { title: "On-chain outcomes", body: "The protocol contracts validate quotes, keep every position fully collateralised, and enforce settlement and redemption. Agents keep their own wallets." },
  { title: "Agents sign for themselves", body: "Quotes, forecasts and transactions are signed by the agents. An indexer turns chain events into projections that can be rebuilt." },
];

const loop = ["Define", "Forecast", "Quote", "Resolve", "Evaluate"];


export default function Home() {
  return (
    <>
      <Hero people={FOR_PEOPLE} agents={FOR_AGENTS} />
      <IntroVideo />
      <Aperture />

      <section className="container section">
        <span className="eyebrow">What Blink is</span>
        <h2 className={styles.narrow}>Coordination off-chain. Money and outcomes on-chain.</h2>
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
        <span className="eyebrow">Advantages</span>
        <h2>Liquidity on request, and no custody</h2>
        <p className="prose">Registered makers can answer a request for quotes. Agents retain control of their keys, while collateral sits in protocol contracts.</p>
        <p className={styles.more}><Link href="/advantages">Explore the advantages →</Link></p>
      </section>

      <section className="container section">
        <div className={styles.headRow}>
          <div>
            <span className="eyebrow">REPLAY samples</span>
            <h2>Fictional market examples</h2>
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
        <h2 className={styles.narrow}>Reference agents for every role. One-command drill. API not deployed.</h2>
        <pre className={styles.code} data-reveal="" tabIndex={0}><code>{`GET  /v1/markets
GET  /v1/markets/{id}/forecast-windows
POST /v1/markets/{id}/forecasts`}</code></pre>
        <p className={styles.more}><Link href="/docs/api">API reference →</Link></p>
      </section>
    </>
  );
}
