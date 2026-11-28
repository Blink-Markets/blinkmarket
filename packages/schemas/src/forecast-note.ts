import { z } from "zod";
import { Address, Hash, Uint256 } from "./core.ts";
import { ForecastHorizon } from "./research.ts";

// The forecast note: the JSON document that a signed forecast's contentHash names. It records what
// the forecaster checked for the window and which sources changed. The signed Forecast type does not
// change; the note only gives contentHash a format. The platform never reads or checks a note: it is
// the forecaster's claim, and a reader parses it and checks it against the answer it belongs to.

export const FORECAST_NOTE_SCHEMA = "blink.forecast-note/0.1";
/** The largest note: 64 KiB. */
export const FORECAST_NOTE_MAX_BYTES = 65_536;
/** The most evidence items in a note. */
export const FORECAST_NOTE_MAX_EVIDENCE = 20;
/** The longest evidence url, in characters (code points). */
export const FORECAST_NOTE_MAX_URL_CHARS = 2048;
/** The longest evidence item note, in characters (code points). */
export const FORECAST_NOTE_MAX_ITEM_NOTE_CHARS = 500;
/** The longest summary, in characters (code points). */
export const FORECAST_NOTE_MAX_SUMMARY_CHARS = 2000;
/** An observation may predate its window's openAt by one day: the check before a daily window. */
const LOOKBACK_SECONDS = 86_400;

/** The longest path or message in an INVALID_NOTE reason. */
const REASON_PART_CHARS = 200;

const UnixSeconds = z.number().int().min(0);
const Count = z.number().int().min(0);
/** Counted in code points, so a writer that counts UTF-16 units never exceeds a limit. */
const codePoints = (value: string) => {
  let count = 0;
  for (const _ of value) count++;
  return count;
};
const text = (max: number) =>
  z.string().refine((v) => codePoints(v) <= max, `At most ${max} characters`);
/**
 * An https URL written out in full. The URL parser silently drops spaces, tabs, newlines and other
 * control characters, and reads a backslash as a slash, so a URL that contains one could read as
 * one address and resolve to another. Whatever stores or keys a URL that may end up in a note uses
 * this same predicate, so that a note can always be written for it.
 */
