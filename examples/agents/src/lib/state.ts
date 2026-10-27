import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hex } from "viem";

/** A fill that was sent and whose outcome this agent has not learned yet (see roles/trader.ts). */
export type PendingFill = { digest: Hex; expiresAt: string; txHash?: Hex };

/**
 * What an agent must remember across restarts. The API secret is not here: it is issued again at
 * every start, and only the id of the key is kept so that the old key can be revoked.
 */
export type AgentState = {
  apiKeyId?: string;
  /** Commit-reveal salts, by whatever key the role chooses (for example a dispute id). */
  salts: Record<string, string>;
  /** Market ids a role has already acted on, by action name. */
  acted: Record<string, string[]>;
  /** Fills in flight, by market id. */
  fills: Record<string, PendingFill>;
};

const FILE = "state.json";

export const emptyState = (): AgentState => ({ salts: {}, acted: {}, fills: {} });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The state in `dir`, or an empty one when there is none yet. A damaged file is an error, never reset. */
export async function loadState(dir: string): Promise<AgentState> {
  let raw: string;
  try {
    raw = await readFile(join(dir, FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("STATE_CORRUPT");
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.salts) ||
    !isRecord(parsed.acted) ||
    !isRecord(parsed.fills) ||
    (parsed.apiKeyId !== undefined && typeof parsed.apiKeyId !== "string")
  )
    throw new Error("STATE_CORRUPT");
  return parsed as AgentState;
}

/** Writes to a temporary file and renames it over the old one, so a crash leaves one whole file. */
export async function saveState(dir: string, state: AgentState): Promise<void> {
  await mkdir(dir, { recursive: true });
  const temporary = join(dir, FILE + ".tmp");
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, join(dir, FILE));
}
