import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256 } from "viem";
import {
  NO_CONTENT_HASH,
  computeFreshness,
  noteBelongsTo,
  parseForecastNote,
  summarizeWindow,
  type WindowAnswer,
} from "../packages/client/src/index.ts";
import {
  getMarketFreshness,
  type FreshnessClient,
} from "../packages/client/src/freshness.ts";
import { createBlinkClient } from "../packages/client/src/index.ts";

// The real client fits the reader's view of it; `pnpm typecheck` checks this line.
const _realClientFits: FreshnessClient = createBlinkClient("https://x.example");
void _realClientFits;

const DAY = 86_400;
const MARKET = "7";
const MARKETS = "0x4B5a7C9e1D3f5A7b9C1d3E5f7A9b1C3d5E7f9A1b";
const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const FIRST = Date.UTC(2026, 10, 1) / 1000;
const hash = (c: string) => "0x" + c.repeat(64);
const SOURCE = "https://a.example/investors/q2-release";
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

type Status = "UPCOMING" | "OPEN" | "CLOSED";
type StubAnswer = {
  forecaster?: string;
  /** The bytes the store serves for the answer's contentHash; absent: no such content (404). */
  note?: Uint8Array;
  /** Served bytes whose hash is not the one asked for. */
  mismatch?: boolean;
  noContentHash?: boolean;
  withdrawnAt?: number | null;
};
type StubWindow = {
  scheduledAt: number;
  horizon?: 0 | 1;
  status?: Status;
  answers?: StubAnswer[];
};

/** The note one agent writes for one window; a CHANGED source changed during the day before. */
function noteFor(
  scheduledAt: number,
  patch: Record<string, unknown> = {},
  evidence: Record<string, unknown>[] | null = null,
) {
  return {
    schema: "blink.forecast-note/0.1",
    kind: "analysis",
    marketId: MARKET,
    markets: MARKETS,
    forecaster: A,
    horizon: 0,
    scheduledAt,
    salt: hash("a"),
    checkedAt: scheduledAt - 1790,
    prior: { digest: hash("d") },
    summary: "A summary.",
    evidence: evidence ?? [
      {
        url: SOURCE,
        status: "CHANGED",
        since: scheduledAt - DAY,
        observedAt: scheduledAt - 1780,
        fingerprint: hash("f"),
        snapshot: null,
        note: "",
      },
    ],
    detail: null,
    ...patch,
  };
}

/**
 * A client that serves the public routes from a script, with the same paging limits as the real
 * routes, and counts what the reader asked for.
 */