export const isHttpsUrl = (value: string) => {
  // Lower-case "https://" with a host straight after it. The parser accepts "https:///a" and
  // "HTTPS://a" and reads them as host "a", and it treats a backslash as a slash.
  if (!/^https:\/\/[^/\\?#\s]/.test(value) || /[\x00-\x20\x7f\\]/.test(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

export const ForecastNoteItem = z
  .strictObject({
    url: text(FORECAST_NOTE_MAX_URL_CHARS).refine(isHttpsUrl, "Must be an https URL"),
    /** NEW: first checked by this forecaster; a NEW source is never a change. */
    status: z.enum(["NEW", "CHANGED", "UNCHANGED", "UNREACHABLE"]),
    /** A CHANGED source changed between since (the previous successful check) and observedAt. */
    since: UnixSeconds.nullable(),
    observedAt: UnixSeconds,
    /**
     * keccak256 of the source's normalised text, or null for an UNREACHABLE source that was never
     * fetched: there is no text to fingerprint.
     */
    fingerprint: Hash.nullable(),
    /** keccak256 of the raw bytes archived in /v1/content, or null when none were kept. */
    snapshot: Hash.nullable(),
    note: text(FORECAST_NOTE_MAX_ITEM_NOTE_CHARS),
  })
  .superRefine((item, ctx) => {
    if (item.fingerprint === null && item.status !== "UNREACHABLE")
      ctx.addIssue({
        code: "custom",
        path: ["fingerprint"],
        message: "Only an UNREACHABLE item may have no fingerprint",
      });
    if (item.status === "NEW" && item.since !== null)
      ctx.addIssue({ code: "custom", path: ["since"], message: "A NEW item has no since" });
    if (item.status === "CHANGED" && (item.since === null || item.since > item.observedAt))
      ctx.addIssue({
        code: "custom",
        path: ["since"],
        message: "A CHANGED item needs a since that is not after observedAt",
      });
  });
export type ForecastNoteItem = z.infer<typeof ForecastNoteItem>;

export const ForecastNote = z
  .strictObject({
    schema: z.literal(FORECAST_NOTE_SCHEMA),
    /** analysis: the model ran in this window. carry_forward: the earlier probability, signed again. */
    kind: z.enum(["analysis", "carry_forward"]),
    // The fields of the signed Forecast that identify the answer; see noteBelongsTo.
    marketId: Uint256,
    markets: Address,
    forecaster: Address,
    horizon: ForecastHorizon,
    scheduledAt: UnixSeconds,
    /**
     * 32 random bytes, new for every note. Without it a carry-forward note could be guessed from the
     * previous one, and a public lookup of its hash would reveal a sealed answer before the deadline.
     */
    salt: Hash,
    checkedAt: UnixSeconds,
    /**
     * The digest of this forecaster's previous answer on this market. Null only on a cold start,
     * which is an analysis: a carry_forward note signs that earlier probability again, so it names it.
     */
    prior: z.strictObject({ digest: Hash }).nullable(),
    summary: text(FORECAST_NOTE_MAX_SUMMARY_CHARS),
    evidence: z.array(ForecastNoteItem).max(FORECAST_NOTE_MAX_EVIDENCE),
    /** A longer document in /v1/content, or null. */
    detail: Hash.nullable(),
  })
  .superRefine((note, ctx) => {
    if (note.kind !== "carry_forward") return;
    if (note.prior === null)
      ctx.addIssue({
        code: "custom",
        path: ["prior"],
        message: "A carry_forward note names the answer it signs again",
      });
    note.evidence.forEach((item, i) => {
      if (item.status === "NEW" || item.status === "CHANGED")
        ctx.addIssue({
          code: "custom",
          path: ["evidence", i, "status"],
          message: "A carry_forward note lists only UNCHANGED or UNREACHABLE items",
        });
    });
  });
export type ForecastNote = z.infer<typeof ForecastNote>;

export type ParsedForecastNote =
  | { ok: true; note: ForecastNote }
  | { ok: false; reason: string };

/**
 * Parses note bytes. The contentHash is keccak256 of exactly these bytes, so nothing here ever
 * serializes the note again. A note that parses still has to pass noteBelongsTo for its answer.
 */
export function parseForecastNote(bytes: Uint8Array): ParsedForecastNote {
  if (bytes.length > FORECAST_NOTE_MAX_BYTES) return { ok: false, reason: "TOO_LARGE" };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { ok: false, reason: "BOM" };
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "INVALID_UTF8" };
  }
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return { ok: false, reason: "INVALID_JSON" };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json))
    return { ok: false, reason: "NOT_AN_OBJECT" };
  const parsed = ForecastNote.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    // The message and the path can carry a key that the sender chose, so each is capped.
    const path = issue.path.join(".").slice(0, REASON_PART_CHARS) || "(root)";
    return { ok: false, reason: `INVALID_NOTE: ${path}: ${issue.message.slice(0, REASON_PART_CHARS)}` };
  }
  return { ok: true, note: parsed.data };
}

/** What identifies an answer: the fields of its signed Forecast, in the forms a ForecastMessage uses. */
export type NoteSubject = {
  marketId: string | bigint;
  markets: string;
  forecaster: string;
  horizon: number;
  scheduledAt: number | bigint;
};

/**
 * Whether a note is about this answer: the market, the deployment's BlinkMarkets, the forecaster,
 * the horizon and the window time all match (addresses in any case). A reader treats a note that
 * fails this as unreadable, so a note cannot be reused for another window, market or signer.
 */
