import { formatUtc, type ForecastWindow } from "../../content/sample-markets";
import styles from "./EvidenceChanges.module.css";

type Props = {
  windows: readonly ForecastWindow[];
  /** True when the values are sample data. */
  sample?: boolean;
};

function sourceParts(url: string): { host: string; path: string } {
  const u = new URL(url);
  return { host: u.host, path: u.pathname === "/" ? "" : u.pathname };
}

const pct = (v: number) => `${v.toFixed(1)}%`;

// Reads only the changes that forecasters reported (status CHANGED). A first check is counted apart and
// never shown as a change. The static site cannot check a snapshot, so a hash is shown as text and nothing
// here links to one.
export function EvidenceChanges({ windows, sample = false }: Props) {
  const changes = windows
    .flatMap((w) => w.changes.map((c) => ({ ...c, window: w.date })))
    .sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : a.source < b.source ? -1 : 1));
  const firstChecked = windows.filter((w) => w.firstChecked > 0);
  return (
    <>
      <p className={styles.lede}>
        The latest changes in the sources that forecasters watch, newest first.{sample ? " Sample data." : ""}
      </p>
      <p className={styles.reported}>Reported by the forecasters; an archived snapshot can be checked against its hash.</p>
      {changes.length === 0 ? (
        <p className={styles.none}>No source change was reported in these windows.</p>
      ) : (
        <ol className={styles.list} data-testid="changes">
          {changes.map((c) => {
            const { host, path } = sourceParts(c.source);
            return (
              <li key={`${c.window}-${c.source}`} className={styles.item} data-testid="change" data-observed={c.observedAt}>
                <b>{host}</b>
                <span className={styles.path}>{path}</span>
                <span className={styles.meta}>
                  Window {c.window} · changed between {formatUtc(c.since)} and {formatUtc(c.observedAt)} (reported)
                </span>
                <span className={styles.summary}>{c.summary}</span>
                <span className={styles.moves}>
                  {c.moves.map((mv) => (
                    <span key={mv.agent}>{mv.agent}: {pct(mv.from)} to {pct(mv.to)}</span>
                  ))}
                </span>
                <span className={styles.hash}>
                  {c.snapshot === null ? "Snapshot not available" : `Snapshot hash ${c.snapshot}${sample ? " (sample)" : ""}`}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {firstChecked.length > 0 && (
        <p className={styles.first}>
          First checked, not a change:{" "}
          {firstChecked.map((w) => `${w.firstChecked} ${w.firstChecked === 1 ? "source" : "sources"} on ${w.date}`).join("; ")}.
        </p>
      )}
    </>
  );
}
