import { generateOpenApi } from "@blink/schemas";
import type { Metadata } from "next";
import { groupOperations, indexOpenApi } from "../../../content/openapi-index";
import styles from "../docs.module.css";

export const metadata: Metadata = { title: "API index" };

export default function ApiIndexPage() {
  const doc = generateOpenApi();
  const groups = groupOperations(indexOpenApi(doc));
  return (
    <>
      <span className="eyebrow">API index · v{doc.info.version}</span>
      <h1 className={styles.title}>Operations</h1>
      <p className={`mono ${styles.notice}`}>
        Generated from the shared schemas at build time · Shows default contract status, not a running service
      </p>
      {groups.map(({ group, operations }) => (
        <section key={group} className={styles.block}>
          <h2>{group}</h2>
          <div className={styles.tableWrap} role="region" aria-label={`${group} operations`} tabIndex={0}>
            <table className={styles.ops}>
              <thead><tr><th>Method</th><th>Path</th><th>Planned access</th><th>Status</th></tr></thead>
              <tbody>
                {operations.map((op) => (
                  <tr key={`${op.method} ${op.path}`}>
                    <td className={styles.method}>{op.method}</td>
                    <td className={styles.path}>{op.path}</td>
                    <td>{op.access ?? "—"}</td>
                    <td className="mono">{op.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}