export function noteBelongsTo(note: ForecastNote, subject: NoteSubject): boolean {
  const marketId =
    typeof subject.marketId === "bigint" ? subject.marketId.toString() : subject.marketId;
  const scheduledAt =
    typeof subject.scheduledAt === "bigint"
      ? Number.isSafeInteger(note.scheduledAt) &&
        subject.scheduledAt === BigInt(note.scheduledAt)
      : subject.scheduledAt === note.scheduledAt;
  return (
    note.marketId === marketId &&
    note.markets.toLowerCase() === subject.markets.toLowerCase() &&
    note.forecaster.toLowerCase() === subject.forecaster.toLowerCase() &&
    note.horizon === subject.horizon &&
    scheduledAt
  );
}

/** One answer of a closed window, with what the reader found behind its contentHash. */
export type WindowAnswer = {
  note: ForecastNote | null;
  /**
   * read: a note that parses and belongs to this answer. none: no readable note (NO_CONTENT_HASH,
   * a 404, a hash mismatch, an invalid note or a note about another subject). unfetched: not fetched
   * because the reader's limit of notes per window was reached.
   */
  noteState: "read" | "none" | "unfetched";
  /** When the platform received the answer, by its own clock (unix seconds). */
  receivedAt: number;
};

/** A source that the window's analysis notes report as CHANGED, merged across answers by url. */
export const EvidenceChange = z.strictObject({
  url: z.string(),
  /** The earliest since among the reports. */
  since: UnixSeconds,
  /** The latest observedAt among the reports. */
  observedAt: UnixSeconds,
  /** How many answers reported the change. */
  witnesses: z.number().int().min(1),
});
export type EvidenceChange = z.infer<typeof EvidenceChange>;

const AnswerCounts = {
  answers: Count,
  /** Answers whose note says the model ran in the window. */
  analysed: Count,
  /** Answers whose note says the earlier probability was signed again. */
  carried: Count,
  /** Answers without a readable note. */
  noNote: Count,
  /** Answers whose note the reader did not fetch. */
  unfetched: Count,
};
export const WindowSummary = z.strictObject({
  scheduledAt: UnixSeconds,
  ...AnswerCounts,
  /** Newest first. */
  evidence: z.array(EvidenceChange),
  /** Sources checked for the first time (NEW): never counted as a change. */
  firstChecked: Count,
});
export type WindowSummary = z.infer<typeof WindowSummary>;

/**
 * Reduces one closed window's answers. Only the evidence of readable analysis notes counts, and an
 * item counts only if its observedAt lies between the window's openAt minus one day and the answer's
 * receivedAt (the platform's clock) and its since is not after its observedAt. Outside that range
 * the answer still counts as analysed or carried; only the item is ignored.
 */
export function summarizeWindow(
  answers: readonly WindowAnswer[],
  window: { scheduledAt: number; openAt: number },
): WindowSummary {
  const earliest = window.openAt - LOOKBACK_SECONDS;
  let analysed = 0;
  let carried = 0;
  let noNote = 0;
  let unfetched = 0;
  const changes = new Map<string, EvidenceChange>();
  const firstChecked = new Set<string>();
  for (const answer of answers) {
    if (answer.noteState === "unfetched") {
      unfetched++;
      continue;
    }
    const note = answer.noteState === "read" ? answer.note : null;
    if (note === null) {
      noNote++;
      continue;
    }
    if (note.kind === "carry_forward") {
      carried++;
      continue;
    }
    analysed++;
    // An answer is one witness of a change, however often its note lists the source.
    const witnessed = new Set<string>();
    for (const item of note.evidence) {
      if (item.observedAt < earliest || item.observedAt > answer.receivedAt) continue;
      if (item.since !== null && item.since > item.observedAt) continue;
      if (item.status === "NEW") firstChecked.add(item.url);
      if (item.status !== "CHANGED" || item.since === null) continue;
      const known = changes.get(item.url);
      if (known === undefined)
        changes.set(item.url, {
          url: item.url,
          since: item.since,
          observedAt: item.observedAt,
          witnesses: 1,
        });
      else {
        known.since = Math.min(known.since, item.since);
        known.observedAt = Math.max(known.observedAt, item.observedAt);
        if (!witnessed.has(item.url)) known.witnesses++;
      }
      witnessed.add(item.url);
    }
  }
  return {
    scheduledAt: window.scheduledAt,
    answers: answers.length,
    analysed,
    carried,
    noNote,
    unfetched,
    evidence: [...changes.values()].sort(
      (a, b) => b.observedAt - a.observedAt || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
    ),
    firstChecked: firstChecked.size,
  };
}

