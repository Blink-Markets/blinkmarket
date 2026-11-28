import type { FreshnessView } from "@blink/schemas";
import styles from "./FreshnessLine.module.css";

const levelNames: Record<FreshnessView["level"], string> = {
  CURRENT: "Current",
  AGING: "Aging",
  STALE: "Stale",
  NONE: "No answers",
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type Props = {
  /** Null for a market that is not OPEN: forecasting ended at close, so there is no level. */
  freshness: FreshnessView | null;
  open: boolean;
  /** The date (UTC) of the latest window. */
  lastWindow: string;
  /** Sources the latest window's answers reported as changed. */
  changedSources: number;
  /** True when the values are sample data. */
  sample?: boolean;
};

// Window times and the level come from the platform's clock; "new analysis" and "changed" are what the
// forecasters reported, and the line says so.
export function FreshnessLine({ freshness, open, lastWindow, changedSources, sample = false }: Props) {
  const notice = sample ? <span className={styles.sample}>Sample data</span> : null;
  if (!open || freshness === null) {
    return (
      <p className={styles.line} data-testid="freshness-line">
        <span>Forecasting ended at close; last window {lastWindow}</span>
        {notice}
      </p>
    );
  }
  const latest = freshness.latestWindow;
  return (
    <p className={styles.line} data-testid="freshness-line">
      <span className={styles.level} data-level={freshness.level} data-testid="freshness-level">{levelNames[freshness.level]}</span>
      <span>Latest window {lastWindow}</span>
      <span>{count(freshness.windowsBehind, "window", "windows")} behind</span>
      <span>{latest.analysed} of {latest.answers} {latest.answers === 1 ? "answer" : "answers"} reported a new analysis</span>
      <span>{count(changedSources, "source", "sources")} changed (reported)</span>
      {notice}
    </p>
  );
}
