// The forecaster. It analyses a market only when something changed, and otherwise carries its
// earlier forecast forward. In every open forecast window of an OPEN market it
//   1. checks the pages it follows (a cheap conditional read, once per window, no model),
//   2. decides: analyse (no earlier forecast, a source changed or is new, or a heartbeat is due) or
//      carry forward (sign the earlier probability again),
//   3. writes a salted forecast note, uploads it, signs the Forecast struct (spec 5.10) with
//      contentHash = keccak256(note) with its own wallet and submits it, once per window,
//   4. and after the window has closed, uploads the archived bytes of the sources that changed.
// The platform verifies the signature, seals the answer until the window's deadline and scores it;
// it never signs anything and never reads the note.
//
// Crash safety: the exact note bytes are saved (an "intent", with the fingerprints to commit) before
// anything is uploaded, so a restart resends identical bytes, and the record of the last answer
// (`prior`) changes only in the same state save that commits the new fingerprints after a
// successful submit. A snapshot file is flushed to the disk before the state that names it.
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { BlinkApiError, forecastTypedData, noteBelongsTo, parseForecastNote } from "@blink/client";
import { keccak256, type Hex } from "viem";
import type { AgentContext } from "../lib/env.ts";
import type { RoleTick } from "../lib/loop.ts";
import type { MarketView, SourceChange } from "../lib/model.ts";
import { buildNote, newSalt, snapshotRefusal, type NoteItem } from "../lib/note.ts";
import { writeFileDurably, type WatchRecord } from "../lib/state.ts";
import { MAX_URL_BYTES, jsonBytes } from "../lib/fetcher.ts";
import { checkSources, decideUpdate, watchableUrl, type SourceCheck } from "../lib/watch.ts";

/** Window ids already answered (`state.acted`). */
const SUBMITTED = "forecaster.submitted";
/** The API accepts 1..9999; a model that is certain still says so within that range. */
const clampBps = (bps: number) => Math.min(9999, Math.max(1, Math.round(bps)));
/**
 * A refusal after which the window can never take this answer: any 4xx but "try again" (408) and
 * "slow down" (429). A 409 "already submitted" or "window closed" is one; so is a lost role (403).
 */
const isFinalRefusal = (error: unknown): error is BlinkApiError =>
  error instanceof BlinkApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;

/**
 * How many markets one tick may do real work for: a fresh check of the sources or a call of the
 * model. `runAgent` runs one tick at a time, so a tick holds up every other role of the process
 * for its whole length, and a check of 20 URLs that never answer lasts about 40 s (ceil(20 / 5)
 * rounds of 10 s). With 2 markets a tick lasts about 80 s in that worst case, plus the model; the
 * rest wait for the next tick and are taken in turn. A check is kept for its window, so a market
 * whose check is already kept costs nothing here.
 */
export const MAX_MARKETS_WORKED_PER_TICK = 2;
/** The analysis of one window is tried at most this often, at least `RETRY_SPACING_SECONDS` apart. */
export const MAX_ANALYSIS_ATTEMPTS = 3;
export const RETRY_SPACING_SECONDS = 10;
/** A transient failure to upload a snapshot is retried at most once in this time. */
export const SNAPSHOT_RETRY_SECONDS = 60;
/** ... and given up this long after the window's deadline. */
export const SNAPSHOT_GIVE_UP_SECONDS = 86_400;
/** A window that is still open is asked about again no sooner than this (its status is the platform's to say). */
export const WINDOW_RECHECK_SECONDS = 30;
/** A tick uploads at most this many snapshot objects ... */
export const SNAPSHOT_UPLOADS_PER_TICK = 20;
/** ... and this many bytes of them; the rest wait for the next tick. */
export const SNAPSHOT_BYTES_PER_TICK = 8 * 1024 * 1024;
/**
 * An idle market (everything open is answered) is listed again after the platform's next time, but
 * never later than `WINDOW_RECHECK_SECONDS` and never sooner than this: platform times are compared
 * with the local clock only within a short horizon, so a skewed clock costs at most that long.
 */
const IDLE_MIN_SECONDS = 5;
/** At most this many markets that left OPEN are forgotten in a tick (each costs a read of all its windows). */
const PRUNES_PER_TICK = 2;
/** At most this many pages of OPEN markets are read in a tick, and so records are pruned only when the listing was whole. */
const MARKET_PAGES = 10;
const WATCH_LIST_MAX = 20;

const actedOn = (ctx: AgentContext, action: string) => (ctx.state.data.acted[action] ??= []);
const watchOf = (ctx: AgentContext) => (ctx.state.data.watch ??= {});
const ensureRecord = (ctx: AgentContext, marketId: string): WatchRecord => (watchOf(ctx)[marketId] ??= { sources: {} });

type Window = Awaited<ReturnType<AgentContext["client"]["listForecastWindows"]>>["items"][number];
type MarketItem = Awaited<ReturnType<AgentContext["client"]["listMarkets"]>>["items"][number];
type WindowRecord = Awaited<ReturnType<AgentContext["client"]["getForecastWindow"]>>;

/** What is kept in memory for one open window of one market (the retries of later ticks use it). */
type Memo = {
  /** The cheap check, once per window. */
  check?: { items: SourceCheck[]; next: WatchRecord["sources"]; now: number };
  decided: boolean;
  attempts: number;
  lastAttemptAt?: number;
  /** The model's answer: once received it is never asked for again in this window. */
  answer?: { probabilityBps: number; summary: string };
  noView: boolean;
  missed: boolean;
};

