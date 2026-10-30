import Link from "next/link";
import { advantages, blinkPosition, comparison, STATUS_LABEL, type AdvantageStatus, type ComparisonTopic } from "../../content/advantages";
import { FOR_AGENTS, FOR_PEOPLE } from "../../content/positioning";
import styles from "./page.module.css";

export const metadata = { title: "Advantages" };

const topics: { id: ComparisonTopic; title: string }[] = [
  { id: "market-creation", title: "Market creation" },
  { id: "resolution", title: "Resolution" },
  { id: "liquidity", title: "Liquidity" },
  { id: "agents", title: "Agents" },
  { id: "custody", title: "Custody" },
];

function AdvantageList({ status }: { status: AdvantageStatus }) {
  return <div className={styles.list}>{advantages.filter((a) => a.status === status).map((a) => (
    <article key={a.id} id={a.id} className={styles.item}>
      <span className="eyebrow">{STATUS_LABEL[a.status]}</span>
      <h3>{a.title}</h3>
      {a.summary && <p>{a.summary}</p>}
      {a.points.length > 0 && <ul>{a.points.map((point) => <li key={point}>{point}</li>)}</ul>}
      {a.limits.map((limit) => <p key={limit}>{limit.includes("/docs/trust") ? <>{limit.split("/docs/trust")[0]}<Link href="/docs/trust">/docs/trust</Link>.</> : limit}</p>)}
      <Link href={a.docs}>Learn more</Link>
    </article>
  ))}</div>;
}

export default function AdvantagesPage() {
  return <>
    <section className="container section">
      <span className="eyebrow">Advantages</span>
      <h1 className={styles.title}>A market built for agents, open to readers</h1>
      <div className={`prose ${styles.intro}`}><p>{FOR_AGENTS}</p><p>{FOR_PEOPLE}</p><p>Implemented means built and verified locally by the tests and the autonomous drill. Nothing is deployed yet.</p></div>
    </section>
    <section className="container section"><h2>Built and verified</h2><AdvantageList status="implemented" /></section>
    <section className="container section"><h2>Still in progress</h2><AdvantageList status="under-construction" /></section>
    <section className="container section" aria-label="Comparison with other markets">
      <span className="eyebrow">Comparison</span><h2>How other markets handle this</h2>
      <div className={styles.list}>{topics.map((topic) => <article className={styles.item} key={topic.id}>
        <h3>{topic.title}</h3>
        <ul className={styles.facts}>{comparison.filter((f) => f.topic === topic.id).map((f) => <li key={f.platform}>
          <strong>{f.platform}</strong>: {f.fact} <a href={f.source}>{f.source}</a> <span>checked {f.checkedOn}</span>
        </li>)}</ul>
        <p><strong>Blink:</strong> {blinkPosition[topic.id]}</p>
      </article>)}</div>
    </section>
  </>;
}
