import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ForecastChart } from "../../../components/markets/ForecastChart";
import {
  findMarket,
  formatBpsPercent,
  formatUsdMicros,
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

const visibilityNames: Record<EvidenceVisibility, string> = { PUBLIC: "Public", EXCERPT: "Excerpt", PRIVATE: "Private" };

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
        <span className={`mono ${styles.notice}`}>Sample data · Fictional company · Not a forecast record</span>
      </div>
      <h1 className={styles.title}>{marketQuestion(m)}</h1>

      <div className={styles.facts}>
        <div className={styles.fact}>
          <span className={`mono ${styles.label}`}>Platform forecast · YES</span>
          <span className={styles.big}>{formatBpsPercent(m.forecastBps)}</span>
          <div className={styles.meter} aria-hidden="true">
            <span className={styles.fill} style={{ width: formatBpsPercent(m.forecastBps) }} />
            <i className={styles.marker} style={{ "--p": m.forecastBps / 10_000 } as CSSProperties} />
          </div>
          <span className={styles.sub}>Average of the two platform forecasters. Not a price.</span>
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
        <dl className={styles.kv}>
          <dt>Template</dt><dd><code>GM_LT_V1</code></dd>
          <dt>Metric</dt><dd><code>quarterly_gaap_reported_gross_margin</code></dd>
          <dt>Comparator</dt><dd><code>LT</code> {m.thresholdBps} bps</dd>
          <dt>Value version</dt><dd><code>FIRST_QUALIFYING_RELEASE</code></dd>
          <dt>Missing value</dt><dd><code>INVALID</code> · 500,000 micros per YES and per NO share</dd>
          <dt>Close</dt><dd>{formatUtc(m.closeAt)}</dd>
          <dt>Proposal deadline</dt><dd>{formatUtc(m.proposalDeadline)}</dd>
          <dt>Hard deadline</dt><dd>{formatUtc(m.hardDeadline)}</dd>
          <dt>Challenge window</dt><dd>120 seconds (REPLAY)</dd>
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

      <section className={styles.section} aria-labelledby="cost-h">
        <h2 id="cost-h" className={styles.h2}>Research cost</h2>
        <p className={styles.lede}>What it cost to research and forecast this question, in test budget (sample figures).</p>
        <div className={styles.cost}>
          <div><span className={`mono ${styles.label}`}>Spent</span><span className={styles.val}>{formatUsdMicros(m.cost.spentMicros)}</span><span className={styles.sub}>model calls and source fetches (sample)</span></div>
          <div><span className={`mono ${styles.label}`}>Reserved</span><span className={styles.val}>{formatUsdMicros(m.cost.reservedMicros)}</span><span className={styles.sub}>for remaining windows (sample)</span></div>
          <div><span className={`mono ${styles.label}`}>Unknown</span><span className={styles.val}>{formatUsdMicros(m.cost.unknownMicros)}</span><span className={styles.sub}>calls with no confirmed cost (sample)</span></div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="spec-h">
        <h2 id="spec-h" className={styles.h2}>Frozen spec</h2>
        <p className={styles.lede}>
          The exact bytes a human approved. The market commits to their keccak256 hash; nobody can change the
          question after creation.
        </p>
        <details className={styles.details}>
          <summary>Show spec JSON</summary>
          <pre className={styles.pre}>{JSON.stringify(frozenSpec(m), null, 2)}</pre>
        </details>
      </section>
    </div>
  );
}
