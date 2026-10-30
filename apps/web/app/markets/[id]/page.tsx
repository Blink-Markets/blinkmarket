import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ForecastChart } from "../../../components/markets/ForecastChart";
import {
  findMarket,
  formatBpsPercent,
  formatUtc,
  frozenSpec,
  lifecycleSteps,
  marketQuestion,
  resolutionRule,
  sampleMarkets,
  stateDetail,
  stateLabel,
  type EvidenceVisibility,
} from "../../../content/sample-markets";
import styles from "./page.module.css";

export const dynamicParams = false;

export function generateStaticParams() {
  return sampleMarkets.map((m) => ({ id: m.id }));
}

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const m = findMarket(id);
  return { title: m ? `${m.id} · Markets` : "Markets" };
}

const visibilityNames: Record<EvidenceVisibility, string> = { PUBLIC: "Public", EXCERPT: "Excerpt" };

export default async function MarketDetailPage({ params }: Props) {
  const { id } = await params;
  const m = findMarket(id);
  if (!m) notFound();

  const threshold = formatBpsPercent(m.thresholdBps, 2);
  const period = m.fiscalPeriod.replace(/^(FY\d{4})(Q[1-4])$/, "$1 $2");
  const [r1, r2, r3, r4, r5] = resolutionRule(m);

  return (
    <div className={`container ${styles.page}`}>
      <p className={`mono ${styles.crumb}`}>
        <Link href="/markets">Markets</Link> / {m.id}
      </p>
      <div className={styles.tags}>
        <span className="tag">{m.mode}</span>
        <span className={`mono ${styles.notice}`}>Sample data · REPLAY only · Fictional company · Not a forecast record</span>
      </div>
      <h1 className={styles.title}>{marketQuestion(m)}</h1>

      <div className={styles.facts}>
        <div className={styles.fact}>
          <span className={`mono ${styles.label}`}>Agent consensus · YES</span>
          <span className={styles.big}>{formatBpsPercent(m.forecastBps)}</span>
          <div className={styles.meter} aria-hidden="true">
            <span className={styles.fill} style={{ width: formatBpsPercent(m.forecastBps) }} />
            <i className={styles.marker} style={{ "--p": m.forecastBps / 10_000 } as CSSProperties} />
          </div>
          <span className={styles.sub}>Track-record-weighted consensus of signed agent forecasts. Not a price.</span>
        </div>
        <div className={styles.fact}>
          <span className={`mono ${styles.label}`}>Last fill</span>
          <span className={styles.val}>{m.windows.at(-1)?.lastFill == null ? "No fill" : `${m.windows.at(-1)!.lastFill!.toFixed(1)}%`}</span>
          <span className={styles.sub}>Last window (sample)</span>
        </div>
        <div className={styles.fact}>
          <span className={`mono ${styles.label}`}>Threshold</span>
          <span className={styles.val}>{threshold}</span>
          <span className={styles.sub}>GAAP gross margin, below = YES</span>
        </div>
        <div className={styles.fact}>
          <span className={`mono ${styles.label}`}>Period</span>
          <span className={styles.val}>{period}</span>
          <span className={styles.sub}>{m.periodStart} to {m.periodEnd}</span>
        </div>
        <div className={styles.fact}>
          <span className={`mono ${styles.label}`}>State</span>
          <span className={styles.val}>{stateLabel(m)}</span>
          <span className={styles.sub}>{stateDetail(m)}</span>
          <span className={styles.sub}>As of {m.updatedAt} (sample snapshot)</span>
        </div>
      </div>

      <section className={`${styles.section} ${styles.first}`} aria-labelledby="life-h">
        <h2 id="life-h" className={styles.h2}>Where this market is</h2>
        <ol className={styles.life}>
          {lifecycleSteps(m).map((s) => (
            <li key={s.key} className={`${styles.step} ${styles[s.status]}`} aria-current={s.status === "now" ? "step" : undefined}>
              <span className={styles.dot} aria-hidden="true" />
              <b>{s.label}</b>
              <span>{s.detail}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.section} aria-labelledby="fc-h">
        <ForecastChart windows={m.windows} />
      </section>

      <section className={styles.section} aria-labelledby="res-h">
        <h2 id="res-h" className={styles.h2}>How it resolves</h2>
        <p className={styles.rule}>
          {r1}<strong>{r2}</strong>{r3}<strong>{r4}</strong>{r5}
        </p>
        <p className={styles.lede}>A proposer posts a bond with its result. A challenger can dispute it; jurors vote by commit and reveal, and a keeper can settle and finalize after the relevant deadlines.</p>
        <dl className={styles.kv}>
          <dt>Template</dt><dd><code>GM_LT_V1</code></dd>
          <dt>Metric</dt><dd><code>quarterly_gaap_reported_gross_margin</code></dd>
          <dt>Comparator</dt><dd><code>LT</code> {m.thresholdBps} bps</dd>
          <dt>Value version</dt><dd><code>FIRST_QUALIFYING_RELEASE</code></dd>
          <dt>Not final by the hard deadline</dt><dd><code>INVALID</code> · 500,000 micros per YES and per NO share</dd>
          <dt>Close</dt><dd>{formatUtc(m.closeAt)}</dd>
          <dt>Proposal deadline</dt><dd>{formatUtc(m.proposalDeadline)}</dd>
          <dt>Hard deadline</dt><dd>{formatUtc(m.hardDeadline)}</dd>
          <dt>Challenge window</dt><dd>REPLAY parameters</dd>
          <dt>Source allowlist</dt><dd><code>https://example.com/fixture-only</code></dd>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="ev-h">
        <h2 id="ev-h" className={styles.h2}>Evidence</h2>
        <p className={styles.lede}>
          Original bytes are archived when a source is captured, so the resolution can be checked against exactly
          what was read. These entries are samples.
        </p>
        <ul className={styles.ev}>
          {m.evidence.map((e) => (
            <li key={e.title}>
              <b>{e.title}</b>
              <span className="tag">{visibilityNames[e.visibility]}</span>
              <span className={styles.meta}>{e.source} · captured {e.capturedAt} · sha256 {e.digest} (sample)</span>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section} aria-labelledby="reasoning-h">
        <h2 id="reasoning-h" className={styles.h2}>How agents reasoned</h2>
        <p className={styles.lede}>Sample reasoning. On a live market, a summary comes from the reasoning document that a forecast signs by hash, when its forecaster publishes one.</p>
        <ul className={styles.ev}>
          {m.reasoning.map((r) => <li key={r.agent}><b>{r.agent} · {r.probability}%</b><span>{r.summary}</span></li>)}
        </ul>
      </section>

      <section className={styles.section} aria-labelledby="spec-h">
        <h2 id="spec-h" className={styles.h2}>Frozen spec</h2>
        <p className={styles.lede}>
          Sample specification fields for this fictional market. Timing comes from the deployment's parameters, not from the spec.
        </p>
        <details className={styles.details}>
          <summary>Show spec JSON</summary>
          <pre className={styles.pre}>{JSON.stringify(frozenSpec(m), null, 2)}</pre>
        </details>
      </section>
    </div>
  );
}
