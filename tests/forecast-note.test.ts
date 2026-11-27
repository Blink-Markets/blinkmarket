import assert from "node:assert/strict";
import { test } from "node:test";
import * as client from "../packages/client/src/index.ts";
import * as schemas from "../packages/schemas/src/index.ts";
import {
  FORECAST_NOTE_MAX_BYTES,
  FORECAST_NOTE_MAX_EVIDENCE,
  FORECAST_NOTE_MAX_ITEM_NOTE_CHARS,
  FORECAST_NOTE_MAX_SUMMARY_CHARS,
  FORECAST_NOTE_MAX_URL_CHARS,
  FORECAST_NOTE_SCHEMA,
  FRESHNESS_AGING_WINDOWS,
  FRESHNESS_STALE_WINDOWS,
  FreshnessView,
  computeFreshness,
  noteBelongsTo,
  parseForecastNote,
  summarizeWindow,
  type ForecastNote,
  type WindowAnswer,
  type WindowSummary,
} from "../packages/schemas/src/forecast-note.ts";

const DAY = 86_400;
const HOUR = 3600;
const hash = (c: string) => "0x" + c.repeat(64);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const parse = (value: unknown) => parseForecastNote(encode(value));
/** The note as parsed; fails the test when it is refused. */
const read = (value: unknown): ForecastNote => {
  const result = parse(value);
  if (!result.ok) assert.fail(result.reason);
  return result.note;
};
/** Why a note is refused; fails the test when it parses. */
const refusal = (value: unknown): string => {
  const result = parse(value);
  if (result.ok) assert.fail("expected a refusal: " + JSON.stringify(value).slice(0, 160));
  return result.reason;
};

const MARKETS = "0x4B5a7C9e1D3f5A7b9C1d3E5f7A9b1C3d5E7f9A1b";
const FORECASTER = "0x" + "a1".repeat(20);
const OTHER_FORECASTER = "0x" + "b2".repeat(20);
// A daily window: its deadline (scheduledAt) is a UTC midnight and it opens 30 minutes before.
const SCHEDULED_AT = Date.UTC(2026, 10, 30) / 1000;
const OPEN_AT = SCHEDULED_AT - 1800;
const RECEIVED_AT = OPEN_AT + 60;
const WINDOW = { scheduledAt: SCHEDULED_AT, openAt: OPEN_AT };
const SOURCE = "https://a.example/investors/q2-release";
const FEED = "https://b.example/feed";

/** One evidence item, checked at the window's open; a CHANGED one changed since the previous window. */
const item = (url: string, status: string, patch: Record<string, unknown> = {}) => ({
  url,
  status,
  since: status === "CHANGED" ? OPEN_AT - DAY + 30 : null,
  observedAt: OPEN_AT + 30,
  fingerprint: hash("f"),
  snapshot: status === "CHANGED" ? hash("5") : null,
  note: "",
  ...patch,
});
const analysis = {
  schema: "blink.forecast-note/0.1",
  kind: "analysis",
  marketId: "7",
  markets: MARKETS,
  forecaster: FORECASTER,
  horizon: 0,
  scheduledAt: SCHEDULED_AT,
  salt: hash("a"),
  checkedAt: OPEN_AT + 40,
  prior: { digest: hash("d") },
  summary: "The new release shows a 68% margin, below the 70% threshold.",
  evidence: [
    item(SOURCE, "CHANGED", { note: "Gross margin line updated." }),
    item(FEED, "UNCHANGED"),
  ],
  detail: null,
};
const carryForward = {
  ...analysis,
  kind: "carry_forward",
  salt: hash("b"),
  summary: "",
  evidence: [item(SOURCE, "UNCHANGED"), item(FEED, "UNREACHABLE")],
};
/** An https URL of exactly `length` characters. */
const urlOf = (length: number) => {
  const prefix = "https://a.example/";
  return prefix + "x".repeat(length - prefix.length);
};
const answer = (
  note: ForecastNote | null,
  noteState: WindowAnswer["noteState"] = note ? "read" : "none",
  receivedAt = RECEIVED_AT,
): WindowAnswer => ({ note, noteState, receivedAt });
const counts = (s: WindowSummary) => ({
  answers: s.answers,
  analysed: s.analysed,
  carried: s.carried,
  noNote: s.noNote,
  unfetched: s.unfetched,
});

