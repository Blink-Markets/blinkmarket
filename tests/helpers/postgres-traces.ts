import pg from "pg";

// Random databases and service logins that withDatabase creates; a leaked one outlives its run.
const TRACES = `
  SELECT 'database ' || datname AS trace FROM pg_database WHERE datname LIKE 'blink\\_t8\\_%'
  UNION ALL
  SELECT 'role ' || rolname FROM pg_roles WHERE rolname LIKE 't8\\_%'`;

async function current() {
  const control = new pg.Client({
    connectionString: process.env.TEST_POSTGRES_ADMIN_URL,
  });
  await control.connect();
  try {
    return new Set<string>(
      (await control.query(TRACES)).rows.map((row) => row.trace),
    );
  } finally {
    await control.end();
  }
}

export const databaseTraces = current;

// Traces that appeared after `before` and are still there. Runs of other test files may be
// in flight on the same server, so wait for such transient ones to leave before judging.
export async function leakedTraces(
  before: Set<string>,
  waitMs = 20_000,
): Promise<string[]> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const leaked = [...(await current())].filter((trace) => !before.has(trace));
    if (leaked.length === 0 || Date.now() > deadline) return leaked;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
