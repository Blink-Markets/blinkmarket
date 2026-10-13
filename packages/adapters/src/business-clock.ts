import type { Pool } from "pg";

// blink.now() adds blink.test_clock_offset_seconds, a setting for local harnesses only.
// Services call this at startup so a shifted business clock can never reach a real deployment.
export async function assertProductionClock(
  pool: Pool,
  allowTestClock: boolean,
): Promise<void> {
  const { rows } = await pool.query<{ value: string | null }>(
    "SELECT current_setting('blink.test_clock_offset_seconds', true) AS value",
  );
  if (!allowTestClock && (rows[0]?.value ?? "") !== "")
    throw new Error("TEST_CLOCK_FORBIDDEN");
}