// --- parsing ---

test("parseForecastNote accepts an analysis note and a carry-forward note", () => {
  assert.equal(FORECAST_NOTE_SCHEMA, "blink.forecast-note/0.1");
  assert.equal(FORECAST_NOTE_MAX_BYTES, 65_536);
  assert.deepEqual(read(analysis), analysis);
  assert.deepEqual(read(carryForward), carryForward);
  // A cold start names no prior; detail may name a longer document; an empty watch list is allowed.
  const cold = { ...analysis, prior: null, detail: hash("e"), evidence: [] };
  assert.deepEqual(read(cold), cold);
});

test("parseForecastNote refuses a BOM, invalid UTF-8, an unknown key, 21 evidence items, a non-https url, a url over 2048 characters and bytes over 64 KiB", () => {
  const bytes = encode(analysis);
  assert.deepEqual(parseForecastNote(Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes])), {
    ok: false,
    reason: "BOM",
  });
  assert.deepEqual(parseForecastNote(Uint8Array.from([...bytes.slice(0, -2), 0xff, 0xfe, 0x7d])), {
    ok: false,
    reason: "INVALID_UTF8",
  });
  // Unknown keys, at every level of the note.
  assert.match(refusal({ ...analysis, probabilityBps: 6800 }), /^INVALID_NOTE: /);
  assert.match(refusal({ ...analysis, prior: { digest: hash("d"), probabilityBps: 6800 } }), /^INVALID_NOTE: prior/);
  assert.match(refusal({ ...analysis, evidence: [{ ...item(SOURCE, "CHANGED"), excerpt: "68%" }] }), /^INVALID_NOTE: evidence\.0/);
  // At most 20 evidence items.
  const items = (n: number) => Array.from({ length: n }, (_, i) => item(`https://a.example/${i}`, "UNCHANGED"));
  assert.ok(parse({ ...analysis, evidence: items(20) }).ok);
  assert.match(refusal({ ...analysis, evidence: items(21) }), /^INVALID_NOTE: evidence/);
  // Only an https URL written out in full; the URL parser would silently drop spaces, tabs and newlines.
  for (const url of [
    "http://a.example/q2",
    "ftp://a.example/q2",
    "a.example/q2",
    "https:a.example/q2",
    " https://a.example/q2",
    "https://a.example/q2\n",
    "https://a.exa\tmple/q2",
    "https://",
    // The URL parser reads these as the host after the slashes or the backslash, not as written.
    "https:///a.example",
    "https:////a.example",
    "HTTPS://a.example/",
    "https://a.example\\@b.example/",
  ])
    assert.match(refusal({ ...analysis, evidence: [item(url, "UNCHANGED")] }), /^INVALID_NOTE: evidence\.0\.url/, url);
  // At most 2048 characters.
  assert.ok(parse({ ...analysis, evidence: [item(urlOf(2048), "UNCHANGED")] }).ok);
  assert.match(refusal({ ...analysis, evidence: [item(urlOf(2049), "UNCHANGED")] }), /^INVALID_NOTE: evidence\.0\.url/);
  // The size cap counts bytes, so even JSON whitespace past 64 KiB is refused before anything is decoded.
  const padded = new Uint8Array(FORECAST_NOTE_MAX_BYTES + 1).fill(0x20);
  padded.set(bytes);
  assert.deepEqual(parseForecastNote(padded), { ok: false, reason: "TOO_LARGE" });
});

