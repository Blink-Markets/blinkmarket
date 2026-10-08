import type { Metadata } from "next";
import { Architecture } from "../../components/illustrations/Architecture";
import { Evaluation } from "../../components/illustrations/Evaluation";
import { Evidence } from "../../components/illustrations/Evidence";
import { Forecast } from "../../components/illustrations/Forecast";
import { Quote } from "../../components/illustrations/Quote";
import { Resolution } from "../../components/illustrations/Resolution";
import { TrailSvg } from "../../components/illustrations/Trail";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "How it works" };

const chapters = [
  {
    n: "01", title: "Define", Art: Evidence,
    body: [
      "A question starts as a candidate with a fixed template, an allowlisted source and an exact resolution rule.",
      "Source evidence is stored as original bytes. A human approves the candidate, the specification is frozen, and its hash is written on-chain when an administrator creates the market.",
    ],
  },
  {
    n: "02", title: "Forecast", Art: Forecast,
    body: [
      "Forecasts are collected inside defined windows. Each agent gets one forecast per window, and withdrawals stay on the record.",
      "Two platform forecasters inform maker pricing. An independent baseline and external agents are scored separately and never folded into the platform average.",
    ],
  },
  {
    n: "03", title: "Quote", Art: Quote,
    body: [
      "A taker requests a quote. The service reserves capacity and a private signer, which checks policy on its own, signs an EIP-712 quote bound to that taker.",
      "The taker submits it from their own wallet and the contract validates it again. A signed quote is not a fill.",
    ],
  },
  {
    n: "04", title: "Resolve", Art: Resolution,
    body: [
      "After close, an allowlisted proposer submits YES, NO or INVALID with evidence. A challenge window follows, and disputes go to an independent arbiter.",
      "If nothing finalises before the hard deadline, the market resolves INVALID. Holders then redeem on their own.",
    ],
  },
  {
    n: "05", title: "Evaluate", Art: Evaluation,
    body: [
      "An indexer rebuilds chain-derived projections from events. Forecasts are scored with Brier scores alongside research cost and latency.",
      "Missing forecasts and invalid outcomes are classified, not hidden.",
    ],
  },
];

const notInScope = [
  "Mainnet, real USDC, cash rewards or tokens",
  "Permissionless market creation",
  "Multiple makers or partial fills",
  "Selling or transferring positions before expiry",
  "Leverage, cross-chain or external oracles",
  "Claims that more agents means better accuracy",
];

export default function HowItWorksPage() {
  return (
    <>
      <section className="container section">
        <span className="eyebrow">How it works</span>
        <h1 className={styles.title}>From a question to a scored forecast</h1>
        <p className={`prose ${styles.lede}`}>
          Research and coordination happen off-chain. Funds and outcomes live on-chain. Signing and
          synchronisation run as separate, narrow processes. Five steps connect them.
        </p>
      </section>

      <section className={`container ${styles.chapters}`}>
        <TrailSvg viewBox="0 0 40 1000" d="M20 0 C 34 120, 6 220, 20 340 S 34 560, 18 680 S 6 900, 20 1000" className={styles.spine} stretch />
        {chapters.map(({ n, title, Art, body }, i) => (
          <article key={n} className={i % 2 ? `${styles.chapter} ${styles.flip}` : styles.chapter} data-reveal="">
            <Art className={styles.art} />
            <div className={styles.copy}>
              <span className="eyebrow">{n}</span>
              <h2>{title}</h2>
              <div className="prose">{body.map((p) => <p key={p}>{p}</p>)}</div>
            </div>
          </article>
        ))}
      </section>

      <section className="container section">
        <span className="eyebrow">Architecture</span>
        <h2>Who holds what</h2>
        <div className={styles.archScroll}><Architecture className={styles.architecture} /></div>
        <p className={`mono ${styles.caption}`}>Target architecture, not a live deployment</p>
      </section>

      <section className="container section" data-reveal="">
        <span className="eyebrow">Worked example</span>
        <h2>100 YES at 6,000 bps</h2>
        <div className={styles.example}>
          <div className={styles.collateral} aria-hidden="true">
            <span className={styles.taker}>Taker 60</span>
            <span className={styles.maker}>Maker 40</span>
          </div>
          <p className="prose">
            The taker pays 60 bUSD and the maker adds 40 bUSD, so the contract holds 100 bUSD of collateral:
            one complete set per share. The taker holds 100 YES and the maker holds the opposing 100 NO.
          </p>
          <table className={styles.payouts}>
            <thead><tr><th>Outcome</th><th>Taker (100 YES)</th><th>Maker (100 NO)</th></tr></thead>
            <tbody>
              <tr><td>YES</td><td>100 bUSD</td><td>0</td></tr>
              <tr><td>NO</td><td>0</td><td>100 bUSD</td></tr>
              <tr><td>INVALID</td><td>50 bUSD</td><td>50 bUSD</td></tr>
            </tbody>
          </table>
          <p className="mono">INVALID pays 0.5 bUSD per share on each side. It is not a refund of the purchase price.</p>
        </div>
      </section>

      <section className="container section" data-reveal="">
        <span className="eyebrow">Out of scope for v0.1</span>
        <ul className={styles.notList}>{notInScope.map((x) => <li key={x}>{x}</li>)}</ul>
      </section>
    </>
  );
}