function stubClient(windows: StubWindow[], options: { pageSize?: number } = {}) {
  const calls = {
    windows: 0,
    consensus: 0,
    forecasts: [] as string[],
    content: [] as string[],
    maxLimit: 0,
  };
  const served = new Map<string, Uint8Array>();
  const rows = windows.map((w, i) => {
    const answers = (w.answers ?? []).map((a, j) => {
      const noteBytes = a.note;
      const contentHash = a.noContentHash
        ? NO_CONTENT_HASH
        : noteBytes
          ? keccak256(noteBytes)
          : hash(((i * 7 + j + 1) % 15).toString(16));
      if (noteBytes) served.set(contentHash, a.mismatch ? bytesOf("other") : noteBytes);
      return {
        submissionId: `sub-${i}-${j}`,
        windowId: `win-${i}`,
        forecaster: a.forecaster ?? A,
        probabilityBps: 5000,
        contentHash,
        digest: hash("d"),
        leaf: hash("e"),
        signature: "0x00",
        verifiedBlock: 1,
        receivedAt: w.scheduledAt - 1700 + j,
        withdrawnAt: a.withdrawnAt ?? null,
      };
    });
    return {
      view: {
        windowId: `win-${i}`,
        horizon: w.horizon ?? 0,
        scheduledAt: w.scheduledAt,
        openAt: w.scheduledAt - 1800,
        deadline: w.scheduledAt,
        status: w.status ?? "CLOSED",
      },
      answers,
    };
  });
  const pageOf = <T>(items: T[], query: { limit?: number; cursor?: string }) => {
    const limit = query.limit ?? 20;
    assert.ok(limit >= 1 && limit <= 100, "limit out of range: " + limit);
    calls.maxLimit = Math.max(calls.maxLimit, limit);
    const size = Math.min(limit, options.pageSize ?? 100);
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const end = start + size;
    return { items: items.slice(start, end), nextCursor: end < items.length ? String(end) : null };
  };
  const client: FreshnessClient = {
    getDeployment: async () => ({ deployment: { generation: { markets: MARKETS } } }),
    listForecastWindows: async (ref, query = {}) => {
      assert.equal(ref.marketId, MARKET);
      calls.windows++;
      return pageOf(
        rows.map((r) => r.view),
        query,
      );
    },
    getConsensus: async (ref, query = {}) => {
      assert.equal(ref.marketId, MARKET);
      calls.consensus++;
      return pageOf(
        rows
          .filter((r) => r.view.status === "CLOSED")
          .map((r) => ({
            windowId: r.view.windowId,
            scheduledAt: r.view.scheduledAt,
            submissions: r.answers.filter((a) => a.withdrawnAt === null).length,
          })),
        query,
      );
    },
    listForecasts: async (ref, query) => {
      assert.equal(ref.marketId, MARKET);
      calls.forecasts.push(query.windowId);
      const row = rows.find((r) => r.view.windowId === query.windowId);
      assert.ok(row, "unknown window");
      assert.equal(row.view.status, "CLOSED", "answers of a window that is not closed were asked for");
      return pageOf(row.answers, query);
    },
    getContent: async (contentHash) => {
      calls.content.push(contentHash);
      const bytes = served.get(contentHash);
      // The real client throws a BlinkApiError with status 404 for content that is not stored.
      if (!bytes) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
      if (keccak256(bytes) !== contentHash) throw new Error("HASH_MISMATCH");
      return bytes;
    },
  };
  return { client, calls };
}

const day = (n: number) => FIRST + n * DAY;
const analysed = (scheduledAt: number, patch: Record<string, unknown> = {}): StubAnswer => ({
  note: bytesOf(noteFor(scheduledAt, patch)),
});
const AS_OF = day(40);

test("reads the latest closed windows and fetches only the notes of their answers", async () => {
  const { client, calls } = stubClient([
    { scheduledAt: day(1), answers: [analysed(day(1))] },
    {
      scheduledAt: day(2),
      answers: [
        analysed(day(2)),
        { forecaster: B, note: bytesOf(noteFor(day(2), { forecaster: B, salt: hash("b") })) },
      ],
    },
    { scheduledAt: day(3), status: "OPEN", answers: [analysed(day(3))] },
    { scheduledAt: day(4), status: "UPCOMING" },
  ]);
  const view = await getMarketFreshness(client, MARKET, { asOf: AS_OF });
  assert.deepEqual(
    view.windows.map((w) => w.scheduledAt),
    [day(1), day(2)],
  );
  assert.equal(view.lastAnsweredWindow, day(2));
  assert.equal(view.windowsBehind, 0);
  assert.equal(view.level, "CURRENT");
  assert.equal(view.asOf, AS_OF);
  assert.equal(view.ageSeconds, AS_OF - day(2));
  assert.equal(view.analysedAt, day(2));
  assert.equal(view.evidenceChangedAt, day(2) - 1780);
  // The open and the upcoming window are never read, and neither is their content.
  assert.deepEqual(calls.forecasts, ["win-0", "win-1"]);
  assert.equal(calls.content.length, 3);
});