test("a refusal reason stays short however long the sender's unknown key is", () => {
  const reason = refusal({ ...analysis, ["k".repeat(5000)]: 1 });
  assert.match(reason, /^INVALID_NOTE: /);
  assert.ok(reason.length <= 400, String(reason.length));
  // The path is capped too: a long unknown key inside an evidence item.
  const nested = refusal({ ...analysis, evidence: [{ ...item(SOURCE, "UNCHANGED"), ["k".repeat(5000)]: 1 }] });
  assert.ok(nested.length <= 400, String(nested.length));
});

test("parseForecastNote refuses invalid JSON and JSON that is not an object", () => {
  const text = (value: string) => parseForecastNote(new TextEncoder().encode(value));
  assert.deepEqual(text("nope"), { ok: false, reason: "INVALID_JSON" });
  assert.deepEqual(text(""), { ok: false, reason: "INVALID_JSON" });
  for (const value of ["[]", "null", '"note"', "7", "true", JSON.stringify([analysis])])
    assert.deepEqual(text(value), { ok: false, reason: "NOT_AN_OBJECT" }, value);
});

test("a note of exactly 65,536 bytes parses", () => {
  // Twenty CHANGED items with long URLs and full item notes, then a summary that fills the rest.
  // U+0001 takes six bytes in JSON ("\u0001") and counts as one character.
  const base = {
    ...analysis,
    summary: "",
    evidence: Array.from({ length: 20 }, (_, i) =>
      item(urlOf(2040) + i, "CHANGED", { note: "n".repeat(500) }),
    ),
  };
  const room = FORECAST_NOTE_MAX_BYTES - encode(base).length;
  const sixes = Math.floor(room / 6);
  const full = { ...base, summary: "\u0001".repeat(sixes) + "s".repeat(room - 6 * sixes) };
  assert.ok(full.summary.length <= 2000, "the fixture must stay within the summary limit");
  assert.equal(encode(full).length, 65_536);
  assert.deepEqual(read(full), full);
  // One byte more is too large, though every field is still within its own limit.
  const over = { ...full, summary: full.summary + "s" };
  assert.equal(encode(over).length, 65_537);
  assert.deepEqual(parse(over), { ok: false, reason: "TOO_LARGE" });
});

test("a note without a salt, or with a malformed one, is refused", () => {
  const { salt: _salt, ...withoutSalt } = analysis;
  assert.match(refusal(withoutSalt), /^INVALID_NOTE: salt/);
  for (const salt of [
    null,
    "",
    "0x",
    "0x1234",
    "0x" + "a".repeat(63),
    "0x" + "a".repeat(65),
    "a".repeat(64),
    "0x" + "g".repeat(64),
    7,
  ])
    assert.match(refusal({ ...analysis, salt }), /^INVALID_NOTE: salt/, String(salt));
});

test("a marketId with a leading zero or a sign is refused", () => {
  for (const marketId of ["07", "+7", "-7", " 7", "7.0", "0x7", "", 7])
    assert.match(refusal({ ...analysis, marketId }), /^INVALID_NOTE: marketId/, String(marketId));
  assert.ok(parse({ ...analysis, marketId: "10" }).ok);
});

test("a NEW item with a since is refused; a CHANGED item without a since, or with one after observedAt, is refused", () => {
  const observedAt = OPEN_AT + 30;
  assert.ok(parse({ ...analysis, evidence: [item(SOURCE, "NEW")] }).ok);
  assert.match(
    refusal({ ...analysis, evidence: [item(SOURCE, "NEW", { since: observedAt - DAY })] }),
    /^INVALID_NOTE: evidence\.0\.since/,
  );
  assert.match(
    refusal({ ...analysis, evidence: [item(SOURCE, "CHANGED", { since: null })] }),
    /^INVALID_NOTE: evidence\.0\.since/,
  );
  assert.match(
    refusal({ ...analysis, evidence: [item(SOURCE, "CHANGED", { since: observedAt + 1 })] }),
    /^INVALID_NOTE: evidence\.0\.since/,
  );
  // "Not after" includes the same second.
  assert.ok(parse({ ...analysis, evidence: [item(SOURCE, "CHANGED", { since: observedAt })] }).ok);
});

