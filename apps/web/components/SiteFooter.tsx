import styles from "./SiteFooter.module.css";

export function SiteFooter() {
  return (
    <footer className={`container ${styles.footer}`}>
      <p className={styles.line}>Blink Market is an experiment. M0–M1 are built and verified locally and M2 is in progress; nothing is deployed to Base Sepolia yet.</p>
      <p className="mono">
        <a href="https://github.com/Blink-Markets/blinkmarket">Source on GitHub</a> · Spec v0.1 · Test assets only
      </p>
    </footer>
  );
}