/** The API is asking the agent to slow down; the loop backs off, so this is not a market's failure. */
const isBackoff = (error: unknown): error is BlinkApiError =>
  error instanceof BlinkApiError && (error.status === 429 || (error.status === 503 && error.body.code === "INDEX_STALE"));

/**
 * The codes of this agent that an error message may carry into the log. A message that is not on
 * this list is never logged, however much it looks like a code: a secret in a library's message
 * could be all capitals too.
 */
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  "NOTE_INVALID",
  "REVISE_INVALID",
  "WATCH_LIST_INVALID",
  "HASH_MISMATCH",
  "STATE_CORRUPT",
  "NO_API_KEY_ISSUED",
]);

/** A stable code for the log: an API code, a code on the known list, or the error's name. Never a raw message. */
function errorCode(error: unknown): string {
  if (error instanceof BlinkApiError) return error.body.code;
  if (error instanceof Error) {
    if (KNOWN_ERROR_CODES.has(error.message) || /^(INVALID|MISSING)_ENV:[A-Z0-9_]{1,64}$/.test(error.message)) return error.message;
    return /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name) ? error.name : "UNKNOWN";
  }
  return "UNKNOWN";
}

const snapshotPath = (ctx: AgentContext, hash: string) => join(ctx.stateDir, "snapshots", hash);

/** Writes the file and flushes it: the state save that names it comes after, and must never outlive it. */
async function writeSnapshot(ctx: AgentContext, hash: Hex, bytes: Uint8Array) {
  await mkdir(join(ctx.stateDir, "snapshots"), { recursive: true });
  const path = snapshotPath(ctx, hash);
  await writeFileDurably(path + ".tmp", bytes);
  await rename(path + ".tmp", path);
}

const SNAPSHOT_FILE = /^0x[0-9a-fA-F]{64}(\.tmp)?$/;

/**
 * Removes the files in `snapshots/` that no record names: what a crash left between writing a file
 * and saving the state that names it. A file that a record names is never touched; neither is a
 * file that is not named like a snapshot.
 */
async function sweepSnapshots(ctx: AgentContext) {
  let names: string[];
  try {
    names = await readdir(join(ctx.stateDir, "snapshots"));
  } catch {
    return;
  }
  const needed = new Set<string>();
  for (const rec of Object.values(watchOf(ctx))) for (const snap of rec.pendingSnapshots ?? []) needed.add(snap.hash.toLowerCase());
  for (const name of names)
    if (SNAPSHOT_FILE.test(name) && (name.endsWith(".tmp") || !needed.has(name.toLowerCase())))
      await rm(join(ctx.stateDir, "snapshots", name), { force: true });
}

/** Removes the file of each hash that no record is waiting to upload any more. */
async function removeUnneeded(ctx: AgentContext, hashes: Iterable<string>) {
  const needed = new Set<string>();
  for (const rec of Object.values(watchOf(ctx))) for (const snap of rec.pendingSnapshots ?? []) needed.add(snap.hash.toLowerCase());
  for (const hash of new Set(hashes)) if (!needed.has(hash.toLowerCase())) await rm(snapshotPath(ctx, hash), { force: true });
}

/** Forgets the intent of a record with its pending snapshots (and their files); one state save. */
async function dropIntent(ctx: AgentContext, marketId: string, rec: WatchRecord, reason: string) {
  const intent = rec.intent;
  if (!intent) return;
  const dropped = (rec.pendingSnapshots ?? []).filter((s) => s.windowId === intent.windowId);
  const left = (rec.pendingSnapshots ?? []).filter((s) => s.windowId !== intent.windowId);
  delete rec.intent;
  if (left.length > 0) rec.pendingSnapshots = left;
  else delete rec.pendingSnapshots;
  await ctx.state.save();
  await removeUnneeded(ctx, dropped.map((s) => s.hash));
  ctx.log("intent_dropped", { marketId, windowId: intent.windowId, reason });
}