test("an UNREACHABLE item with a null fingerprint is accepted; a NEW, CHANGED or UNCHANGED item with one is refused", () => {
  const never = { fingerprint: null, snapshot: null, note: "The host did not answer." };
  const unreachable = { ...analysis, evidence: [item(SOURCE, "UNREACHABLE", never)] };
  assert.deepEqual(read(unreachable), unreachable);
  // The same holds in a carry-forward note, which may list UNREACHABLE items.
  assert.ok(parse({ ...carryForward, evidence: [item(SOURCE, "UNREACHABLE", never)] }).ok);
  for (const status of ["NEW", "CHANGED", "UNCHANGED"])
    assert.match(
      refusal({ ...analysis, evidence: [item(SOURCE, status, { fingerprint: null })] }),
      /^INVALID_NOTE: evidence\.0\.fingerprint/,
      status,
    );
  // A fingerprint that is present is still a keccak256 hash, whatever the status.
  assert.match(
    refusal({ ...analysis, evidence: [item(SOURCE, "UNREACHABLE", { fingerprint: "0x12" })] }),
    /^INVALID_NOTE: evidence\.0\.fingerprint/,
  );
  // An item that was never fetched does not break the reducers.
  const summary = summarizeWindow([answer(read(unreachable))], WINDOW);
  assert.deepEqual(counts(summary), { answers: 1, analysed: 1, carried: 0, noNote: 0, unfetched: 0 });
  assert.deepEqual(summary.evidence, []);
  assert.equal(summary.firstChecked, 0);
  const view = computeFreshness([summary], SCHEDULED_AT + HOUR);
  assert.equal(view.evidenceChangedAt, null);
  assert.equal(view.level, "CURRENT");
});

test("a carry-forward note without a prior is refused; an analysis note without one is accepted", () => {
  assert.match(refusal({ ...carryForward, prior: null }), /^INVALID_NOTE: prior/);
  assert.ok(parse(carryForward).ok);
  // A cold start has nothing to carry forward, so it is an analysis.
  assert.equal(read({ ...analysis, prior: null }).prior, null);
});

test("a carry-forward note listing a CHANGED or NEW item is refused; a heartbeat analysis note listing only UNCHANGED items is accepted", () => {
  assert.match(
    refusal({ ...carryForward, evidence: [item(SOURCE, "CHANGED")] }),
    /^INVALID_NOTE: evidence\.0\.status/,
  );
  assert.match(
    refusal({ ...carryForward, evidence: [item(SOURCE, "UNCHANGED"), item(FEED, "NEW")] }),
    /^INVALID_NOTE: evidence\.1\.status/,
  );
  const heartbeat = { ...analysis, evidence: [item(SOURCE, "UNCHANGED"), item(FEED, "UNCHANGED")] };
  assert.deepEqual(read(heartbeat), heartbeat);
});

test("a note for another window, market, deployment or forecaster is unreadable", () => {
  const note = read(analysis);
  // The subject as the signed answer and its window name it; addresses compare in any case.
  const subject = {
    marketId: "7",
    markets: MARKETS.toLowerCase(),
    forecaster: FORECASTER.toUpperCase().replace("0X", "0x"),
    horizon: 0,
    scheduledAt: SCHEDULED_AT,
  };
  assert.equal(noteBelongsTo(note, subject), true);
  // The values a ForecastMessage may carry: a bigint market id and window time.
  assert.equal(noteBelongsTo(note, { ...subject, marketId: 7n, scheduledAt: BigInt(SCHEDULED_AT) }), true);
  const others = [
    ["marketId", "8"],
    ["markets", "0x" + "cd".repeat(20)],
    ["forecaster", OTHER_FORECASTER],
    ["horizon", 1],
    ["scheduledAt", SCHEDULED_AT + DAY],
  ] as const;
  for (const [field, value] of others)
    assert.equal(noteBelongsTo(note, { ...subject, [field]: value }), false, field);
  assert.equal(noteBelongsTo(note, { ...subject, marketId: 8n }), false);
  assert.equal(noteBelongsTo(note, { ...subject, scheduledAt: BigInt(SCHEDULED_AT + DAY) }), false);
});

