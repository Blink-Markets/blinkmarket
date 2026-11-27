import { keccak256 } from "viem";
import {
  NO_CONTENT_HASH,
  computeFreshness,
  noteBelongsTo,
  parseForecastNote,
  summarizeWindow,
  type ForecastNote,
  type FreshnessView,
  type WindowAnswer,
  type WindowSummary,
} from "@blink/schemas";

// The reader that turns a market's public routes into its freshness summary. It reads the closed
// windows, the signed answers of each, and the forecast note that each answer's contentHash names,
// and hands them to the shared reducers of @blink/schemas. What a note says is the forecaster's
// claim: the reader checks only that the note is about the answer it was found behind.

type Page<T> = { items: T[]; nextCursor: string | null };
type PageQuery = { limit?: number; cursor?: string };

/** The parts of the client that the reader calls; `createBlinkClient(...)` satisfies it. */
export type FreshnessClient = {
  getDeployment(): Promise<{ deployment: { generation: { markets: string } } }>;
  listForecastWindows(
    ref: { marketId: string },
    page?: PageQuery,
  ): Promise<
    Page<{
      windowId: string;
      horizon: number;
      scheduledAt: number;
      openAt: number;
      status: "UPCOMING" | "OPEN" | "CLOSED";
    }>
  >;
  getConsensus(
    ref: { marketId: string },
    page?: PageQuery,
  ): Promise<Page<{ windowId: string; submissions: number }>>;
  listForecasts(
    ref: { marketId: string },
    query: PageQuery & { windowId: string },
  ): Promise<
    Page<{
      forecaster: string;
      contentHash: string;
      receivedAt: number;
      withdrawnAt: number | null;
    }>
  >;
  /**
   * The bytes whose keccak256 is the hash. Content that is not stored is an error with `status`
   * 404 (a `BlinkApiError`), and bytes that do not match the hash are `Error("HASH_MISMATCH")`:
   * both mean the answer has no readable note. Any other error is not about the note and is thrown
   * by the reader.
   */
  getContent(hash: string): Promise<Uint8Array>;
};

export type MarketFreshnessOptions = {
  /** The time the summary is for, in unix seconds. Default: the local clock. */
  asOf?: number;
  /** How many of the latest closed windows to read (default 30). */
  windows?: number;
  /** How many notes to fetch for one window (default 20); the other answers count as unfetched. */
  notesPerWindow?: number;
  /**
   * Note bytes by hash. A note never changes, so bytes that were fetched once are kept here and not
   * fetched again. Only bytes that the client has checked against their hash are stored.
   */
  cache?: Map<string, Uint8Array>;
};

export const DEFAULT_FRESHNESS_WINDOWS = 30;
export const DEFAULT_NOTES_PER_WINDOW = 20;
const PAGE_LIMIT = 100;
/** Notes fetched at the same time within one window. */
const NOTE_CONCURRENCY = 8;

/** Reads every page of a list until `stop` accepts an item or the list ends. */
async function readPages<T>(
  read: (page: PageQuery) => Promise<Page<T>>,
  stop: (item: T) => boolean = () => false,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await read(
      cursor === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor },
    );
    for (const item of page.items) {
      if (stop(item)) return items;
      items.push(item);
    }
    if (page.nextCursor === null) return items;
    // A cursor that does not move would read the same page for ever.
    if (page.nextCursor === cursor) throw new Error("CURSOR_NOT_ADVANCING");
    cursor = page.nextCursor;
  }
}

/** A note that is not there: a 404 from the store, or bytes that fail the hash check. */
const isMissing = (error: unknown) =>
  (error instanceof Error && error.message === "HASH_MISMATCH") ||
  (typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404);

function positiveInteger(name: string, value: number, min: number) {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`INVALID_${name}`);
}

/**
 * How fresh a market's forecasts are, and which sources its forecasters reported as changed.
 *
 * Only closed windows count (an open window is sealed), and the latest `windows` of them are read.
 * Windows that share a scheduledAt (a daily and a pre-close window on the same deadline) are one
 * window here. The result is computeFreshness over those windows, plus the windows themselves,
 * oldest first. A bad note never makes it throw: one that is missing (404), fails its hash check, is
 * not valid or is about another window, market, deployment or forecaster counts as an answer
 * without a note. A failing window, consensus, answer or content route is not hidden: it throws.
 */