/** A market reads AGING from this many closed windows after its latest answered window. */
export const FRESHNESS_AGING_WINDOWS = 1;
/** And STALE from this many. */
export const FRESHNESS_STALE_WINDOWS = 3;
export const FreshnessLevel = z.enum(["CURRENT", "AGING", "STALE", "NONE"]);
export type FreshnessLevel = z.infer<typeof FreshnessLevel>;

/**
 * How fresh an OPEN market's forecasts are. lastAnsweredWindow, ageSeconds, windowsBehind and level
 * rest on the platform's clock (window deadlines); analysedAt and evidenceChangedAt rest on what
 * forecasters reported in their notes.
 */
export const FreshnessView = z.strictObject({
  asOf: UnixSeconds,
  /** The scheduledAt (the deadline) of the latest closed window with at least one answer. */
  lastAnsweredWindow: UnixSeconds.nullable(),
  /** asOf minus lastAnsweredWindow, never negative. */
  ageSeconds: Count.nullable(),
  /** Closed windows after lastAnsweredWindow; every closed window when none has an answer. */
  windowsBehind: Count,
  level: FreshnessLevel,
  /** The scheduledAt of the latest closed window with at least one analysis. */
  analysedAt: UnixSeconds.nullable(),
  /** The latest observedAt of a CHANGED item in an analysis note. */
  evidenceChangedAt: UnixSeconds.nullable(),
  /** The answers of the latest closed window. */
  latestWindow: z.strictObject(AnswerCounts),
});
export type FreshnessView = z.infer<typeof FreshnessView>;

/**
 * The freshness of a market from its closed windows (in any order; a window's position comes from
 * its scheduledAt) as of asOf, in unix seconds. Windows are unique by scheduledAt, and the caller
 * passes only closed windows. Forecasts are counted in windows first: CURRENT when
 * the latest closed window has an answer, AGING at 1 or 2 windows behind, STALE at 3 or more, and
 * NONE when no closed window has one.
 */
export function computeFreshness(
  windows: readonly WindowSummary[],
  asOf: number,
): FreshnessView {
  let lastAnswered: number | null = null;
  let analysedAt: number | null = null;
  let evidenceChangedAt: number | null = null;
  let latest: WindowSummary | undefined;
  for (const w of windows) {
    if (w.answers > 0 && (lastAnswered === null || w.scheduledAt > lastAnswered))
      lastAnswered = w.scheduledAt;
    if (w.analysed > 0 && (analysedAt === null || w.scheduledAt > analysedAt))
      analysedAt = w.scheduledAt;
    for (const change of w.evidence)
      if (evidenceChangedAt === null || change.observedAt > evidenceChangedAt)
        evidenceChangedAt = change.observedAt;
    if (latest === undefined || w.scheduledAt > latest.scheduledAt) latest = w;
  }
  const answered = lastAnswered;
  const windowsBehind = windows.filter(
    (w) => answered === null || w.scheduledAt > answered,
  ).length;
  return {
    asOf,
    lastAnsweredWindow: answered,
    ageSeconds: answered === null ? null : Math.max(0, asOf - answered),
    windowsBehind,
    level:
      answered === null
        ? "NONE"
        : windowsBehind >= FRESHNESS_STALE_WINDOWS
          ? "STALE"
          : windowsBehind >= FRESHNESS_AGING_WINDOWS
            ? "AGING"
            : "CURRENT",
    analysedAt,
    evidenceChangedAt,
    latestWindow: {
      answers: latest?.answers ?? 0,
      analysed: latest?.analysed ?? 0,
      carried: latest?.carried ?? 0,
      noNote: latest?.noNote ?? 0,
      unfetched: latest?.unfetched ?? 0,
    },
  };
}