// --- one window ---

test("summarizeWindow counts analysed, carried, noNote and unfetched answers separately", () => {
  const summary = summarizeWindow(
    [
      answer(read(analysis)),
      answer(read({ ...analysis, forecaster: OTHER_FORECASTER, salt: hash("c") })),
      answer(read(carryForward)),
      // No readable note: NO_CONTENT_HASH, a 404, a hash mismatch or an invalid note.
      answer(null),
      // A note the reader parsed but found to be about another subject: it shows nothing.
      answer(read({ ...analysis, marketId: "8", evidence: [item("https://c.example/", "CHANGED")] }), "none"),
      // Beyond the reader's notesPerWindow limit.
      answer(null, "unfetched"),
      answer(null, "unfetched"),
    ],
    WINDOW,
  );
  assert.equal(summary.scheduledAt, SCHEDULED_AT);
  assert.deepEqual(counts(summary), { answers: 7, analysed: 2, carried: 1, noNote: 2, unfetched: 2 });
  assert.deepEqual(summary.evidence.map((e) => e.url), [SOURCE]);
  // A "read" state without a note is not a readable note.
  assert.deepEqual(counts(summarizeWindow([answer(null, "read")], WINDOW)), {
    answers: 1,
    analysed: 0,
    carried: 0,
    noNote: 1,
    unfetched: 0,
  });
  assert.deepEqual(counts(summarizeWindow([], WINDOW)), {
    answers: 0,
    analysed: 0,
    carried: 0,
    noNote: 0,
    unfetched: 0,
  });
});

test("summarizeWindow merges the same url seen by two agents into one change with two witnesses", () => {
  const mine = read({
    ...analysis,
    evidence: [item(SOURCE, "CHANGED", { since: OPEN_AT - DAY + 30, observedAt: OPEN_AT + 30 })],
  });
  const theirs = read({
    ...analysis,
    forecaster: OTHER_FORECASTER,
    salt: hash("c"),
    evidence: [
      item(SOURCE, "CHANGED", { since: OPEN_AT - DAY + 600, observedAt: OPEN_AT + 50 }),
      // The same source twice in one note is still one witness.
      item(SOURCE, "CHANGED", { since: OPEN_AT - DAY + 700, observedAt: OPEN_AT + 45 }),
      item(FEED, "CHANGED", { since: OPEN_AT - DAY + 10, observedAt: OPEN_AT + 20 }),
    ],
  });
  const summary = summarizeWindow([answer(mine), answer(theirs, "read", OPEN_AT + 70)], WINDOW);
  // Newest first; the earliest since and the latest observedAt of everyone who saw the change.
  assert.deepEqual(summary.evidence, [
    { url: SOURCE, since: OPEN_AT - DAY + 30, observedAt: OPEN_AT + 50, witnesses: 2 },
    { url: FEED, since: OPEN_AT - DAY + 10, observedAt: OPEN_AT + 20, witnesses: 1 },
  ]);
  assert.equal(summary.firstChecked, 0);
  // The order of the answers does not change the result.
  assert.deepEqual(
    summarizeWindow([answer(theirs, "read", OPEN_AT + 70), answer(mine)], WINDOW),
    summary,
  );
});