/** Every answer of a window (public after its deadline), page by page. */
async function answersOf(ctx: AgentContext, marketId: string, windowId: string) {
  const items: Awaited<ReturnType<AgentContext["client"]["listForecasts"]>>["items"] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.client.listForecasts({ marketId }, { windowId, limit: 100, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

/**
 * An intent whose window has closed cannot be resubmitted. If the agent's own answer in that window
 * is the intent's (same note), the intent becomes `prior`; the new fingerprints stay uncommitted, so
 * the next window sees the same change again. Otherwise the intent is dropped with its snapshots.
 */
async function settleIntent(ctx: AgentContext, marketId: string, rec: WatchRecord) {
  const intent = rec.intent!;
  const bytes = new TextEncoder().encode(intent.noteBytes);
  const note = parseForecastNote(bytes);
  if (!note.ok) return dropIntent(ctx, marketId, rec, "INTENT_UNREADABLE");
  const contentHash = keccak256(bytes);
  const own = (await answersOf(ctx, marketId, intent.windowId)).find(
    (a) => a.forecaster.toLowerCase() === ctx.account.address.toLowerCase() && a.withdrawnAt === null && a.contentHash === contentHash,
  );
  if (!own) return dropIntent(ctx, marketId, rec, "NOT_ANSWERED");
  rec.prior = {
    digest: own.digest as Hex,
    windowId: intent.windowId,
    analysedAt: intent.kind === "analysis" ? note.note.checkedAt : (rec.prior?.analysedAt ?? note.note.checkedAt),
    answeredAt: own.receivedAt,
    probabilityBps: intent.probabilityBps,
  };
  delete rec.intent;
  const submitted = actedOn(ctx, SUBMITTED);
  if (!submitted.includes(intent.windowId)) submitted.push(intent.windowId);
  await ctx.state.save();
}

type UploadOutcome = "uploaded" | "deferred" | { final: string; status?: number } | { transient: string };

/** What one tick may still upload of snapshots, and what it has already sent (an object is sent once per tick). */
type UploadBudget = { objects: number; bytes: number; outcomes: Map<string, UploadOutcome>; exhausted: boolean };
const newBudget = (): UploadBudget => ({
  objects: SNAPSHOT_UPLOADS_PER_TICK,
  bytes: SNAPSHOT_BYTES_PER_TICK,
  outcomes: new Map(),
  exhausted: false,
});

async function uploadOne(ctx: AgentContext, snap: { hash: Hex; mediaType: string }, budget: UploadBudget): Promise<UploadOutcome> {
  // The same bytes may be waiting for several markets: they are sent once, and every record learns the outcome.
  const earlier = budget.outcomes.get(snap.hash.toLowerCase());
  if (earlier) return earlier;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(snapshotPath(ctx, snap.hash)));
  } catch {
    return { final: "SNAPSHOT_FILE_MISSING" };
  }
  if (keccak256(bytes) !== snap.hash.toLowerCase()) return { final: "HASH_MISMATCH" };
  if (budget.objects <= 0 || bytes.length > budget.bytes) {
    budget.exhausted = true;
    return "deferred";
  }
  budget.objects--;
  budget.bytes -= bytes.length;
  const outcome = await send(ctx, bytes, snap.mediaType);
  budget.outcomes.set(snap.hash.toLowerCase(), outcome);
  return outcome;
}

async function send(ctx: AgentContext, bytes: Uint8Array, mediaType: string): Promise<UploadOutcome> {
  try {
    await ctx.client.uploadContent(bytes, mediaType);
    return "uploaded";
  } catch (error) {
    if (error instanceof BlinkApiError)
      return error.status === 429 || error.status >= 500
        ? { transient: error.body.code }
        : { final: error.body.code, status: error.status };
    // The client checks the answer: a hash that is not the one sent, or an answer of the wrong shape, is final.
    if (error instanceof Error && error.message === "HASH_MISMATCH") return { final: "HASH_MISMATCH" };
    if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) return { final: "MALFORMED_RESPONSE" };
    return { transient: "NETWORK" };
  }
}

/** The watch list of a market: the model's (default the spec's), mapped through `watchableUrl`, without repeats, `spec.sources` first, at most 20. */
async function watchList(ctx: AgentContext, marketId: string, view: MarketView): Promise<string[]> {
  const raw = ctx.model.watchList ? await ctx.model.watchList(view) : view.spec.sources;
  if (!Array.isArray(raw)) throw new Error("WATCH_LIST_INVALID");
  const mapped: string[] = [];
  let invalid = 0;
  let tooLong = 0;
  for (const entry of raw) {
    const url = typeof entry === "string" ? watchableUrl(entry) : null;
    if (url !== null) {
      mapped.push(url);
      continue;
    }
    // An https URL that takes more than 2048 bytes once JSON-encoded is too long. Anything else is
    // not accepted: not https, not parseable, or a form that the note schema refuses (a backslash).
    if (typeof entry === "string" && URL.canParse(entry) && new URL(entry).protocol === "https:" && jsonBytes(new URL(entry).href) > MAX_URL_BYTES) tooLong++;
    else invalid++;
  }
  if (tooLong > 0) ctx.log("watch_url_too_long", { marketId, dropped: tooLong });
  if (invalid > 0) ctx.log("watch_url_invalid", { marketId, dropped: invalid });
  const unique = [...new Set(mapped)];
  const own = new Set(view.spec.sources.flatMap((u) => watchableUrl(u) ?? []));
  const ordered = [...unique.filter((u) => own.has(u)), ...unique.filter((u) => !own.has(u))];
  if (ordered.length > WATCH_LIST_MAX)
    ctx.log("watch_list_truncated", { marketId, kept: WATCH_LIST_MAX, dropped: ordered.length - WATCH_LIST_MAX });
  return ordered.slice(0, WATCH_LIST_MAX);
}