test("pages to the latest windows of a market with 150 windows", async () => {
  const windows: StubWindow[] = Array.from({ length: 150 }, (_, i) => ({
    scheduledAt: day(i + 1),
    answers: [{ noContentHash: true }],
  }));
  windows.push({ scheduledAt: day(151), status: "OPEN" }, { scheduledAt: day(152), status: "UPCOMING" });
  const { client, calls } = stubClient(windows, { pageSize: 100 });
  const view = await getMarketFreshness(client, MARKET, { asOf: day(200) });
  assert.equal(view.windows.length, 30);
  assert.equal(view.windows[0]!.scheduledAt, day(121));
  assert.equal(view.windows[29]!.scheduledAt, day(150));
  assert.equal(view.lastAnsweredWindow, day(150));
  assert.equal(view.level, "CURRENT");
  assert.ok(calls.windows >= 2, "the second page of windows was read");
  assert.ok(calls.maxLimit <= 100);
  // Answers are read only for the windows that are kept.
  assert.equal(calls.forecasts.length, 30);
  assert.ok(!calls.forecasts.includes("win-0"));
  assert.ok(calls.forecasts.includes("win-149"));
});

test("the number of windows to keep can be set", async () => {
  const { client } = stubClient(
    Array.from({ length: 10 }, (_, i) => ({ scheduledAt: day(i + 1), answers: [{ noContentHash: true }] })),
  );
  const view = await getMarketFreshness(client, MARKET, { asOf: AS_OF, windows: 4 });
  assert.deepEqual(
    view.windows.map((w) => w.scheduledAt),
    [day(7), day(8), day(9), day(10)],
  );
  await assert.rejects(getMarketFreshness(client, MARKET, { windows: 0 }), RangeError);
  await assert.rejects(getMarketFreshness(client, MARKET, { notesPerWindow: -1 }), RangeError);
});

test("NO_CONTENT_HASH is never fetched and counts as an answer without a note", async () => {
  const { client, calls } = stubClient([
    { scheduledAt: day(1), answers: [{ noContentHash: true }, { noContentHash: true }] },
  ]);
  const view = await getMarketFreshness(client, MARKET, { asOf: AS_OF });
  assert.deepEqual(calls.content, []);
  assert.deepEqual(view.latestWindow, { answers: 2, analysed: 0, carried: 0, noNote: 2, unfetched: 0 });
  assert.equal(view.level, "CURRENT");
});

test("a missing note, a hash mismatch, an invalid note and a note for another window, market or forecaster each count as noNote and never throw", async () => {
  const S = day(5);
  const good = analysed(S);
  // Each note gets its own salt, so no two answers share a hash in the stub's store.
  let n = 3;
  const wrong = (patch: Record<string, unknown>): StubAnswer => ({
    note: bytesOf(noteFor(S, { salt: hash((n++).toString(16)), ...patch })),
  });
  const { client } = stubClient([
    {
      scheduledAt: S,
      answers: [
        good,
        {}, // the store has no such content: a 404
        { note: bytesOf(noteFor(S, { salt: hash("2") })), mismatch: true },
        { note: new TextEncoder().encode("not json at all") },
        { note: bytesOf({ ...noteFor(S, { salt: hash("1") }), extra: true }) },
        wrong({ scheduledAt: S - DAY }),
        wrong({ marketId: "8" }),
        wrong({ markets: "0x" + "99".repeat(20) }),
        wrong({ horizon: 1 }),
        // The answer is signed by A (the stub default); this note names B.
        wrong({ forecaster: B }),
      ],
    },
  ]);
  const view = await getMarketFreshness(client, MARKET, { asOf: AS_OF });
  assert.deepEqual(view.latestWindow, { answers: 10, analysed: 1, carried: 0, noNote: 9, unfetched: 0 });
});