test("evidence items with times outside the window are ignored", () => {
  const earliest = OPEN_AT - DAY;
  const note = read({
    ...analysis,
    evidence: [
      item("https://a.example/too-early", "CHANGED", { since: earliest - 100, observedAt: earliest - 1 }),
      item("https://a.example/earliest", "CHANGED", { since: earliest - 100, observedAt: earliest }),
      item("https://a.example/at-receipt", "CHANGED", { since: earliest, observedAt: RECEIVED_AT }),
      item("https://a.example/after-receipt", "CHANGED", { since: earliest, observedAt: RECEIVED_AT + 1 }),
      item("https://a.example/new-after-receipt", "NEW", { observedAt: RECEIVED_AT + 1 }),
      item("https://a.example/new-too-early", "NEW", { observedAt: earliest - 1 }),
    ],
  });
  // The parser refuses a since after observedAt; a reducer handed such an item anyway ignores it.
  const backwards = { ...note.evidence[2]!, url: "https://a.example/backwards", since: RECEIVED_AT, observedAt: RECEIVED_AT - 1 };
  const summary = summarizeWindow([answer({ ...note, evidence: [...note.evidence, backwards] })], WINDOW);
  assert.deepEqual(summary.evidence, [
    { url: "https://a.example/at-receipt", since: earliest, observedAt: RECEIVED_AT, witnesses: 1 },
    { url: "https://a.example/earliest", since: earliest - 100, observedAt: earliest, witnesses: 1 },
  ]);
  assert.equal(summary.firstChecked, 0);
  // The note still counts as an answer and as an analysis.
  assert.deepEqual(counts(summary), { answers: 1, analysed: 1, carried: 0, noNote: 0, unfetched: 0 });
});

test("a NEW item is counted as firstChecked and not as a change", () => {
  const mine = read({ ...analysis, evidence: [item(SOURCE, "NEW"), item(FEED, "NEW")] });
  const theirs = read({
    ...analysis,
    forecaster: OTHER_FORECASTER,
    salt: hash("c"),
    evidence: [item(SOURCE, "NEW"), item("https://c.example/", "UNCHANGED")],
  });
  const summary = summarizeWindow([answer(mine), answer(theirs)], WINDOW);
  assert.deepEqual(summary.evidence, []);
  // Two sources were checked for the first time; the one both agents first checked counts once.
  assert.equal(summary.firstChecked, 2);
  assert.equal(computeFreshness([summary], SCHEDULED_AT + HOUR).evidenceChangedAt, null);
});

// --- a market's freshness ---

// Daily windows close at UTC midnight: "Tuesday's window" closes at the end of Tuesday 2026-10-06.
const TUESDAY = Date.UTC(2026, 9, 7) / 1000;
const day = (n: number) => TUESDAY + n * DAY;
const windowOf = (scheduledAt: number, answers: number, patch: Partial<WindowSummary> = {}): WindowSummary => ({
  scheduledAt,
  answers,
  analysed: answers,
  carried: 0,
  noNote: 0,
  unfetched: 0,
  evidence: [],
  firstChecked: 0,
  ...patch,
});
const NO_ANSWERS = { answers: 0, analysed: 0, carried: 0, noNote: 0, unfetched: 0 };