export async function getMarketFreshness(
  client: FreshnessClient,
  marketId: string,
  options: MarketFreshnessOptions = {},
): Promise<FreshnessView & { windows: WindowSummary[] }> {
  const keep = options.windows ?? DEFAULT_FRESHNESS_WINDOWS;
  const notesPerWindow = options.notesPerWindow ?? DEFAULT_NOTES_PER_WINDOW;
  positiveInteger("WINDOWS", keep, 1);
  positiveInteger("NOTES_PER_WINDOW", notesPerWindow, 0);
  if (options.asOf !== undefined) positiveInteger("AS_OF", options.asOf, 0);
  const asOf = options.asOf ?? Math.floor(Date.now() / 1000);
  const ref = { marketId };

  const markets = (await client.getDeployment()).deployment.generation.markets;
  // Windows come in (scheduledAt, horizon) order, so the closed ones are a prefix of the list.
  const closed = await readPages(
    (page) => client.listForecastWindows(ref, page),
    (window) => window.status !== "CLOSED",
  );
  // The consensus lists each closed window with its number of counted answers, so a window without
  // any is not asked for its answers.
  const submissions = new Map(
    (await readPages((page) => client.getConsensus(ref, page))).map((c) => [
      c.windowId,
      c.submissions,
    ]),
  );

  const byTime = new Map<number, typeof closed>();
  for (const window of closed)
    byTime.set(window.scheduledAt, [...(byTime.get(window.scheduledAt) ?? []), window]);
  const latest = [...byTime.entries()].sort((a, b) => a[0] - b[0]).slice(-keep);

  const readNote = async (
    contentHash: string,
    subject: Parameters<typeof noteBelongsTo>[1],
  ): Promise<ForecastNote | null> => {
    const key = contentHash.toLowerCase();
    let bytes = options.cache?.get(key);
    // Bytes from the cache or from a custom client are used only if they hash to the key.
    if (bytes !== undefined && keccak256(bytes) !== key) return null;
    if (bytes === undefined) {
      try {
        bytes = await client.getContent(contentHash);
      } catch (error) {
        // Only a note that is missing is an answer without a note; any other failure (a 429, a 5xx,
        // a network error) says nothing about the note, so it is thrown and a retry resumes from
        // the cache.
        if (isMissing(error)) return null;
        throw error;
      }
      if (keccak256(bytes) !== key) return null;
      options.cache?.set(key, bytes);
    }
    const parsed = parseForecastNote(bytes);
    return parsed.ok && noteBelongsTo(parsed.note, subject) ? parsed.note : null;
  };

  const summaries: WindowSummary[] = [];
  for (const [scheduledAt, windows] of latest) {
    type Pending = {
      forecaster: string;
      contentHash: string;
      receivedAt: number;
      horizon: number;
    };
    const answers: Pending[] = [];
    for (const window of windows) {
      if (submissions.get(window.windowId) === 0) continue;
      const rows = await readPages((page) =>
        client.listForecasts(ref, { ...page, windowId: window.windowId }),
      );
      for (const row of rows)
        if (row.withdrawnAt === null) answers.push({ ...row, horizon: window.horizon });
    }
    // The first notesPerWindow answers with a content hash are fetched; the rest are not.
    let fetchable = 0;
    const plan = answers.map((a) =>
      a.contentHash.toLowerCase() === NO_CONTENT_HASH
        ? ("none" as const)
        : fetchable++ < notesPerWindow
          ? ("fetch" as const)
          : ("unfetched" as const),
    );
    const results: WindowAnswer[] = answers.map((a, i) => ({
      note: null,
      noteState: plan[i] === "unfetched" ? "unfetched" : "none",
      receivedAt: a.receivedAt,
    }));
    const toFetch = answers.flatMap((_, i) => (plan[i] === "fetch" ? [i] : []));
    for (let start = 0; start < toFetch.length; start += NOTE_CONCURRENCY)
      await Promise.all(
        toFetch.slice(start, start + NOTE_CONCURRENCY).map(async (i) => {
          const a = answers[i]!;
          const note = await readNote(a.contentHash, {
            marketId,
            markets,
            forecaster: a.forecaster,
            horizon: a.horizon,
            scheduledAt,
          });
          if (note !== null) results[i] = { note, noteState: "read", receivedAt: a.receivedAt };
        }),
      );
    summaries.push(
      summarizeWindow(results, {
        scheduledAt,
        openAt: Math.min(...windows.map((w) => w.openAt)),
      }),
    );
  }
  return { ...computeFreshness(summaries, asOf), windows: summaries };
}
