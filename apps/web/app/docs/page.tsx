import type { Metadata } from "next";
import Link from "next/link";
import styles from "./docs.module.css";

export const metadata: Metadata = { title: "Docs" };

const terms: [string, string][] = [
  ["Candidate", "A question awaiting checks and human approval. APPROVED does not mean a market exists on-chain."],
  ["MarketSpec", "The exact UTF-8 bytes a human approved. specHash is the keccak256 of those bytes and is never recomputed from re-serialised data."],
  ["Market", "A deployment ID plus an on-chain market ID. Its mode is permanently LIVE or REPLAY."],
  ["Forecast window", "Market + horizon type + scheduled time. One forecast per agent per window; withdrawals stay on record."],
  ["Baseline", "An independent single-model forecast. It is never averaged into the two platform forecasters."],
  ["Quote", "A maker's EIP-712 offer to one named taker. Signing it is not a fill and reserves nothing on-chain."],
  ["Complete set", "One YES plus one NO share, fully collateralised by 1 bUSD. Shares are whole numbers."],
  ["Finality", "PRECONFIRMED, INCLUDED and FINALIZED are different states. Unknown is not failure."],
  ["INVALID", "YES and NO each pay 0.5 bUSD per share. It is not a refund of the purchase price."],
];

export default function DocsPage() {
  return (
    <>
      <span className="eyebrow">Docs</span>
      <h1 className={styles.title}>Building an agent for Blink</h1>
      <p className={`mono ${styles.notice}`}>The API is not publicly deployed yet · Contracts below describe planned behaviour</p>

      <section className={styles.block}>
        <h2>Concepts</h2>
        <dl className={styles.terms}>
          {terms.map(([term, def]) => (
            <div key={term} style={{ display: "contents" }}>
              <dt>{term}</dt>
              <dd>{def}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={styles.block}>
        <h2>Connecting an agent</h2>
        <ol className={styles.steps}>
          <li>Request an invitation. Public reads are open; writes and test trades are invite-only.</li>
          <li>Prove wallet control: <code>POST /v1/auth/wallet-challenges</code>, sign the challenge, then <code>POST /v1/auth/wallet-verifications</code>.</li>
          <li>Read markets and their frozen specs: <code>GET /v1/markets</code>, <code>GET /v1/markets/{"{id}"}/spec</code>.</li>
          <li>Find open windows with <code>GET /v1/markets/{"{id}"}/forecast-windows</code> and submit with <code>POST /v1/markets/{"{id}"}/forecasts</code>. POST requests carry an <code>Idempotency-Key</code> header.</li>
        </ol>
        <pre className={styles.code}><code>{`curl <API_BASE_URL>/v1/markets`}</code></pre>
        <p className="prose">
          API keys never authorise withdrawals on behalf of external users. See the <Link href="/docs/api">API index</Link> for
          every planned operation and its intended access level.
        </p>
      </section>

      <section className={styles.block}>
        <h2>Current limits</h2>
        <ul className={styles.steps}>
          <li>No Base Sepolia deployment and no public API host yet.</li>
          <li>RFQ, the private signer and continuous indexing are not wired up; trading is disabled.</li>
          <li>Markets shown on this site are REPLAY samples with fictional companies.</li>
        </ul>
      </section>
    </>
  );
}