test("computeFreshness is CURRENT when the latest closed window has an answer, AGING at 1 and 2 windows behind, STALE at 3 and NONE with no answer", () => {
  assert.equal(FRESHNESS_AGING_WINDOWS, 1);
  assert.equal(FRESHNESS_STALE_WINDOWS, 3);
  const tuesday = windowOf(day(0), 3);
  const fresh = (windows: WindowSummary[], asOf: number) => {
    const view = computeFreshness(windows, asOf);
    assert.deepEqual(FreshnessView.parse(view), view);
    return view;
  };
  // Wednesday: Tuesday's window is the latest closed one and has 3 answers.
  assert.deepEqual(fresh([tuesday], day(0) + 12 * HOUR), {
    asOf: day(0) + 12 * HOUR,
    lastAnsweredWindow: day(0),
    ageSeconds: 12 * HOUR,
    windowsBehind: 0,
    level: "CURRENT",
    analysedAt: day(0),
    evidenceChangedAt: null,
    latestWindow: { answers: 3, analysed: 3, carried: 0, noNote: 0, unfetched: 0 },
  });
  // Nobody answered Wednesday: on Thursday, one window behind.
  const thursday = fresh([tuesday, windowOf(day(1), 0)], day(1) + 12 * HOUR);
  assert.deepEqual(
    [thursday.level, thursday.windowsBehind, thursday.lastAnsweredWindow, thursday.ageSeconds],
    ["AGING", 1, day(0), DAY + 12 * HOUR],
  );
  assert.deepEqual(thursday.latestWindow, NO_ANSWERS);
  // Nor Thursday: on Friday, two windows behind.
  const friday = fresh([tuesday, windowOf(day(1), 0), windowOf(day(2), 0)], day(2) + 12 * HOUR);
  assert.deepEqual([friday.level, friday.windowsBehind, friday.analysedAt], ["AGING", 2, day(0)]);
  // Add Friday with no answers: stale.
  const saturday = fresh(
    [tuesday, windowOf(day(1), 0), windowOf(day(2), 0), windowOf(day(3), 0)],
    day(3) + 12 * HOUR,
  );
  assert.deepEqual([saturday.level, saturday.windowsBehind], ["STALE", 3]);
  // A window answered only by carry-forwards is current, while the last analysis stays where it was.
  const carried = fresh([tuesday, windowOf(day(1), 2, { analysed: 0, carried: 2 })], day(1) + HOUR);
  assert.deepEqual(
    [carried.level, carried.lastAnsweredWindow, carried.analysedAt],
    ["CURRENT", day(1), day(0)],
  );
  // No closed window has an answer, or there is no closed window at all.
  assert.deepEqual(fresh([windowOf(day(0), 0), windowOf(day(1), 0)], day(1) + HOUR), {
    asOf: day(1) + HOUR,
    lastAnsweredWindow: null,
    ageSeconds: null,
    windowsBehind: 2,
    level: "NONE",
    analysedAt: null,
    evidenceChangedAt: null,
    latestWindow: NO_ANSWERS,
  });
  assert.deepEqual(fresh([], day(0)), {
    asOf: day(0),
    lastAnsweredWindow: null,
    ageSeconds: null,
    windowsBehind: 0,
    level: "NONE",
    analysedAt: null,
    evidenceChangedAt: null,
    latestWindow: NO_ANSWERS,
  });
});

test("computeFreshness does not depend on the order of the windows, and its age is never negative", () => {
  const windows = [
    windowOf(day(0), 2, { evidence: [{ url: SOURCE, since: day(0) - DAY, observedAt: day(0) - HOUR, witnesses: 1 }] }),
    windowOf(day(1), 0),
    windowOf(day(2), 1, { analysed: 0, carried: 1 }),
    windowOf(day(3), 0),
  ];
  const asOf = day(3) + HOUR;
  const view = computeFreshness(windows, asOf);
  assert.deepEqual(computeFreshness([...windows].reverse(), asOf), view);
  assert.deepEqual(computeFreshness([windows[2]!, windows[0]!, windows[3]!, windows[1]!], asOf), view);
  assert.equal(view.lastAnsweredWindow, day(2));
  // asOf before the window's deadline: the age is 0, never negative.
  assert.equal(computeFreshness([windowOf(day(1), 2)], day(0)).ageSeconds, 0);
});