test("at most notesPerWindow notes are fetched per window; the rest count as unfetched, not noNote", async () => {
  const S = day(5);
  const { client, calls } = stubClient([
    {
      scheduledAt: S,
      answers: [
        analysed(S, { salt: hash("1") }),
        { noContentHash: true },
        analysed(S, { salt: hash("2") }),
        analysed(S, { salt: hash("3") }),
        analysed(S, { salt: hash("4") }),
      ],
    },
  ]);
  const view = await getMarketFreshness(client, MARKET, { asOf: AS_OF, notesPerWindow: 2 });
  assert.equal(calls.content.length, 2);
  // The answer without a content hash is not fetched, but it is not over the limit either.
  assert.deepEqual(view.latestWindow, { answers: 5, analysed: 2, carried: 0, noNote: 1, unfetched: 2 });
  // The default limit is 20.
  const many = stubClient([
    {
      scheduledAt: S,
      answers: Array.from({ length: 25 }, (_, i) =>
        analysed(S, { salt: "0x" + i.toString(16).padStart(64, "0") }),
      ),
    },
  ]);
  const defaults = await getMarketFreshness(many.client, MARKET, { asOf: AS_OF });
  assert.equal(many.calls.content.length, 20);
  assert.equal(defaults.latestWindow.analysed, 20);
  assert.equal(defaults.latestWindow.unfetched, 5);
});

test("a cached note is not fetched again", async () => {
  const S = day(5);
  const { client, calls } = stubClient([{ scheduledAt: S, answers: [analysed(S)] }]);
  const cache = new Map<string, Uint8Array>();
  const first = await getMarketFreshness(client, MARKET, { asOf: AS_OF, cache });
  assert.equal(calls.content.length, 1);
  assert.equal(cache.size, 1);
  const second = await getMarketFreshness(client, MARKET, { asOf: AS_OF, cache });
  assert.equal(calls.content.length, 1);
  assert.deepEqual(second, first);
  // A note that could not be read is not cached.
  const bad = stubClient([{ scheduledAt: S, answers: [{}] }]);
  const emptyCache = new Map<string, Uint8Array>();
  await getMarketFreshness(bad.client, MARKET, { asOf: AS_OF, cache: emptyCache });
  assert.equal(emptyCache.size, 0);
});

test("windows without answers count toward windowsBehind", async () => {
  const { client, calls } = stubClient([
    { scheduledAt: day(1), answers: [analysed(day(1))] },
    { scheduledAt: day(2) },
    { scheduledAt: day(3) },
  ]);
  const view = await getMarketFreshness(client, MARKET, { asOf: day(3) + 60 });
  assert.equal(view.lastAnsweredWindow, day(1));
  assert.equal(view.windowsBehind, 2);
  assert.equal(view.level, "AGING");
  assert.equal(view.ageSeconds, 2 * DAY + 60);
  // A window that the consensus lists with no answers is not asked for its answers.
  assert.deepEqual(calls.forecasts, ["win-0"]);
  const stale = stubClient([
    { scheduledAt: day(1), answers: [analysed(day(1))] },
    { scheduledAt: day(2) },
    { scheduledAt: day(3) },
    { scheduledAt: day(4) },
  ]);
  assert.equal((await getMarketFreshness(stale.client, MARKET, { asOf: day(4) })).level, "STALE");
});

test("a market with no closed window reads NONE", async () => {
  const { client } = stubClient([{ scheduledAt: day(1), status: "OPEN" }]);
  const view = await getMarketFreshness(client, MARKET, { asOf: AS_OF });
  assert.equal(view.level, "NONE");
  assert.equal(view.lastAnsweredWindow, null);
  assert.deepEqual(view.windows, []);
});

test("the result equals computeFreshness over the same data", async () => {
  const S1 = day(1);
  const S2 = day(2);
  const carry = (s: number) => ({
    note: bytesOf(
      noteFor(s, { kind: "carry_forward" }, [
        { url: SOURCE, status: "UNCHANGED", since: null, observedAt: s - 1780, fingerprint: hash("f"), snapshot: null, note: "" },
      ]),
    ),
  });
  const { client } = stubClient([
    { scheduledAt: S1, answers: [analysed(S1)] },
    { scheduledAt: S2, answers: [carry(S2), { noContentHash: true }] },
  ]);
  const view = await getMarketFreshness(client, MARKET, { asOf: AS_OF });
  const expected = (answers: WindowAnswer[][]) =>
    answers.map((a, i) =>
      summarizeWindow(a, { scheduledAt: i === 0 ? S1 : S2, openAt: (i === 0 ? S1 : S2) - 1800 }),
    );
  const parse = (bytes: Uint8Array) => {
    const result = parseForecastNote(bytes);
    assert.ok(result.ok);
    return result.note;
  };
  const windows = expected([
    [{ note: parse(analysed(S1).note!), noteState: "read", receivedAt: S1 - 1700 }],
    [
      { note: parse(carry(S2).note), noteState: "read", receivedAt: S2 - 1700 },
      { note: null, noteState: "none", receivedAt: S2 - 1699 },
    ],
  ]);
  assert.deepEqual(view.windows, windows);
  const { windows: _windows, ...summary } = view;
  assert.deepEqual(summary, computeFreshness(windows, AS_OF));
  // The shipped note belongs to the answer it was read for.
  assert.ok(
    noteBelongsTo(parse(analysed(S1).note!), {
      marketId: MARKET,
      markets: MARKETS,
      forecaster: A,
      horizon: 0,
      scheduledAt: S1,
    }),
  );
});