/** Every window of a market (public for any market), page by page. */
async function windowIdsOf(ctx: AgentContext, marketId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.client.listForecastWindows({ marketId }, { limit: 100, ...(cursor ? { cursor } : {}) });
    ids.push(...page.items.map((w) => w.windowId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

export type ForecasterOptions = {
  /** Milliseconds since the epoch; replaced in tests. */
  now?: () => number;
};

type WindowInfo = { status: WindowRecord["status"]; deadline: number; askAfter: number };

/** What is kept in memory for one context (one agent process has one; tests may have several). */
type Local = {
  memos: Map<string, Memo>;
  /** Open unanswered windows seen, key to market id: what has to be accounted for when it closes. */
  seen: Map<string, string>;
  /** The earliest time a snapshot is tried again, by `<windowId>:<hash>`. */
  retryAt: Map<string, number>;
  /** What the platform last said of a window that a snapshot or an intent waits for. A closed window stays closed. */
  windowInfo: Map<string, WindowInfo>;
  /** When a window lookup began to fail, by window id. */
  lookupFailedSince: Map<string, number>;
  /** By market: nothing can be due before `until`; `setAt` is when that was decided (a clock that went back voids it). */
  idle: Map<string, { until: number; setAt: number }>;
  /** The market the next tick starts with, when the last one ran out of budget or was told to slow down. */
  resumeAt?: string;
  /** Markets whose windows could not be read when they were to be forgotten: when (a counter), so that they queue behind the others. */
  pruneFailedAt: Map<string, number>;
  pruneFailures: number;
  /** The market whose snapshots the next tick's uploads start with, when the last one ran out of its allowance. */
  hkResume?: string;
};

type WindowsRead = {
  /** OPEN windows the agent has not answered. */
  open: Window[];
  /** OPEN windows it has. */
  answered: Window[];
  /** The earliest openAt of an UPCOMING window seen. */
  nextOpenAt: number | null;
  /** The read reached the first window that is not closed (so no unseen window comes before what was seen). */
  frontier: boolean;
};

/**
 * The forecaster's tick. The returned function keeps, in memory and per context, what the retries of
 * one window need (its check, the model's answer, the attempts) and where the next tick starts.
 */
export function createForecaster(options: ForecasterOptions = {}): RoleTick {
  const clock = options.now ?? Date.now;
  const nowSeconds = () => Math.floor(clock() / 1000);
  const locals = new WeakMap<AgentContext, Local>();
  const local = (ctx: AgentContext): Local => {
    let found = locals.get(ctx);
    if (!found) {
      found = { memos: new Map(), seen: new Map(), retryAt: new Map(), windowInfo: new Map(), lookupFailedSince: new Map(), idle: new Map(), pruneFailedAt: new Map(), pruneFailures: 0 };
      locals.set(ctx, found);
    }
    return found;
  };

  /**
   * The platform's word on a window (its clock decides, never the local clock), asked again for an
   * open one only after a while: also when the local clock went back since it was asked.
   */
  async function lookup(ctx: AgentContext, windowId: string, windowOf: (id: string) => Promise<WindowRecord>) {
    const L = local(ctx);
    const known = L.windowInfo.get(windowId);
    const now = nowSeconds();
    if (known && (known.status === "CLOSED" || (now < known.askAfter && known.askAfter - now <= WINDOW_RECHECK_SECONDS))) return known;
    const window = await windowOf(windowId);
    const info = { status: window.status, deadline: window.deadline, askAfter: nowSeconds() + WINDOW_RECHECK_SECONDS };
    L.windowInfo.set(windowId, info);
    return info;
  }

  /**
   * `lookup`, except that a window the platform does not know (404), or one that could not be read
   * for a whole give-up period, is `gone`: whatever waited for it is dropped.
   */
  async function windowState(
    ctx: AgentContext,
    windowId: string,
    windowOf: (id: string) => Promise<WindowRecord>,
  ): Promise<WindowInfo | { gone: string }> {
    const L = local(ctx);
    try {
      const info = await lookup(ctx, windowId, windowOf);
      L.lookupFailedSince.delete(windowId);
      return info;
    } catch (error) {
      if (isBackoff(error)) throw error;
      if (error instanceof BlinkApiError && error.status === 404) return { gone: "WINDOW_NOT_FOUND" };
      const now = nowSeconds();
      const first = L.lookupFailedSince.get(windowId) ?? now;
      L.lookupFailedSince.set(windowId, first);
      if (now - first >= SNAPSHOT_GIVE_UP_SECONDS) return { gone: "WINDOW_LOOKUP_FAILED" };
      throw error;
    }
  }

  const keyOf = (marketId: string, windowId: string) => `${marketId}:${windowId}`;

  async function uploadSnapshots(
    ctx: AgentContext,
    marketId: string,
    rec: WatchRecord,
    windowOf: (id: string) => Promise<WindowRecord>,
    budget: UploadBudget,
  ) {
    const L = local(ctx);
    const pending = rec.pendingSnapshots ?? [];
    const done = new Set<(typeof pending)[number]>();
    try {
      for (const snap of pending) {
        const retryKey = `${snap.windowId}:${snap.hash}`;
        const window = await windowState(ctx, snap.windowId, windowOf);
        if ("gone" in window) {
          done.add(snap);
          L.retryAt.delete(retryKey);
          ctx.log("snapshot_upload_failed", { marketId, windowId: snap.windowId, hash: snap.hash, code: window.gone });
          continue;
        }
        if (window.status !== "CLOSED") continue;
        const now = nowSeconds();
        // A snapshot that has failed before is not kept past the give-up time, whether or not a retry is due.
        if (L.retryAt.has(retryKey) && now >= window.deadline + SNAPSHOT_GIVE_UP_SECONDS) {
          done.add(snap);
          L.retryAt.delete(retryKey);
          ctx.log("snapshot_upload_failed", { marketId, windowId: snap.windowId, hash: snap.hash, code: "GAVE_UP" });
          continue;
        }
        // Not due yet; a retry time further ahead than its spacing means the clock went back, and is due.
        const retryTime = L.retryAt.get(retryKey);
        if (retryTime !== undefined && retryTime > now && retryTime - now <= SNAPSHOT_RETRY_SECONDS) continue;
        const outcome = await uploadOne(ctx, snap, budget);
        if (outcome === "deferred") break;
        if (outcome === "uploaded") {
          done.add(snap);
          L.retryAt.delete(retryKey);
        } else if ("final" in outcome) {
          done.add(snap);
          L.retryAt.delete(retryKey);
          ctx.log("snapshot_upload_failed", {
            marketId,
            windowId: snap.windowId,
            hash: snap.hash,
            code: outcome.final,
            ...(outcome.status ? { status: outcome.status } : {}),
          });
        } else if (now >= window.deadline + SNAPSHOT_GIVE_UP_SECONDS) {
          done.add(snap);
          L.retryAt.delete(retryKey);
          ctx.log("snapshot_upload_failed", { marketId, windowId: snap.windowId, hash: snap.hash, code: "GAVE_UP" });
        } else {
          L.retryAt.set(retryKey, now + SNAPSHOT_RETRY_SECONDS);
        }
      }
    } finally {
      if (done.size > 0) {
        const left = pending.filter((s) => !done.has(s));
        if (left.length > 0) rec.pendingSnapshots = left;
        else delete rec.pendingSnapshots;
        await ctx.state.save();
        await removeUnneeded(ctx, [...done].map((s) => s.hash));
      }
    }
  }

  /** What has to be done for a record whatever its market's state: settle a closed intent, upload the snapshots of closed windows. */
  async function housekeeping(
    ctx: AgentContext,
    marketId: string,
    windowOf: (id: string) => Promise<WindowRecord>,
    budget: UploadBudget,
  ) {
    const rec = watchOf(ctx)[marketId];
    if (!rec) return;
    if (rec.intent) {
      const window = await windowState(ctx, rec.intent.windowId, windowOf);
      if ("gone" in window) await dropIntent(ctx, marketId, rec, window.gone);
      else if (window.status === "CLOSED") await settleIntent(ctx, marketId, rec);
    }
    if (rec.pendingSnapshots?.length && !budget.exhausted) await uploadSnapshots(ctx, marketId, rec, windowOf, budget);
  }

  /** The open windows the agent has not answered, reading from the saved cursor, at most two pages. */
  async function readWindows(ctx: AgentContext, marketId: string): Promise<WindowsRead> {
    const submitted = actedOn(ctx, SUBMITTED);
    let cursor = watchOf(ctx)[marketId]?.windowsCursor;
    let moved = false;
    const read: WindowsRead = { open: [], answered: [], nextOpenAt: null, frontier: false };
    let readFrom = cursor;
    const page = async (from: string | undefined) => {
      try {
        return await ctx.client.listForecastWindows({ marketId }, { limit: 100, ...(from ? { cursor: from } : {}) });
      } catch (error) {
        // The server no longer takes the cursor it issued: start again from the first page.
        if (from === undefined || !(error instanceof BlinkApiError && error.status === 400 && error.body.code === "INVALID_CURSOR")) throw error;
        cursor = undefined;
        readFrom = undefined;
        delete ensureRecord(ctx, marketId).windowsCursor;
        moved = true;
        return ctx.client.listForecastWindows({ marketId }, { limit: 100 });
      }
    };
    // A page that holds an UPCOMING window, or is the last, is the frontier. Otherwise the next page
    // is read too (two pages at most): an open window may end a page and its successor start the next.
    // The saved cursor moves only past a page of closed windows.
    let closedSoFar = true;
    for (let count = 0; count < 2; count++) {
      const answer = await page(readFrom);
      let upcoming = false;
      for (const w of answer.items) {
        if (w.status === "OPEN") (submitted.includes(w.windowId) ? read.answered : read.open).push(w);
        else if (w.status === "UPCOMING") {
          upcoming = true;
          read.nextOpenAt = Math.min(read.nextOpenAt ?? Number.POSITIVE_INFINITY, w.openAt);
        }
      }
      if (upcoming || !answer.nextCursor || answer.items.length === 0) {
        read.frontier = true;
        break;
      }
      readFrom = answer.nextCursor;
      closedSoFar = closedSoFar && answer.items.every((w) => w.status === "CLOSED");
      if (closedSoFar) {
        // The server issued this cursor.
        cursor = answer.nextCursor;
        moved = true;
        ensureRecord(ctx, marketId).windowsCursor = cursor;
      }
    }
    if (moved) await ctx.state.save();
    return read;
  }

  /** Accounts for the windows that are no longer open: one that was never answered was missed. */
  function forgetClosed(ctx: AgentContext, marketId: string | null, openKeys: Set<string>, openMarkets?: Set<string>) {
    const L = local(ctx);
    const submitted = actedOn(ctx, SUBMITTED);
    for (const [key, id] of [...L.seen]) {
      if (marketId !== null ? id !== marketId || openKeys.has(key) : openMarkets!.has(id)) continue;
      const windowId = key.slice(id.length + 1);
      const memo = L.memos.get(key);
      if (!submitted.includes(windowId) && !memo?.noView && !memo?.missed)
        ctx.log("window_missed", { marketId: id, windowId, reason: "WINDOW_CLOSED" });
      L.memos.delete(key);
      L.seen.delete(key);
    }
  }

  async function submitIntent(ctx: AgentContext, marketId: string, window: Window, rec: WatchRecord, check: Memo["check"]) {
    const L = local(ctx);
    const intent = rec.intent!;
    const bytes = new TextEncoder().encode(intent.noteBytes);
    const note = parseForecastNote(bytes);
    if (!note.ok) return dropIntent(ctx, marketId, rec, "INTENT_UNREADABLE");
    const { generation, shared } = ctx.deployment;
    // The saved note is signed only for the window it was written for.
    const subject = { marketId, markets: generation.markets, forecaster: ctx.account.address, horizon: window.horizon, scheduledAt: window.scheduledAt };
    if (!noteBelongsTo(note.note, subject)) return dropIntent(ctx, marketId, rec, "INTENT_SUBJECT_MISMATCH");
    const contentHash = keccak256(bytes);
    const submitted = actedOn(ctx, SUBMITTED);
    // A submit may already have reached the platform in an earlier attempt whose answer was lost.
    const wasSent = intent.sent === true;
    let receipt: { digest: string };
    try {
      // The note goes up before the answer, and is salted, so its hash reveals nothing about the sealed answer.
      await ctx.client.uploadContent(bytes, "application/json");
      const message = {
        forecaster: ctx.account.address,
        markets: generation.markets,
        marketId,
        horizon: window.horizon,
        scheduledAt: window.scheduledAt,
        probabilityBps: intent.probabilityBps,
        contentHash,
      };
      const signature = await ctx.walletClient.signTypedData(forecastTypedData({ anchor: shared.anchor, message }));
      if (!wasSent) {
        // Saved before the first submit: from here on the platform may hold this answer.
        intent.sent = true;
        await ctx.state.save();
      }
      receipt = await ctx.client.submitForecast(
        { marketId },
        { horizon: window.horizon, scheduledAt: window.scheduledAt, probabilityBps: intent.probabilityBps, contentHash, signature },
      );
    } catch (error) {
      // A refusal that no retry can change ends the window for this agent: the intent and its snapshots go.
      if (!isFinalRefusal(error)) throw error;
      ctx.log("forecast_refused", { marketId, windowId: window.windowId, code: error.body.code });
      submitted.push(window.windowId);
      L.memos.delete(keyOf(marketId, window.windowId));
      if (wasSent) {
        // The platform may hold this very answer: the intent stays, and settles once the window has closed.
        await ctx.state.save();
        return;
      }
      return dropIntent(ctx, marketId, rec, error.body.code);
    }
    ctx.log("forecast_submitted", {
      marketId,
      windowId: window.windowId,
      kind: intent.kind,
      probabilityBps: intent.probabilityBps,
      digest: receipt.digest,
      contentHash,
    });
    // One save: the fingerprints the note was based on, the record of this answer and the window.
    const next = intent.next ?? check?.next;
    if (next) rec.sources = next;
    rec.prior = {
      digest: receipt.digest as Hex,
      windowId: window.windowId,
      analysedAt: intent.kind === "analysis" ? note.note.checkedAt : (rec.prior?.analysedAt ?? note.note.checkedAt),
      answeredAt: nowSeconds(),
      probabilityBps: intent.probabilityBps,
    };
    delete rec.intent;
    submitted.push(window.windowId);
    L.memos.delete(keyOf(marketId, window.windowId));
    await ctx.state.save();
  }

  /** The note items of a check, with the snapshots that may be archived; logs what is skipped. */
  function noteItems(ctx: AgentContext, marketId: string, windowId: string, check: NonNullable<Memo["check"]>) {
    const items: NoteItem[] = [];
    const snapshots: { hash: Hex; mediaType: string; bytes: Uint8Array }[] = [];
    for (const item of check.items) {
      let snapshot: Hex | null = null;
      if (item.status === "CHANGED" && item.raw) {
        const mediaType = item.mediaType ?? "application/octet-stream";
        const refusal = snapshotRefusal(mediaType, item.raw.length);
        if (refusal) ctx.log("snapshot_skipped", { marketId, windowId, reason: refusal, mediaType, size: item.raw.length });
        else {
          snapshot = keccak256(item.raw);
          snapshots.push({ hash: snapshot, mediaType, bytes: item.raw });
        }
      }
      items.push({
        url: item.url,
        status: item.status,
        since: item.since,
        observedAt: item.observedAt,
        fingerprint: item.fingerprint,
        snapshot,
        note: item.status === "UNREACHABLE" ? (item.code ?? "") : "",
      });
    }
    return { items, snapshots };
  }

  /** Whether a retry spaced `RETRY_SPACING_SECONDS` from `last` is not yet due; a `last` that lies further ahead than that means the clock went back. */
  const tooSoon = (now: number, last: number) => now - last > -RETRY_SPACING_SECONDS && now - last < RETRY_SPACING_SECONDS;

  /** Answers one open window of a market. Returns "blocked" when the work needs budget the tick no longer has. */
  async function answerWindow(
    ctx: AgentContext,
    item: MarketItem,
    window: Window,
    spend: () => boolean,
  ): Promise<"done" | "blocked"> {
    const L = local(ctx);
    const marketId = item.market.marketId;
    const rec = ensureRecord(ctx, marketId);
    const key = keyOf(marketId, window.windowId);
    let memo = L.memos.get(key);
    // One intent is saved per market: another window's is resumed or settled first, never overwritten.
    if (rec.intent && rec.intent.windowId !== window.windowId) return "done";
    // Resending a saved answer is work too, and counts against the tick's budget like a fresh check.
    if (rec.intent && !spend()) return "blocked";
    if (!rec.intent) {
      if (memo?.missed || memo?.noView) return "done";
      if (!item.spec.ok) return "done";
      const view: MarketView = { marketId: BigInt(marketId), specHash: item.market.specHash as Hex, spec: item.spec.spec };
      if (!memo) L.memos.set(key, (memo = { decided: false, attempts: 0, noView: false, missed: false }));
      const now = nowSeconds();
      if (!memo.check) {
        if (!spend()) return "blocked";
        const urls = await watchList(ctx, marketId, view);
        const { items, next } = await checkSources(ctx.fetcher, rec, urls, now);
        memo.check = { items, next, now };
      }
      const check = memo.check;
      const decision = decideUpdate({ prior: rec.prior, items: check.items, now, heartbeatSeconds: ctx.heartbeatSeconds });
      if (!memo.decided) {
        memo.decided = true;
        ctx.log("forecast_decision", {
          marketId,
          windowId: window.windowId,
          action: decision.action,
          reason: decision.action === "analyse" ? decision.reason : "no_change",
          checked: check.items.length,
          changed: check.items.filter((i) => i.status === "CHANGED").length,
          unreachable: check.items.filter((i) => i.status === "UNREACHABLE").length,
        });
      }
      let kind: "analysis" | "carry_forward";
      let probabilityBps: number;
      let summary = "";
      if (decision.action === "carry_forward") {
        kind = "carry_forward";
        probabilityBps = rec.prior!.probabilityBps;
      } else {
        kind = "analysis";
        if (!memo.answer) {
          // The clock is read again: the check above may have taken a long time.
          if (memo.lastAttemptAt !== undefined && tooSoon(nowSeconds(), memo.lastAttemptAt)) return "done";
          if (!spend()) return "blocked";
          memo.attempts++;
          memo.lastAttemptAt = nowSeconds();
          const changes: SourceChange[] = check.items.flatMap((i) =>
            (i.status === "NEW" || i.status === "CHANGED") && i.raw
              ? [{ url: i.url, status: i.status, since: i.since, observedAt: i.observedAt, mediaType: i.mediaType ?? "application/octet-stream", bytes: i.raw }]
              : [],
          );
          let result: { probabilityBps: number; summary: string } | null;
          try {
            const prior = rec.prior ? { probabilityBps: rec.prior.probabilityBps, analysedAt: rec.prior.analysedAt } : null;
            if (ctx.model.revise) result = await ctx.model.revise(view, { prior, changes });
            else {
              const bps = await ctx.model.probabilityBps(view);
              result = bps === null ? null : { probabilityBps: bps, summary: "" };
            }
            if (result !== null && !Number.isFinite(result.probabilityBps)) throw new Error("REVISE_INVALID");
          } catch (error) {
            // The spacing counts from the end of a failed attempt, which may have been slow.
            memo.lastAttemptAt = nowSeconds();
            ctx.log("analysis_failed", { marketId, windowId: window.windowId, attempt: memo.attempts, code: errorCode(error) });
            if (memo.attempts >= MAX_ANALYSIS_ATTEMPTS) {
              memo.missed = true;
              for (const i of check.items) delete i.raw;
              ctx.log("window_missed", { marketId, windowId: window.windowId, reason: "ATTEMPTS_EXHAUSTED" });
            }
            return "done";
          }
          if (result === null) {
            // Nothing is submitted and the new fingerprints are not committed: the change is seen again next window.
            memo.noView = true;
            for (const i of check.items) delete i.raw;
            ctx.log("no_view", { marketId, windowId: window.windowId });
            return "done";
          }
          memo.answer = { probabilityBps: clampBps(result.probabilityBps), summary: typeof result.summary === "string" ? result.summary : "" };
        }
        probabilityBps = memo.answer.probabilityBps;
        summary = memo.answer.summary;
      }
      // The note, its snapshot files and the intent, saved before anything is uploaded.
      const { items, snapshots } = noteItems(ctx, marketId, window.windowId, check);
      const bytes = buildNote({
        kind,
        subject: {
          marketId,
          markets: ctx.deployment.generation.markets,
          forecaster: ctx.account.address,
          horizon: window.horizon,
          scheduledAt: window.scheduledAt,
        },
        salt: newSalt(),
        checkedAt: check.now,
        priorDigest: rec.prior?.digest ?? null,
        summary,
        items,
      });
      for (const snap of snapshots) await writeSnapshot(ctx, snap.hash, snap.bytes);
      const queued = rec.pendingSnapshots ?? [];
      for (const snap of snapshots)
        if (!queued.some((q) => q.hash === snap.hash && q.windowId === window.windowId))
          queued.push({ hash: snap.hash, mediaType: snap.mediaType, windowId: window.windowId });
      if (queued.length > 0) rec.pendingSnapshots = queued;
      rec.intent = { windowId: window.windowId, kind, noteBytes: new TextDecoder().decode(bytes), probabilityBps, next: check.next };
      await ctx.state.save();
      // The page bytes are no longer needed in memory: they are in the snapshot files.
      for (const i of check.items) delete i.raw;
    }
    await submitIntent(ctx, marketId, window, rec, memo?.check);
    return "done";
  }

  async function market(ctx: AgentContext, item: MarketItem, spend: () => boolean): Promise<"done" | "blocked"> {
    const L = local(ctx);
    const marketId = item.market.marketId;
    // Nothing is due before `until` (and a clock that went back since voids that).
    const idle = L.idle.get(marketId);
    const start = nowSeconds();
    if (idle && start >= idle.setAt && start < idle.until) return "done";
    const read = await readWindows(ctx, marketId);
    const { open } = read;
    const openKeys = new Set(open.concat(read.answered).map((w) => keyOf(marketId, w.windowId)));
    forgetClosed(ctx, marketId, openKeys);
    for (const w of open) L.seen.set(keyOf(marketId, w.windowId), marketId);
    for (const window of open) if ((await answerWindow(ctx, item, window, spend)) === "blocked") return "blocked";
    // When every open window is answered, given up or without a view, nothing can be due before the
    // next window opens or the open ones end: the next ticks do not list this market's windows until then.
    const submitted = actedOn(ctx, SUBMITTED);
    const over = (w: Window) => submitted.includes(w.windowId) || !!L.memos.get(keyOf(marketId, w.windowId))?.noView || !!L.memos.get(keyOf(marketId, w.windowId))?.missed;
    if (read.frontier && open.every(over)) {
      const times = [...read.answered, ...open].map((w) => w.deadline);
      if (read.nextOpenAt !== null) times.push(read.nextOpenAt);
      const now = nowSeconds();
      const platformTime = times.length > 0 ? Math.min(...times) : Number.POSITIVE_INFINITY;
      const until = Math.max(now + IDLE_MIN_SECONDS, Math.min(now + WINDOW_RECHECK_SECONDS, platformTime));
      L.idle.set(marketId, { until, setAt: now });
    } else L.idle.delete(marketId);
    return "done";
  }

  return async (ctx) => {
    const L = local(ctx);
    // The OPEN markets, page by page; the listing is whole only if the last page said so.
    const items: MarketItem[] = [];
    let after: string | undefined;
    let complete = false;
    for (let page = 0; page < MARKET_PAGES; page++) {
      const answer = await ctx.client.listMarkets({ state: "OPEN", limit: 100, ...(after ? { after } : {}) });
      items.push(...answer.items);
      if (answer.next === null) {
        complete = true;
        break;
      }
      after = answer.next;
    }
    const guarded = async <T>(marketId: string, work: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await work();
      } catch (error) {
        // A rate limit is for the loop to wait out; any other failure is this market's alone.
        if (isBackoff(error)) throw error;
        ctx.log("forecaster_market_error", { marketId, code: errorCode(error) });
        return undefined;
      }
    };
    const windows = new Map<string, Promise<WindowRecord>>();
    const windowOf = (windowId: string) => {
      let found = windows.get(windowId);
      if (!found) windows.set(windowId, (found = ctx.client.getForecastWindow({ windowId })));
      return found;
    };
    await sweepSnapshots(ctx);
    // Intents and snapshots of every record, from where the last tick's upload allowance ran out.
    const budget = newBudget();
    let records = Object.keys(watchOf(ctx));
    const first = L.hkResume === undefined ? -1 : records.indexOf(L.hkResume);
    if (first > 0) records = [...records.slice(first), ...records.slice(0, first)];
    delete L.hkResume;
    for (const marketId of records) {
      const wasExhausted = budget.exhausted;
      try {
        await guarded(marketId, () => housekeeping(ctx, marketId, windowOf, budget));
      } catch (error) {
        L.hkResume = marketId;
        throw error;
      }
      if (budget.exhausted && !wasExhausted) L.hkResume = marketId;
    }

    let order = items;
    const start = items.findIndex((i) => i.market.marketId === L.resumeAt);
    if (start > 0) order = [...items.slice(start), ...items.slice(0, start)];
    delete L.resumeAt;
    let workBudget = MAX_MARKETS_WORKED_PER_TICK;
    for (const item of order) {
      if (!item.spec.ok) continue;
      let counted = false;
      const spend = () => {
        if (counted) return true;
        if (workBudget <= 0) return false;
        workBudget--;
        counted = true;
        return true;
      };
      let result: "done" | "blocked" | undefined;
      try {
        result = await guarded(item.market.marketId, () => market(ctx, item, spend));
      } catch (error) {
        // Told to slow down: the next tick, after the loop's wait, starts with this market.
        L.resumeAt = item.market.marketId;
        throw error;
      }
      if (result === "blocked") {
        // The next tick starts here, so every market gets its turn.
        L.resumeAt = item.market.marketId;
        break;
      }
    }

    // Forget what is no longer waited for.
    const waited = new Set<string>();
    for (const rec of Object.values(watchOf(ctx))) {
      if (rec.intent) waited.add(rec.intent.windowId);
      for (const snap of rec.pendingSnapshots ?? []) waited.add(snap.windowId);
    }
    for (const id of [...L.windowInfo.keys()]) if (!waited.has(id)) L.windowInfo.delete(id);
    for (const id of [...L.lookupFailedSince.keys()]) if (!waited.has(id)) L.lookupFailedSince.delete(id);
    for (const key of [...L.retryAt.keys()]) if (!waited.has(key.slice(0, key.indexOf(":")))) L.retryAt.delete(key);

    if (complete) {
      const openIds = new Set(items.map((i) => i.market.marketId));
      forgetClosed(ctx, null, new Set(), openIds);
      for (const id of [...L.idle.keys()]) if (!openIds.has(id)) L.idle.delete(id);
      // A market that left OPEN, with nothing pending, is forgotten with the ids of its windows (they are read once, a few markets a tick).
      let changed = false;
      let tried = 0;
      // A market whose windows could not be read goes to the back, so that failing ones never starve the rest.
      const candidates = Object.entries(watchOf(ctx))
        .filter(([id, rec]) => !openIds.has(id) && !rec.intent && !rec.pendingSnapshots?.length)
        .sort(([a], [b]) => (L.pruneFailedAt.get(a) ?? 0) - (L.pruneFailedAt.get(b) ?? 0));
      try {
        for (const [id] of candidates) {
          if (tried++ >= PRUNES_PER_TICK) break;
          let ids: string[] = [];
          try {
            ids = await windowIdsOf(ctx, id);
          } catch (error) {
            if (isBackoff(error)) throw error;
            // A market the platform no longer knows has nothing to read; any other failure is tried again next tick.
            if (!(error instanceof BlinkApiError && error.status === 404)) {
              L.pruneFailedAt.set(id, ++L.pruneFailures);
              ctx.log("forecaster_market_error", { marketId: id, code: errorCode(error) });
              continue;
            }
          }
          const gone = new Set(ids);
          const submitted = actedOn(ctx, SUBMITTED);
          const kept = submitted.filter((w) => !gone.has(w));
          submitted.splice(0, submitted.length, ...kept);
          delete watchOf(ctx)[id];
          L.pruneFailedAt.delete(id);
          changed = true;
        }
      } finally {
        if (changed) await ctx.state.save();
      }
    }
  };
}

export const forecaster: RoleTick = createForecaster();