test("computeFreshness reports evidenceChangedAt as the latest observedAt of a CHANGED item in an analysis note, and null when there is none or only NEW items", () => {
  const windowAt = (scheduledAt: number) => ({ scheduledAt, openAt: scheduledAt - 1800 });
  const noteFor = (scheduledAt: number, kind: string, evidence: unknown[]) =>
    read({ ...analysis, kind, scheduledAt, evidence, ...(kind === "carry_forward" ? { summary: "" } : {}) });
  // Tuesday's analysis saw the release change 100 s after its window opened. Wednesday's saw the
  // feed change, and its observation lies earlier than Tuesday's (still inside its own range).
  const tuesdayOpen = day(0) - 1800;
  const tuesday = summarizeWindow(
    [
      answer(
        noteFor(day(0), "analysis", [
          item(SOURCE, "CHANGED", { since: tuesdayOpen - DAY, observedAt: tuesdayOpen + 100 }),
        ]),
        "read",
        tuesdayOpen + 200,
      ),
    ],
    windowAt(day(0)),
  );
  const wednesday = summarizeWindow(
    [
      answer(
        noteFor(day(1), "analysis", [
          item(FEED, "CHANGED", { since: tuesdayOpen - DAY, observedAt: tuesdayOpen + 10 }),
        ]),
        "read",
        day(1) - 1700,
      ),
    ],
    windowAt(day(1)),
  );
  const thursday = summarizeWindow(
    [answer(noteFor(day(2), "carry_forward", [item(SOURCE, "UNCHANGED")]), "read", day(2) - 1700)],
    windowAt(day(2)),
  );
  const view = computeFreshness([tuesday, wednesday, thursday], day(2) + HOUR);
  assert.equal(view.evidenceChangedAt, tuesdayOpen + 100);
  assert.deepEqual([view.level, view.analysedAt], ["CURRENT", day(1)]);
  // Only unchanged sources: nothing changed.
  const quiet = summarizeWindow(
    [answer(noteFor(day(0), "analysis", [item(SOURCE, "UNCHANGED")]), "read", tuesdayOpen + 200)],
    windowAt(day(0)),
  );
  assert.equal(computeFreshness([quiet, thursday], day(2) + HOUR).evidenceChangedAt, null);
  // Only first checks: nothing changed either.
  const firstChecks = summarizeWindow(
    [
      answer(
        noteFor(day(0), "analysis", [item(SOURCE, "NEW", { observedAt: tuesdayOpen + 100 })]),
        "read",
        tuesdayOpen + 200,
      ),
    ],
    windowAt(day(0)),
  );
  assert.equal(firstChecks.firstChecked, 1);
  assert.equal(computeFreshness([firstChecks], day(0) + HOUR).evidenceChangedAt, null);
  assert.equal(computeFreshness([], day(0)).evidenceChangedAt, null);
});

// --- exports ---

test("@blink/schemas exports the note module and @blink/client re-exports it for agents", () => {
  for (const name of ["parseForecastNote", "noteBelongsTo", "summarizeWindow", "computeFreshness"] as const) {
    assert.equal(typeof schemas[name], "function", name);
    assert.equal(schemas[name], client[name], name);
  }
  assert.equal(schemas.parseForecastNote, parseForecastNote);
  assert.equal(client.FORECAST_NOTE_SCHEMA, FORECAST_NOTE_SCHEMA);
  assert.equal(client.FORECAST_NOTE_MAX_BYTES, FORECAST_NOTE_MAX_BYTES);
  // The limits the note builder shares with the schema: one source of truth, re-exported.
  const limits = {
    FORECAST_NOTE_MAX_EVIDENCE: [20, FORECAST_NOTE_MAX_EVIDENCE],
    FORECAST_NOTE_MAX_URL_CHARS: [2048, FORECAST_NOTE_MAX_URL_CHARS],
    FORECAST_NOTE_MAX_ITEM_NOTE_CHARS: [500, FORECAST_NOTE_MAX_ITEM_NOTE_CHARS],
    FORECAST_NOTE_MAX_SUMMARY_CHARS: [2000, FORECAST_NOTE_MAX_SUMMARY_CHARS],
  } as const;
  for (const [name, [value, imported]] of Object.entries(limits)) {
    assert.equal(imported, value, name);
    assert.equal(schemas[name as keyof typeof limits], value, name);
    assert.equal(client[name as keyof typeof limits], value, name);
  }
});