test("a withdrawn answer is ignored", async () => {
  const S = day(5);
  const { client, calls } = stubClient([
    { scheduledAt: S, answers: [{ ...analysed(S), withdrawnAt: S - 1000 }] },
    { scheduledAt: day(6), answers: [{ ...analysed(day(6)), withdrawnAt: day(6) - 1000 }, analysed(day(6), { salt: hash("9") })] },
  ]);
  const view = await getMarketFreshness(client, MARKET, { asOf: AS_OF });
  // The first window has no counted answer at all; the second counts one of its two.
  assert.equal(view.windows[0]!.answers, 0);
  assert.equal(view.windows[1]!.answers, 1);
  assert.equal(view.lastAnsweredWindow, day(6));
  assert.equal(calls.content.length, 1);
});

test("windows with the same scheduledAt are one window", async () => {
  const S = day(5);
  const { client } = stubClient([
    { scheduledAt: S, horizon: 0, answers: [analysed(S)] },
    { scheduledAt: S, horizon: 1, answers: [analysed(S, { horizon: 1 })] },
  ]);
  const view = await getMarketFreshness(client, MARKET, { asOf: AS_OF });
  assert.equal(view.windows.length, 1);
  assert.deepEqual(view.latestWindow, { answers: 2, analysed: 2, carried: 0, noNote: 0, unfetched: 0 });
});

test("a stuck cursor does not loop forever", async () => {
  const { client } = stubClient([{ scheduledAt: day(1), answers: [{ noContentHash: true }] }]);
  const stuck: FreshnessClient = {
    ...client,
    listForecastWindows: async () => ({
      items: [
        { windowId: "win-0", horizon: 0, scheduledAt: day(1), openAt: day(1) - 1800, status: "CLOSED" },
      ],
      nextCursor: "same",
    }),
  };
  await assert.rejects(getMarketFreshness(stuck, MARKET, { asOf: AS_OF }), /CURSOR/);
});

const failure = (status?: number) =>
  status === undefined
    ? new TypeError("fetch failed")
    : Object.assign(new Error("UNAVAILABLE"), { status });

test("a failing content route (503, 429, network error) rejects and caches nothing for it", async () => {
  for (const error of [failure(503), failure(429), failure()]) {
    const S = day(5);
    const { client } = stubClient([{ scheduledAt: S, answers: [analysed(S)] }]);
    const cache = new Map<string, Uint8Array>();
    const broken: FreshnessClient = {
      ...client,
      getContent: async () => {
        throw error;
      },
    };
    await assert.rejects(getMarketFreshness(broken, MARKET, { asOf: AS_OF, cache }), error);
    assert.equal(cache.size, 0);
  }
});

