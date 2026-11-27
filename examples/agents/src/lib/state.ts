import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hex } from "viem";
import { isCanonicalHttpsUrl, isEtag, isLastModified, isMediaType } from "./fetcher.ts";

/** A fill that was sent and whose outcome this agent has not learned yet (see roles/trader.ts). */
export type PendingFill = { digest: Hex; expiresAt: string; txHash?: Hex };

/** A market a creator has chosen to create: the exact spec bytes and their hash, saved before anything is sent. */
export type CreateIntent = {
  key: string;
  specHash: Hex;
  /** The spec exactly as uploaded (UTF-8 text); its keccak256 is `specHash`. */
  spec: string;
  closeInSeconds: number;
  maxPairs: number;
  suggestionId?: string;
};

/**
 * What the forecaster remembers of one market: what each followed source looked like at the last
 * successful check, and the record of its own answers (see roles/forecaster.ts).
 */
export type WatchRecord = {
  /**
   * By source URL: the fingerprint of its normalised text, its validators and the URL they belong to
   * (where the redirects ended), and when it was checked (unix seconds).
   */
  sources: Record<string, { fingerprint: Hex; etag?: string; lastModified?: string; finalUrl?: string; checkedAt: number }>;
  /** A cursor the server issued for the windows list; never built by the agent. Absent for the first page. */
  windowsCursor?: string;
  /** The agent's last answer: the digest it signed, its window, when it last ran the model, and the probability. */
  prior?: { digest: Hex; windowId: string; analysedAt: number; answeredAt: number; probabilityBps: number };
  /** An answer decided and saved before anything was uploaded, so that a restart resends identical bytes. */
  intent?: { windowId: string; kind: "analysis" | "carry_forward"; noteBytes: string; probabilityBps: number };
  /** Raw source bytes to archive once their window has closed. */
  pendingSnapshots?: { hash: Hex; mediaType: string; windowId: string }[];
};

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
  /** Markets a creator chose and has not finished, by `draft:<key>` or `suggestion:<id>`. */
  intents?: Record<string, CreateIntent>;
  /** What the forecaster watches and has answered, by market id. */
  watch?: Record<string, WatchRecord>;
};

const FILE = "state.json";

export const emptyState = (): AgentState => ({ salts: {}, acted: {}, fills: {} });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isHash = (v: unknown): boolean => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const isTime = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isString = (v: unknown): boolean => typeof v === "string";
const isOptionalString = (v: unknown): boolean => v === undefined || typeof v === "string";
// A forecast is 1 to 9999 basis points, as the API takes it.
const isBps = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 9999;

function validWatchRecord(v: unknown): boolean {
  if (!isRecord(v) || !isRecord(v.sources) || !isOptionalString(v.windowsCursor)) return false;
  for (const [url, entry] of Object.entries(v.sources))
    if (
      !isCanonicalHttpsUrl(url) ||
      !isRecord(entry) ||
      !isHash(entry.fingerprint) ||
      !isTime(entry.checkedAt) ||
      !(entry.etag === undefined || isEtag(entry.etag)) ||
      !(entry.lastModified === undefined || isLastModified(entry.lastModified)) ||
      !(entry.finalUrl === undefined || isCanonicalHttpsUrl(entry.finalUrl))
    )
      return false;
  const { prior, intent, pendingSnapshots } = v;
  if (
    prior !== undefined &&
    !(
      isRecord(prior) &&
      isHash(prior.digest) &&
      isString(prior.windowId) &&
      isTime(prior.analysedAt) &&
      isTime(prior.answeredAt) &&
      isBps(prior.probabilityBps)
    )
  )
    return false;
  if (
    intent !== undefined &&
    !(
      isRecord(intent) &&
      isString(intent.windowId) &&
      (intent.kind === "analysis" || intent.kind === "carry_forward") &&
      isString(intent.noteBytes) &&
      isBps(intent.probabilityBps)
    )
  )
    return false;
  if (
    pendingSnapshots !== undefined &&
    !(
      Array.isArray(pendingSnapshots) &&
      pendingSnapshots.every((s) => isRecord(s) && isHash(s.hash) && isMediaType(s.mediaType) && isString(s.windowId))
    )
  )
    return false;
  return true;
}

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
    (parsed.intents !== undefined && !isRecord(parsed.intents)) ||
    (parsed.watch !== undefined && !(isRecord(parsed.watch) && Object.values(parsed.watch).every(validWatchRecord))) ||
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