test("a second call with the same cache resumes and fetches only the missing notes", async () => {
  const S = day(5);
  const { client, calls } = stubClient([
    {
      scheduledAt: S,
      answers: [
        analysed(S, { salt: hash("1") }),
        analysed(S, { salt: hash("2") }),
        analysed(S, { salt: hash("3") }),
      ],
    },
  ]);
  const cache = new Map<string, Uint8Array>();
  let failing: string | null = null;
  const flaky: FreshnessClient = {
    ...client,
    getContent: async (contentHash) => {
      if (contentHash === failing) throw failure(503);
      return client.getContent(contentHash);
    },
  };
  // The third answer's note is the one that fails on the first call.
  const probe = await client.listForecasts(
    { marketId: MARKET },
    { windowId: "win-0" },
  );
  failing = probe.items[2]!.contentHash;
  calls.content.length = 0;
  await assert.rejects(getMarketFreshness(flaky, MARKET, { asOf: AS_OF, cache }), /UNAVAILABLE/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!cache.has(failing));
  const cached = new Set(cache.keys());
  calls.content.length = 0;
  failing = null;
  const view = await getMarketFreshness(flaky, MARKET, { asOf: AS_OF, cache });
  assert.deepEqual(view.latestWindow, { answers: 3, analysed: 3, carried: 0, noNote: 0, unfetched: 0 });
  assert.ok(calls.content.includes(probe.items[2]!.contentHash));
  for (const fetched of calls.content) assert.ok(!cached.has(fetched), "a cached note was fetched again");
});

test("bytes that do not hash to their key are not used, whether fetched or cached", async () => {
  const S = day(5);
  const { client, calls } = stubClient([{ scheduledAt: S, answers: [analysed(S)] }]);
  const key = keccak256(analysed(S).note!);
  // A poisoned cache: a valid note for this answer would be read if the bytes were not checked.
  const poisoned = new Map<string, Uint8Array>([[key, bytesOf(noteFor(S, { salt: hash("9") }))]]);
  const view = await getMarketFreshness(client, MARKET, { asOf: AS_OF, cache: poisoned });
  assert.deepEqual(view.latestWindow, { answers: 1, analysed: 0, carried: 0, noNote: 1, unfetched: 0 });
  assert.deepEqual(calls.content, []);
  // A custom client that returns bytes without checking them.
  const lying: FreshnessClient = {
    ...client,
    getContent: async () => bytesOf(noteFor(S, { salt: hash("9") })),
  };
  const fresh = new Map<string, Uint8Array>();
  const other = await getMarketFreshness(lying, MARKET, { asOf: AS_OF, cache: fresh });
  assert.equal(other.latestWindow.noNote, 1);
  assert.equal(fresh.size, 0);
});

test("at most 8 notes are fetched at the same time", async () => {
  const S = day(5);
  const { client } = stubClient([
    {
      scheduledAt: S,
      answers: Array.from({ length: 20 }, (_, i) =>
        analysed(S, { salt: "0x" + i.toString(16).padStart(64, "0") }),
      ),
    },
  ]);
  let inFlight = 0;
  let max = 0;
  const counting: FreshnessClient = {
    ...client,
    getContent: async (contentHash) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      try {
        return await client.getContent(contentHash);
      } finally {
        inFlight--;
      }
    },
  };
  const view = await getMarketFreshness(counting, MARKET, { asOf: AS_OF });
  assert.equal(view.latestWindow.analysed, 20);
  assert.ok(max > 1 && max <= 8, "in flight at most: " + max);
});

test("a failing window, consensus or answers route rejects", async () => {
  const S = day(5);
  const { client } = stubClient([{ scheduledAt: S, answers: [analysed(S)] }]);
  const boom = failure(503);
  for (const name of ["getDeployment", "listForecastWindows", "getConsensus", "listForecasts"] as const) {
    const broken: FreshnessClient = {
      ...client,
      [name]: async () => {
        throw boom;
      },
    };
    await assert.rejects(getMarketFreshness(broken, MARKET, { asOf: AS_OF }), boom, name);
  }
});

test("asOf must be a whole number of seconds that is not negative", async () => {
  const { client } = stubClient([{ scheduledAt: day(1), answers: [{ noContentHash: true }] }]);
  for (const asOf of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    await assert.rejects(getMarketFreshness(client, MARKET, { asOf }), RangeError, String(asOf));
  assert.equal((await getMarketFreshness(client, MARKET, { asOf: 0 })).asOf, 0);
});
