import assert from "node:assert/strict";
import { mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { keccak256, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BlinkApiError,
  FORECAST_NOTE_MAX_BYTES,
  NO_CONTENT_HASH,
  forecastDigest,
  forecastTypedData,
  noteBelongsTo,
  parseForecastNote,
  type ForecastNote,
} from "../packages/client/src/index.ts";
import type { AgentContext } from "../examples/agents/src/lib/env.ts";
import type { SourceFetcher } from "../examples/agents/src/lib/fetcher.ts";
import { fixtureFetcher, isCanonicalHttpsUrl } from "../examples/agents/src/lib/fetcher.ts";
import { createLogger } from "../examples/agents/src/lib/log.ts";
import type { Model } from "../examples/agents/src/lib/model.ts";
import { loadState, saveState } from "../examples/agents/src/lib/state.ts";
import { agentParts } from "../examples/agents/src/main.ts";
import { buildNote } from "../examples/agents/src/lib/note.ts";
import {
  MAX_MARKETS_WORKED_PER_TICK,
  createForecaster,
  forecaster as defaultForecaster,
} from "../examples/agents/src/roles/forecaster.ts";

// The forecaster is driven in process: a stub API, a scripted fetcher, a counting model and a clock
// that the test moves. No test opens a socket, and none mocks timers (`checkSources` yields with
// `setImmediate`, which a timer mock would freeze).

const DAY = 86_400;
const BASE = 1_800_000_000;
const ANCHOR = ("0x" + "aa".repeat(20)) as Hex;
const MARKETS = ("0x" + "bb".repeat(20)) as Hex;
const SPEC_HASH = ("0x" + "cc".repeat(32)) as Hex;
const account = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
const utf8 = (text: string) => new TextEncoder().encode(text);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "blink-forecaster-events-"));
  dirs.push(dir);
  return dir;
}

type Win = {
  windowId: string;
  horizon: 0;
  horizonType: "DAILY";
  scheduledAt: number;
  openAt: number;
  deadline: number;
  status: "UPCOMING" | "OPEN" | "CLOSED";
  root: null;
  rootAt: null;
};
type Submission = {
  submissionId: string;
  windowId: string;
  forecaster: string;
  probabilityBps: number;
  contentHash: Hex;
  digest: Hex;
  leaf: Hex;
  signature: Hex;
  verifiedBlock: number;
  receivedAt: number;
  withdrawnAt: null;
};
type Line = { event: string; [field: string]: unknown };

const apiError = (status: number, code: string) =>
  new BlinkApiError(status, { code, message: "m", requestId: "r", retryable: false, details: {} } as never);

/** The platform as the forecaster sees it: markets with windows, a content store and the answers. */
class Platform {
  markets = new Map<string, { sources: string[]; windows: Win[] }>();
  contents = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  submissions: Submission[] = [];
  submitBodies: Record<string, unknown>[] = [];
  /** Every cursor the agent passed to `listForecastWindows`, with the market. */
  windowReads: { marketId: string; cursor: string | undefined }[] = [];
  uploads: { hash: Hex; mediaType: string; size: number }[] = [];
  /** Throws to make the next call fail; runs before the call takes effect. */
  beforeUpload: ((bytes: Uint8Array, mediaType: string) => void) | undefined;
  /** Runs after a submission is stored, before the answer goes back: a lost response throws here. */
  afterSubmitStored: (() => void) | undefined;
  beforeSubmit: (() => void) | undefined;
  beforeListWindows: ((marketId: string) => void) | undefined;
  beforeGetWindow: ((windowId: string) => void) | undefined;
  now = BASE;

  addMarket(id: string, sources: string[], statuses: Win["status"][]) {
    this.markets.set(id, {
      sources,
      windows: statuses.map((status, i) => ({
        windowId: `${id}-w${i}`,
        horizon: 0,
        horizonType: "DAILY",
        scheduledAt: BASE + (i + 1) * DAY,
        openAt: BASE + (i + 1) * DAY - 1800,
        deadline: BASE + (i + 1) * DAY,
        status,
        root: null,
        rootAt: null,
      })),
    });
  }
  /** Window `index` is the only open one; every earlier window is closed and later ones are upcoming. */
  openOnly(id: string, index: number) {
    this.markets.get(id)!.windows.forEach((w, i) => (w.status = i < index ? "CLOSED" : i === index ? "OPEN" : "UPCOMING"));
  }
  setStatus(id: string, index: number, status: Win["status"]) {
    this.markets.get(id)!.windows[index]!.status = status;
  }
  archive = new Map<string, { sources: string[]; windows: Win[] }>();
  window(windowId: string) {
    for (const [, m] of [...this.markets, ...this.archive]) for (const w of m.windows) if (w.windowId === windowId) return w;
    throw apiError(404, "NOT_FOUND");
  }
  /** The market leaves the OPEN list; its windows stay readable by id. */
  closeMarket(id: string) {
    this.archive.set(id, this.markets.get(id)!);
    this.markets.delete(id);
  }

  client() {
    const self = this;
    return {
      async listMarkets() {
        return {
          items: [...self.markets.entries()].map(([marketId, m]) => ({
            market: { marketId, specHash: SPEC_HASH },
            spec: { ok: true, spec: { title: `Market ${marketId}`, sources: m.sources } },
          })),
          next: null,
        };
      },
      async listForecastWindows(ref: { marketId: string }, page: { limit?: number; cursor?: string } = {}) {
        self.beforeListWindows?.(ref.marketId);
        self.windowReads.push({ marketId: ref.marketId, cursor: page.cursor });
        const known = self.markets.get(ref.marketId) ?? self.archive.get(ref.marketId);
        if (!known) throw apiError(404, "NOT_FOUND");
        const all = known.windows;
        const from = page.cursor === undefined ? 0 : Number(/^cur:(\d+)$/.exec(page.cursor)?.[1] ?? Number.NaN);
        if (!Number.isInteger(from)) throw apiError(400, "INVALID_CURSOR");
        const limit = page.limit ?? 20;
        return { items: all.slice(from, from + limit), nextCursor: from + limit < all.length ? `cur:${from + limit}` : null };
      },
      async getForecastWindow(ref: { windowId: string }) {
        self.beforeGetWindow?.(ref.windowId);
        return { ...self.window(ref.windowId), marketId: "x", leaves: [], anchor: null, index: {} };
      },
      async listForecasts(_ref: unknown, query: { windowId: string }) {
        return { items: self.submissions.filter((s) => s.windowId === query.windowId), nextCursor: null };
      },
      async uploadContent(bytes: Uint8Array, mediaType: string) {
        self.beforeUpload?.(bytes, mediaType);
        const hash = keccak256(bytes);
        self.contents.set(hash, { bytes, mediaType });
        self.uploads.push({ hash, mediaType, size: bytes.length });
        return { hash, size: bytes.length, mediaType, uri: "u" };
      },
      async submitForecast(ref: { marketId: string }, input: Record<string, unknown>) {
        self.beforeSubmit?.();
        self.submitBodies.push(input);
        const window = self.markets.get(ref.marketId)!.windows.find((w) => w.scheduledAt === input.scheduledAt)!;
        const message = {
          forecaster: account.address,
          markets: MARKETS,
          marketId: ref.marketId,
          horizon: input.horizon as 0 | 1,
          scheduledAt: input.scheduledAt as number,
          probabilityBps: input.probabilityBps as number,
          contentHash: input.contentHash as Hex,
        };
        const valid = await verifyTypedData({
          address: account.address,
          ...forecastTypedData({ anchor: ANCHOR, message }),
          signature: input.signature as Hex,
        });
        if (!valid) throw apiError(400, "INVALID_FORECAST_SIGNATURE");
        const digest = forecastDigest({ anchor: ANCHOR, message });
        const taken = self.submissions.find((s) => s.windowId === window.windowId);
        if (taken && taken.digest !== digest) throw apiError(409, "FORECAST_ALREADY_SUBMITTED");
        if (!taken) {
          self.submissions.push({
            submissionId: `s${self.submissions.length}`,
            windowId: window.windowId,
            forecaster: account.address.toLowerCase(),
            probabilityBps: message.probabilityBps,
            contentHash: message.contentHash,
            digest,
            leaf: digest,
            signature: input.signature as Hex,
            verifiedBlock: 1,
            receivedAt: self.now,
            withdrawnAt: null,
          });
          self.afterSubmitStored?.();
        }
        return { digest, leaf: digest };
      },
    };
  }
}

type Beliefs = { probabilityBps: number | null; summary?: string };
type ReviseInput = Parameters<NonNullable<Model["revise"]>>[1];
/** A model that counts what it is asked. Its watch list is the spec's, as for a model without one. */
function countingModel(beliefs: Beliefs = { probabilityBps: 6000, summary: "reviewed" }) {
  const calls: { at: number; input: ReviseInput }[] = [];
  const model: Model & { calls: typeof calls; beliefs: Beliefs; failWith?: Error; clock: { ms: number } } = {
    calls,
    beliefs,
    clock: { ms: 0 },
    questions: async () => [],
    fromSuggestion: async () => null,
    probabilityBps: async () => null,
    outcome: async () => null,
    creationObjection: async () => null,
    appeal: async () => false,
    async revise(_m, input) {
      calls.push({ at: Math.floor(model.clock.ms / 1000), input });
      if (model.failWith) throw model.failWith;
      return model.beliefs.probabilityBps === null
        ? null
        : { probabilityBps: model.beliefs.probabilityBps, summary: model.beliefs.summary ?? "" };
    },
  };
  return model;
}

/** Pages whose fetch the test controls: the bytes and media type of each URL, and every fetch counted. */
function scriptedSources(initial: Record<string, { body: string | Uint8Array; mediaType?: string }> = {}) {
  const pages = new Map(Object.entries(initial));
  const fetches: string[] = [];
  const failures = new Map<string, string>();
  const fetcher: SourceFetcher = async (url) => {
    fetches.push(url);
    const failure = failures.get(url);
    if (failure) return { status: "error", code: failure };
    const page = pages.get(url);
    if (!page) return { status: "error", code: "NOT_IN_WORLD" };
    return {
      status: 200,
      bytes: typeof page.body === "string" ? utf8(page.body) : page.body,
      mediaType: page.mediaType ?? "text/html",
      finalUrl: url,
    };
  };
  return {
    fetcher,
    fetches,
    failures,
    set: (url: string, body: string | Uint8Array, mediaType = "text/html") => pages.set(url, { body, mediaType }),
  };
}

const URL_A = "https://a.example/report";
const URL_B = "https://b.example/feed";

function harness(options: {
  platform: Platform;
  stateDir: string;
  model?: ReturnType<typeof countingModel> | Model;
  fetcher?: SourceFetcher;
  heartbeatSeconds?: number | undefined;
  clock?: { ms: number };
}) {
  const clock = options.clock ?? { ms: (BASE + 100) * 1000 };
  const lines: Line[] = [];
  const model = options.model ?? countingModel();
  if ("clock" in model) (model as ReturnType<typeof countingModel>).clock = clock;
  const build = async () => {
    const data = await loadState(options.stateDir);
    const ctx = {
      name: "forecaster",
      roles: ["forecaster"],
      apiUrl: "http://127.0.0.1:1",
      client: options.platform.client(),
      publicClient: {},
      walletClient: { signTypedData: (request: never) => account.signTypedData(request) },
      account,
      deployment: { generation: { markets: MARKETS }, shared: { anchor: ANCHOR } },
      model,
      fetcher: options.fetcher ?? (async () => ({ status: "error", code: "NOT_IN_WORLD" }) as const),
      heartbeatSeconds: options.heartbeatSeconds ?? 14 * DAY,
      stateDir: options.stateDir,
      state: { data, save: () => saveState(options.stateDir, data) },
      log: createLogger("forecaster", [], (line) => lines.push(JSON.parse(line) as Line)),
    } as unknown as AgentContext;
    return ctx;
  };
  let tickFn = createForecaster({ now: () => clock.ms });
  let ctx: AgentContext;
  const api = {
    clock,
    lines,
    model,
    stateDir: options.stateDir,
    get ctx() {
      return ctx;
    },
    async start() {
      ctx = await build();
    },
    /** One tick. */
    tick: () => tickFn(ctx),
    /** A process restart: a new context from the saved state, and a new forecaster with no memory. */
    async restart() {
      tickFn = createForecaster({ now: () => clock.ms });
      ctx = await build();
    },
    at(seconds: number) {
      clock.ms = seconds * 1000;
    },
    events: (name: string) => lines.filter((l) => l.event === name),
    state: () => loadState(options.stateDir),
  };
  return api;
}
async function started(options: Parameters<typeof harness>[0]) {
  const h = harness(options);
  await h.start();
  return h;
}

/** The note a stored answer points to, parsed. */
function noteOf(platform: Platform, submission: Submission): ForecastNote {
  const stored = platform.contents.get(submission.contentHash);
  assert.ok(stored, "the note was uploaded");
  assert.equal(keccak256(stored.bytes), submission.contentHash);
  const parsed = parseForecastNote(stored.bytes);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  return parsed.note;
}
const openAt = (index: number) => BASE + (index + 1) * DAY - 1800;
/** The time of the tick that answers window `index`. */
const tickTime = (index: number) => openAt(index) + 100;
const subjectOf = (platform: Platform, marketId: string, index: number) => {
  const w = platform.markets.get(marketId)!.windows[index]!;
  return { marketId, markets: MARKETS, forecaster: account.address, horizon: w.horizon, scheduledAt: w.scheduledAt };
};

/** One market with `windows` windows, window 0 open, and the page behind `url`. */
async function oneMarket(opts: { sources?: string[]; windows?: number; model?: ReturnType<typeof countingModel>; heartbeatSeconds?: number; pages?: Record<string, { body: string }> } = {}) {
  const platform = new Platform();
  const sources = opts.sources ?? [URL_A];
  platform.addMarket("1", sources, Array.from({ length: opts.windows ?? 4 }, (_, i) => (i === 0 ? "OPEN" : "UPCOMING")));
  const pages = scriptedSources(opts.pages ?? { [URL_A]: { body: "<p>first</p>" } });
  const model = opts.model ?? countingModel();
  const h = await started({ platform, stateDir: await tempDir(), model, fetcher: pages.fetcher, heartbeatSeconds: opts.heartbeatSeconds });
  h.at(tickTime(0));
  platform.now = tickTime(0);
  /** Moves to window `index`: closes the one before, opens this one and moves the clock. */
  const goTo = (index: number) => {
    platform.openOnly("1", index);
    h.at(tickTime(index));
    platform.now = tickTime(index);
  };
  return { platform, pages, model, h, goTo };
}

// -- The plan's tests ---------------------------------------------------------------------------

test("first window: a cold start runs one analysis, uploads a salted analysis note and signs its hash", async () => {
  const { platform, model, h } = await oneMarket();
  await h.tick();
  assert.equal(model.calls.length, 1);
  assert.equal(platform.submissions.length, 1);
  const answer = platform.submissions[0]!;
  assert.equal(answer.probabilityBps, 6000);
  assert.notEqual(answer.contentHash, NO_CONTENT_HASH);
  const note = noteOf(platform, answer);
  assert.equal(note.kind, "analysis");
  assert.equal(note.prior, null);
  assert.equal(note.summary, "reviewed");
  assert.match(note.salt, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(note.evidence.map((e) => [e.url, e.status, e.since, e.snapshot]), [[URL_A, "NEW", null, null]]);
  const window = platform.markets.get("1")!.windows[0]!;
  assert.equal(
    noteBelongsTo(note, { marketId: "1", markets: MARKETS, forecaster: account.address, horizon: 0, scheduledAt: window.scheduledAt }),
    true,
  );
  assert.equal(platform.uploads[0]!.mediaType, "application/json");
  const decision = h.events("forecast_decision")[0]!;
  assert.deepEqual(
    { action: decision.action, reason: decision.reason, checked: decision.checked, changed: decision.changed, unreachable: decision.unreachable },
    { action: "analyse", reason: "cold_start", checked: 1, changed: 0, unreachable: 0 },
  );
  const submitted = h.events("forecast_submitted")[0]!;
  assert.equal(submitted.kind, "analysis");
  assert.equal(submitted.contentHash, answer.contentHash);
  const state = await h.state();
  assert.equal(state.watch!["1"]!.prior!.digest, answer.digest);
  assert.equal(state.watch!["1"]!.prior!.analysedAt, tickTime(0));
  assert.equal(state.watch!["1"]!.intent, undefined);
  assert.deepEqual(state.acted["forecaster.submitted"], [window.windowId]);
});

test("second window with every source unchanged: zero model calls, a carry-forward note naming the prior digest, the same probability", async () => {
  const { platform, model, goTo, h } = await oneMarket();
  await h.tick();
  goTo(1);
  await h.tick();
  assert.equal(model.calls.length, 1, "no second analysis");
  assert.equal(platform.submissions.length, 2);
  const [first, second] = platform.submissions as [Submission, Submission];
  assert.equal(second.probabilityBps, first.probabilityBps);
  const note = noteOf(platform, second);
  assert.equal(note.kind, "carry_forward");
  assert.deepEqual(note.prior, { digest: first.digest });
  assert.deepEqual(note.evidence.map((e) => e.status), ["UNCHANGED"]);
  assert.equal(h.events("forecast_decision")[1]!.action, "carry_forward");
  assert.equal(h.events("forecast_submitted")[1]!.kind, "carry_forward");
});

test("two carry-forward notes built from identical inputs have different hashes", async () => {
  const { platform, goTo, h } = await oneMarket();
  await h.tick();
  goTo(1);
  await h.tick();
  goTo(2);
  await h.tick();
  const [, second, third] = platform.submissions as [Submission, Submission, Submission];
  const a = noteOf(platform, second);
  const b = noteOf(platform, third);
  assert.notEqual(second.contentHash, third.contentHash);
  assert.notEqual(a.salt, b.salt);
  // Everything but the salt, the prior, the time and the window is what an observer could guess.
  assert.deepEqual(a.evidence, b.evidence.map((e) => ({ ...e, observedAt: a.evidence[0]!.observedAt })));
});

test("a changed source: one analysis; the note lists the CHANGED item with since and observedAt; the snapshot hash is in the note", async () => {
  const { platform, pages, model, goTo, h } = await oneMarket();
  await h.tick();
  pages.set(URL_A, "<p>second, different</p>");
  goTo(1);
  await h.tick();
  assert.equal(model.calls.length, 2);
  const change = model.calls[1]!.input.changes;
  assert.deepEqual(change.map((c) => [c.url, c.status, c.since, c.observedAt, c.mediaType]), [[URL_A, "CHANGED", tickTime(0), tickTime(1), "text/html"]]);
  assert.equal(text(change[0]!.bytes), "<p>second, different</p>");
  assert.deepEqual(model.calls[1]!.input.prior, { probabilityBps: 6000, analysedAt: tickTime(0) });
  const note = noteOf(platform, platform.submissions[1]!);
  assert.equal(note.kind, "analysis");
  const item = note.evidence[0]!;
  assert.equal(item.status, "CHANGED");
  assert.equal(item.since, tickTime(0));
  assert.equal(item.observedAt, tickTime(1));
  const hash = keccak256(utf8("<p>second, different</p>"));
  assert.equal(item.snapshot, hash);
  const state = await h.state();
  assert.deepEqual(state.watch!["1"]!.pendingSnapshots, [{ hash, mediaType: "text/html", windowId: "1-w1" }]);
  assert.equal(text(await readFile(join(h.stateDir, "snapshots", hash))), "<p>second, different</p>");
  assert.equal(h.events("forecast_decision")[1]!.reason, "change");
  assert.equal(h.events("forecast_decision")[1]!.changed, 1);
});

test("no snapshot is uploaded before the API lists the window as CLOSED, and it is uploaded after", async () => {
  const { platform, pages, goTo, h } = await oneMarket();
  await h.tick();
  pages.set(URL_A, "<p>changed</p>");
  goTo(1);
  await h.tick();
  const hash = keccak256(utf8("<p>changed</p>"));
  assert.equal(platform.contents.has(hash), false);
  await h.tick();
  h.at(tickTime(1) + 600);
  await h.tick();
  assert.equal(platform.contents.has(hash), false, "still open: nothing uploaded");
  platform.setStatus("1", 1, "CLOSED");
  h.at(tickTime(1) + 700);
  await h.tick();
  assert.deepEqual(platform.contents.get(hash), { bytes: utf8("<p>changed</p>"), mediaType: "text/html" });
  const state = await h.state();
  assert.equal(state.watch!["1"]!.pendingSnapshots, undefined);
  await assert.rejects(stat(join(h.stateDir, "snapshots", hash)), { code: "ENOENT" });
});

test("a source in an unaccepted media type or over 1 MiB gets snapshot null in the note and a snapshot_skipped line", async () => {
  const big = new Uint8Array(1_048_576 + 1).fill(97);
  const exact = new Uint8Array(1_048_576).fill(98);
  const { platform, pages, goTo, h } = await oneMarket({
    sources: [URL_A, URL_B, "https://c.example/big", "https://d.example/exact"],
    pages: { [URL_A]: { body: "x" }, [URL_B]: { body: "x" }, "https://c.example/big": { body: "x" }, "https://d.example/exact": { body: "x" } },
  });
  await h.tick();
  pages.set(URL_B, "<feed>new</feed>", "application/rss+xml");
  pages.set("https://c.example/big", big, "text/plain");
  pages.set("https://d.example/exact", exact, "text/plain");
  pages.set(URL_A, "<p>ok</p>");
  goTo(1);
  await h.tick();
  const note = noteOf(platform, platform.submissions[1]!);
  const bySource = Object.fromEntries(note.evidence.map((e) => [e.url, e]));
  assert.equal(bySource[URL_A]!.snapshot, keccak256(utf8("<p>ok</p>")));
  assert.equal(bySource[URL_B]!.snapshot, null);
  assert.equal(bySource["https://c.example/big"]!.snapshot, null);
  assert.equal(bySource["https://d.example/exact"]!.snapshot, keccak256(exact), "exactly 1 MiB is kept");
  const skipped = h.events("snapshot_skipped");
  assert.deepEqual(skipped.map((l) => [l.reason]).sort(), [["MEDIA_TYPE"], ["TOO_LARGE"]]);
  assert.ok(!JSON.stringify(skipped).includes("<feed>"));
});

/** A window-2 change whose snapshot is pending, ready for the upload tests. */
async function withPendingSnapshot() {
  const ctx = await oneMarket();
  await ctx.h.tick();
  ctx.pages.set(URL_A, "<p>changed</p>");
  ctx.goTo(1);
  await ctx.h.tick();
  const hash = keccak256(utf8("<p>changed</p>"));
  ctx.platform.setStatus("1", 1, "CLOSED");
  return { ...ctx, hash, deadline: ctx.platform.markets.get("1")!.windows[1]!.deadline };
}

test("after the deadline, a snapshot refused with a 4xx other than 429 is logged as snapshot_upload_failed and dropped with its file; a 429, a 5xx or a network error keeps it and retries at most once a minute; the submitted answer is unchanged", async () => {
  const permanent = await withPendingSnapshot();
  permanent.platform.beforeUpload = (_bytes, mediaType) => {
    if (mediaType === "text/html") throw apiError(415, "UNSUPPORTED_MEDIA_TYPE");
  };
  const answers = JSON.stringify(permanent.platform.submissions);
  await permanent.h.tick();
  const failed = permanent.h.events("snapshot_upload_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.code, "UNSUPPORTED_MEDIA_TYPE");
  assert.equal(failed[0]!.status, 415);
  assert.equal((await permanent.h.state()).watch!["1"]!.pendingSnapshots, undefined);
  await assert.rejects(stat(join(permanent.h.stateDir, "snapshots", permanent.hash)), { code: "ENOENT" });
  permanent.h.at(permanent.deadline + 300);
  await permanent.h.tick();
  assert.equal(permanent.h.events("snapshot_upload_failed").length, 1, "not retried");
  assert.equal(JSON.stringify(permanent.platform.submissions), answers);

  for (const failure of [apiError(429, "RATE_LIMITED"), apiError(503, "INDEX_STALE"), apiError(500, "INTERNAL"), new TypeError("fetch failed")]) {
    const transient = await withPendingSnapshot();
    let attempts = 0;
    transient.platform.beforeUpload = (_bytes, mediaType) => {
      if (mediaType !== "text/html") return;
      attempts++;
      throw failure;
    };
    transient.h.at(transient.deadline + 10);
    await transient.h.tick();
    assert.equal(attempts, 1);
    transient.h.at(transient.deadline + 40);
    await transient.h.tick();
    transient.h.at(transient.deadline + 69);
    await transient.h.tick();
    assert.equal(attempts, 1, "at most once a minute");
    transient.h.at(transient.deadline + 70);
    await transient.h.tick();
    assert.equal(attempts, 2);
    assert.equal(transient.h.events("snapshot_upload_failed").length, 0, "a transient failure is not final");
    assert.equal((await transient.h.state()).watch!["1"]!.pendingSnapshots!.length, 1);
    await stat(join(transient.h.stateDir, "snapshots", transient.hash));
    // It recovers: the next try after a minute works.
    transient.platform.beforeUpload = undefined;
    transient.h.at(transient.deadline + 130);
    await transient.h.tick();
    assert.equal(transient.platform.contents.has(transient.hash), true);
  }
});

test("a missing snapshot file and a HASH_MISMATCH are logged and dropped, not retried; a 503 is retried at most once a minute and given up 24 hours after the deadline with code GAVE_UP", async () => {
  const missing = await withPendingSnapshot();
  await rm(join(missing.h.stateDir, "snapshots", missing.hash));
  await missing.h.tick();
  assert.equal(missing.h.events("snapshot_upload_failed")[0]!.code, "SNAPSHOT_FILE_MISSING");
  assert.equal((await missing.h.state()).watch!["1"]!.pendingSnapshots, undefined);
  assert.equal(missing.platform.uploads.filter((u) => u.mediaType === "text/html").length, 0);

  const wrong = await withPendingSnapshot();
  await writeFile(join(wrong.h.stateDir, "snapshots", wrong.hash), "other bytes");
  await wrong.h.tick();
  assert.equal(wrong.h.events("snapshot_upload_failed")[0]!.code, "HASH_MISMATCH");
  assert.equal(wrong.platform.uploads.filter((u) => u.mediaType === "text/html").length, 0, "nothing was sent");
  await assert.rejects(stat(join(wrong.h.stateDir, "snapshots", wrong.hash)), { code: "ENOENT" });

  const echo = await withPendingSnapshot();
  echo.platform.beforeUpload = () => {
    throw new Error("HASH_MISMATCH");
  };
  await echo.h.tick();
  assert.equal(echo.h.events("snapshot_upload_failed")[0]!.code, "HASH_MISMATCH", "the client's own check of the answer is final");

  const late = await withPendingSnapshot();
  let attempts = 0;
  late.platform.beforeUpload = (_bytes, mediaType) => {
    if (mediaType !== "text/html") return;
    attempts++;
    throw apiError(503, "INDEX_STALE");
  };
  late.h.at(late.deadline + 10);
  await late.h.tick();
  late.h.at(late.deadline + 86_400 - 1);
  await late.h.tick();
  assert.equal(late.h.events("snapshot_upload_failed").length, 0, "kept until 24 hours after the deadline");
  late.h.at(late.deadline + 86_400);
  await late.h.tick();
  const gaveUp = late.h.events("snapshot_upload_failed");
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0]!.code, "GAVE_UP");
  assert.equal((await late.h.state()).watch!["1"]!.pendingSnapshots, undefined);
  await assert.rejects(stat(join(late.h.stateDir, "snapshots", late.hash)), { code: "ENOENT" });
  const before = attempts;
  late.h.at(late.deadline + 86_400 + 120);
  await late.h.tick();
  assert.equal(attempts, before, "dropped for good");
});

test("dropping an intent also drops its pendingSnapshots and their files", async () => {
  const { platform, pages, goTo, h } = await oneMarket();
  await h.tick();
  pages.set(URL_A, "<p>changed</p>");
  goTo(1);
  // The note never reaches the platform, so the intent stays saved with its snapshot.
  platform.beforeUpload = (_bytes, mediaType) => {
    if (mediaType === "application/json") throw new TypeError("fetch failed");
  };
  await h.tick();
  const hash = keccak256(utf8("<p>changed</p>"));
  const saved = await h.state();
  assert.ok(saved.watch!["1"]!.intent);
  assert.equal(saved.watch!["1"]!.pendingSnapshots!.length, 1);
  await stat(join(h.stateDir, "snapshots", hash));
  // The window closes while the agent is down, and no answer of its own exists.
  platform.setStatus("1", 1, "CLOSED");
  await h.restart();
  await h.tick();
  const dropped = h.events("intent_dropped");
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]!.windowId, "1-w1");
  const after = await h.state();
  assert.equal(after.watch!["1"]!.intent, undefined);
  assert.equal(after.watch!["1"]!.pendingSnapshots, undefined);
  await assert.rejects(stat(join(h.stateDir, "snapshots", hash)), { code: "ENOENT" });
  assert.equal(platform.contents.has(hash), false);
});

test("an unsettled intent of an earlier window is never overwritten by the next window's", async () => {
  const { platform, goTo, h } = await oneMarket();
  platform.beforeUpload = () => {
    throw new TypeError("fetch failed");
  };
  await h.tick();
  const saved = (await h.state()).watch!["1"]!.intent!;
  assert.equal(saved.windowId, "1-w0");
  platform.beforeUpload = undefined;
  goTo(1);
  await h.restart();
  // The platform cannot say yet whether window 0 closed: its intent stays, and window 1 waits.
  platform.beforeGetWindow = () => {
    throw apiError(500, "INTERNAL");
  };
  await h.tick();
  assert.deepEqual((await h.state()).watch!["1"]!.intent, saved);
  assert.equal(platform.submissions.length, 0);
  // Once it can, the old intent is settled (the answer never arrived: dropped) and window 1 is answered.
  platform.beforeGetWindow = undefined;
  await h.tick();
  assert.equal(h.events("intent_dropped")[0]!.windowId, "1-w0");
  assert.deepEqual(platform.submissions.map((s) => s.windowId), ["1-w1"]);
});

test("a source that differs only in noise runs no analysis", async () => {
  const page = (nonce: string, stamp: string) =>
    `<html><head><script nonce="${nonce}">var t=${stamp}</script></head><body><p data-ts="${stamp}">Gross margin 61%</p><!-- ${stamp} --></body></html>`;
  const { model, pages, goTo, platform, h } = await oneMarket({ pages: { [URL_A]: { body: page("n1", "111") } } });
  await h.tick();
  pages.set(URL_A, page("n2", "222"));
  goTo(1);
  await h.tick();
  assert.equal(model.calls.length, 1);
  assert.equal(noteOf(platform, platform.submissions[1]!).kind, "carry_forward");
});

test("a heartbeat runs an analysis after the limit with nothing changed, and the note's items are all UNCHANGED", async () => {
  const { model, goTo, platform, h } = await oneMarket({ heartbeatSeconds: 3 * DAY });
  await h.tick();
  for (const index of [1, 2]) {
    goTo(index);
    await h.tick();
  }
  assert.equal(model.calls.length, 1);
  goTo(3);
  await h.tick();
  assert.equal(model.calls.length, 2);
  assert.equal(h.events("forecast_decision")[3]!.reason, "heartbeat");
  const note = noteOf(platform, platform.submissions[3]!);
  assert.equal(note.kind, "analysis");
  assert.deepEqual(note.evidence.map((e) => e.status), ["UNCHANGED"]);
  assert.deepEqual(note.prior, { digest: platform.submissions[2]!.digest });
  assert.equal((await h.state()).watch!["1"]!.prior!.analysedAt, tickTime(3));
});

test("an unreachable source never triggers an analysis, is listed UNREACHABLE, and the carry-forward is still signed", async () => {
  const { model, pages, goTo, platform, h } = await oneMarket();
  await h.tick();
  pages.failures.set(URL_A, "TIMEOUT");
  goTo(1);
  await h.tick();
  assert.equal(model.calls.length, 1);
  assert.equal(platform.submissions.length, 2);
  const note = noteOf(platform, platform.submissions[1]!);
  assert.equal(note.kind, "carry_forward");
  assert.deepEqual(note.evidence.map((e) => [e.status, e.note]), [["UNREACHABLE", "TIMEOUT"]]);
  assert.match(note.evidence[0]!.fingerprint!, /^0x[0-9a-f]{64}$/);
  assert.equal(h.events("forecast_decision")[1]!.unreachable, 1);
});

test("a model with no view submits nothing, logs no_view and keeps the old fingerprints, with or without an earlier forecast", async () => {
  const none = await oneMarket({ model: countingModel({ probabilityBps: null }) });
  await none.h.tick();
  await none.h.tick();
  assert.equal(none.platform.submissions.length, 0);
  assert.equal(none.h.events("no_view").length, 1, "asked once per window");
  assert.equal(none.model.calls.length, 1);
  assert.deepEqual((await none.h.state()).watch?.["1"]?.sources ?? {}, {});
  assert.equal(none.platform.uploads.length, 0);

  const earlier = await oneMarket();
  await earlier.h.tick();
  const before = (await earlier.h.state()).watch!["1"]!.sources;
  earlier.pages.set(URL_A, "<p>news</p>");
  earlier.model.beliefs = { probabilityBps: null };
  earlier.goTo(1);
  await earlier.h.tick();
  assert.equal(earlier.platform.submissions.length, 1);
  assert.equal(earlier.h.events("no_view").length, 1);
  assert.deepEqual((await earlier.h.state()).watch!["1"]!.sources, before);
  // The change is seen again in the next window, with the same since.
  earlier.model.beliefs = { probabilityBps: 7000, summary: "now" };
  earlier.goTo(2);
  await earlier.h.tick();
  assert.equal(earlier.platform.submissions.length, 2);
  const item = noteOf(earlier.platform, earlier.platform.submissions[1]!).evidence[0]!;
  assert.deepEqual([item.status, item.since], ["CHANGED", tickTime(0)]);
});

test("an analysis that throws is called at most 3 times in one window, at least 10 s apart, submits nothing, does not fetch the sources again, and logs window_missed", async () => {
  const model = countingModel();
  model.failWith = new Error("boom SECRET-IN-MESSAGE");
  const { platform, pages, h } = await oneMarket({ model });
  const start = tickTime(0);
  // A tick every 2 s for 60 s of the 30-minute window.
  for (let t = 0; t <= 60; t += 2) {
    h.at(start + t);
    await h.tick();
  }
  assert.equal(model.calls.length, 3);
  const times = model.calls.map((c) => c.at);
  for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= 10, `calls ${times}`);
  assert.equal(platform.submissions.length, 0);
  assert.equal(pages.fetches.length, 1, "the sources were read once for the window");
  assert.equal(h.events("analysis_failed").length, 3);
  assert.equal(h.events("window_missed").length, 1);
  assert.ok(!JSON.stringify(h.lines).includes("SECRET-IN-MESSAGE"), "a raw message never reaches the log");
  // Later ticks in the same window do nothing more.
  h.at(start + 600);
  await h.tick();
  assert.equal(model.calls.length, 3);
  assert.equal(h.events("window_missed").length, 1);
  assert.equal(platform.uploads.length, 0);
});

test("a window that closes while the analysis is still being retried logs window_missed", async () => {
  const model = countingModel();
  model.failWith = new Error("boom");
  const { platform, h } = await oneMarket({ model });
  await h.tick();
  assert.equal(model.calls.length, 1);
  assert.equal(h.events("window_missed").length, 0);
  platform.setStatus("1", 0, "CLOSED");
  h.at(tickTime(0) + 5);
  await h.tick();
  assert.equal(h.events("window_missed").length, 1);
  assert.equal(h.events("window_missed")[0]!.windowId, "1-w0");
});

test("a failure after the model answered (note upload, submit) never calls the model again in that window", async () => {
  const { platform, model, h } = await oneMarket();
  let uploadFailures = 2;
  let submitFailures = 1;
  platform.beforeUpload = () => {
    if (uploadFailures-- > 0) throw new TypeError("fetch failed");
  };
  platform.beforeSubmit = () => {
    if (submitFailures-- > 0) throw apiError(503, "SIGNATURE_CHECK_UNAVAILABLE");
  };
  const start = tickTime(0);
  for (let t = 0; t < 12; t += 2) {
    h.at(start + t);
    await h.tick();
  }
  assert.equal(model.calls.length, 1);
  assert.equal(platform.submissions.length, 1);
  assert.equal(h.events("forecast_submitted").length, 1);
  assert.equal(h.events("forecaster_market_error").length, 3, "each failure is logged with a code");
  assert.equal(new Set(platform.uploads.map((u) => u.hash)).size, 1, "every retry sent the same note");
});

test("a cold start with 25 watched URLs builds a note that parses, with the watch list truncated to 20 and watch_list_truncated logged", async () => {
  const urls = Array.from({ length: 25 }, (_, i) => `https://s${i}.example/p`);
  const { platform, h } = await oneMarket({ sources: urls, pages: Object.fromEntries(urls.map((u) => [u, { body: "x" }])) });
  await h.tick();
  const note = noteOf(platform, platform.submissions[0]!);
  assert.deepEqual(note.evidence.map((e) => e.url), urls.slice(0, 20));
  const truncated = h.events("watch_list_truncated");
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0]!.dropped, 5);
});

test("the builder keeps every CHANGED item and stays within 65,536 bytes: 20 CHANGED items with 2048-byte URLs, 500-character notes and a 2000-character summary of U+0001 (six bytes each in JSON) build a note that parses", () => {
  const url = (i: number) => {
    const head = `https://h${String(i).padStart(2, "0")}.example/`;
    return head + "x".repeat(2048 - head.length);
  };
  const items = Array.from({ length: 20 }, (_, i) => ({
    url: url(i),
    status: "CHANGED" as const,
    since: BASE,
    observedAt: BASE + 5,
    fingerprint: keccak256(utf8(String(i))),
    snapshot: keccak256(utf8("s" + i)),
    note: "\u0001".repeat(500),
  }));
  const bytes = buildNote({
    kind: "analysis",
    subject: { marketId: "7", markets: MARKETS, forecaster: account.address, horizon: 0, scheduledAt: BASE },
    salt: keccak256(utf8("salt")),
    checkedAt: BASE + 5,
    priorDigest: keccak256(utf8("prior")),
    summary: "\u0001".repeat(2000),
    items,
  });
  assert.ok(bytes.length <= FORECAST_NOTE_MAX_BYTES, `${bytes.length} bytes`);
  const parsed = parseForecastNote(bytes);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  assert.equal(parsed.note.evidence.length, 20);
  assert.ok(parsed.note.evidence.every((e) => e.status === "CHANGED" && e.snapshot !== null && e.since === BASE));
  assert.deepEqual(parsed.note.evidence.map((e) => e.url), items.map((i) => i.url));
});

test("the builder drops UNCHANGED items first, then UNREACHABLE, then NEW, and never a CHANGED one", () => {
  const item = (i: number, status: "NEW" | "CHANGED" | "UNCHANGED" | "UNREACHABLE") => ({
    url: `https://h${i}.example/`,
    status,
    since: status === "CHANGED" ? BASE : null,
    observedAt: BASE + 5,
    fingerprint: keccak256(utf8(String(i))),
    snapshot: null,
    note: "",
  });
  // 28 items given: the builder keeps 20, in the given order, preferring the more informative ones.
  const items = [
    ...Array.from({ length: 10 }, (_, i) => item(i, "UNCHANGED")),
    ...Array.from({ length: 6 }, (_, i) => item(10 + i, "UNREACHABLE")),
    ...Array.from({ length: 8 }, (_, i) => item(16 + i, "NEW")),
    ...Array.from({ length: 4 }, (_, i) => item(24 + i, "CHANGED")),
  ];
  const bytes = buildNote({
    kind: "analysis",
    subject: { marketId: "7", markets: MARKETS, forecaster: account.address, horizon: 0, scheduledAt: BASE },
    salt: keccak256(utf8("salt")),
    checkedAt: BASE + 5,
    priorDigest: null,
    summary: "",
    items,
  });
  const parsed = parseForecastNote(bytes);
  assert.ok(parsed.ok);
  const kept = parsed.note.evidence.map((e) => e.status);
  assert.equal(kept.length, 20);
  assert.equal(kept.filter((s) => s === "CHANGED").length, 4);
  assert.equal(kept.filter((s) => s === "NEW").length, 8);
  assert.equal(kept.filter((s) => s === "UNREACHABLE").length, 6);
  assert.equal(kept.filter((s) => s === "UNCHANGED").length, 2);
  assert.deepEqual(
    parsed.note.evidence.map((e) => e.url),
    items.filter((i) => i.status !== "UNCHANGED" || Number(i.url.slice(9, -9)) < 2).map((i) => i.url),
  );
});

test("a watched URL over the limit (a 3000-character spec source, or a 2048-character one whose backslashes double in JSON) is dropped with watch_url_too_long and never blocks the note", async () => {
  const long = "https://long.example/" + "p".repeat(3000 - 21);
  const doubling = "https://bs.example/?q=" + "\\".repeat(2048 - 22);
  assert.equal(doubling.length, 2048);
  const { platform, h } = await oneMarket({
    sources: [URL_A, long, doubling, "http://plain.example/", "not a url"],
    pages: { [URL_A]: { body: "x" } },
  });
  await h.tick();
  const note = noteOf(platform, platform.submissions[0]!);
  assert.deepEqual(note.evidence.map((e) => e.url), [URL_A]);
  const dropped = (event: string) => h.events(event).reduce((sum, l) => sum + (l.dropped as number), 0);
  assert.equal(dropped("watch_url_too_long"), 2);
  assert.equal(dropped("watch_url_invalid"), 2, "an http URL and an unparseable one are invalid, not too long");
  assert.ok(!JSON.stringify(h.lines).includes("p".repeat(100)), "a URL is never logged in full");
});

test("the watch list is mapped through watchableUrl, then deduplicated, then capped at 20 with spec.sources first", async () => {
  const platform = new Platform();
  const specSource = "https://spec.example/Truth";
  platform.addMarket("1", [specSource], ["OPEN"]);
  const extra = Array.from({ length: 22 }, (_, i) => `https://extra${i}.example/`);
  const model = {
    ...countingModel(),
    // The model lists its own sources first, repeats (in a different spelling) and the spec source last.
    watchList: async () => [...extra, "https://EXTRA0.example", specSource, "ftp://x.example/"],
  } as Model & { calls: unknown[] };
  const pages = scriptedSources();
  const h = await started({ platform, stateDir: await tempDir(), model, fetcher: pages.fetcher });
  h.at(tickTime(0));
  await h.tick();
  const note = noteOf(platform, platform.submissions[0]!);
  assert.equal(note.evidence.length, 20);
  assert.equal(note.evidence[0]!.url, specSource);
  assert.equal(new Set(note.evidence.map((e) => e.url)).size, 20);
  assert.equal(note.evidence.filter((e) => e.url === "https://extra0.example/").length, 1);
  assert.equal(h.events("watch_list_truncated").length, 1);
  assert.equal(h.events("watch_url_invalid").length, 1);
});

test("restart after the intent was saved resubmits identical bytes, and still uploads the snapshots after the deadline", async () => {
  const { platform, pages, goTo, h } = await oneMarket();
  await h.tick();
  pages.set(URL_A, "<p>changed</p>");
  goTo(1);
  // The answer reaches the platform but the response is lost: the process dies before it commits.
  platform.afterSubmitStored = () => {
    platform.afterSubmitStored = undefined;
    throw new TypeError("fetch failed");
  };
  await h.tick();
  assert.equal(platform.submissions.length, 2);
  const saved = (await h.state()).watch!["1"]!;
  assert.ok(saved.intent);
  assert.equal(saved.prior!.windowId, "1-w0", "not committed yet");
  const bytes = utf8(saved.intent!.noteBytes);

  await h.restart();
  await h.tick();
  assert.equal(platform.submissions.length, 2, "a replay, not a second answer");
  assert.equal(h.events("forecast_submitted").length, 2);
  assert.equal(platform.submissions[1]!.contentHash, keccak256(bytes), "identical bytes");
  assert.deepEqual(platform.contents.get(keccak256(bytes))!.bytes, bytes);
  const after = (await h.state()).watch!["1"]!;
  assert.equal(after.intent, undefined);
  assert.equal(after.prior!.digest, platform.submissions[1]!.digest);
  assert.equal(after.prior!.windowId, "1-w1");
  assert.equal(after.prior!.analysedAt, noteOf(platform, platform.submissions[1]!).checkedAt);

  const hash = keccak256(utf8("<p>changed</p>"));
  assert.equal(platform.contents.has(hash), false);
  platform.setStatus("1", 1, "CLOSED");
  await h.restart();
  await h.tick();
  assert.equal(platform.contents.has(hash), true);
});

test("an intent whose window closed before the restart is settled: when the agent's answer in that window has the intent's digest, prior is set (with analysedAt for an analysis) and the fingerprints stay uncommitted; when it has not, the intent is dropped and intent_dropped is logged", async () => {
  // The answer did reach the platform.
  const reached = await oneMarket();
  await reached.h.tick();
  const committed = (await reached.h.state()).watch!["1"]!.sources;
  reached.pages.set(URL_A, "<p>changed</p>");
  reached.goTo(1);
  reached.platform.afterSubmitStored = () => {
    reached.platform.afterSubmitStored = undefined;
    throw new TypeError("fetch failed");
  };
  await reached.h.tick();
  reached.platform.setStatus("1", 1, "CLOSED");
  const { intent } = (await reached.h.state()).watch!["1"]!;
  assert.equal(intent!.kind, "analysis");
  reached.h.at(tickTime(1) + 3000);
  await reached.h.restart();
  await reached.h.tick();
  const settled = (await reached.h.state()).watch!["1"]!;
  assert.equal(settled.intent, undefined);
  assert.deepEqual(settled.prior, {
    digest: reached.platform.submissions[1]!.digest,
    windowId: "1-w1",
    analysedAt: noteOf(reached.platform, reached.platform.submissions[1]!).checkedAt,
    answeredAt: reached.platform.submissions[1]!.receivedAt,
    probabilityBps: intent!.probabilityBps,
  });
  assert.deepEqual(settled.sources, committed, "the change is seen again in the next window");
  assert.equal(reached.h.events("intent_dropped").length, 0);
  assert.equal(reached.platform.submissions.length, 2, "no second answer is sent");
  // Its snapshot upload still happens: the window is closed.
  assert.equal(reached.platform.contents.has(keccak256(utf8("<p>changed</p>"))), true);
  // And the next window analyses the same change again.
  reached.goTo(2);
  await reached.h.tick();
  assert.equal(reached.h.events("forecast_decision").at(-1)!.reason, "change");

  // The answer never reached the platform.
  const lost = await oneMarket();
  await lost.h.tick();
  lost.pages.set(URL_A, "<p>changed</p>");
  lost.goTo(1);
  lost.platform.beforeSubmit = () => {
    throw new TypeError("fetch failed");
  };
  await lost.h.tick();
  lost.platform.beforeSubmit = undefined;
  lost.platform.setStatus("1", 1, "CLOSED");
  await lost.h.restart();
  await lost.h.tick();
  const dropped = lost.h.events("intent_dropped");
  assert.equal(dropped.length, 1);
  assert.equal((await lost.h.state()).watch!["1"]!.intent, undefined);
  assert.equal((await lost.h.state()).watch!["1"]!.prior!.windowId, "1-w0");
});

test("one decision per window, even when the source changes after the answer", async () => {
  const { platform, pages, model, goTo, h } = await oneMarket();
  await h.tick();
  const fetched = pages.fetches.length;
  pages.set(URL_A, "<p>news after the answer</p>");
  h.at(tickTime(0) + 20);
  await h.tick();
  await h.tick();
  assert.equal(platform.submissions.length, 1);
  assert.equal(model.calls.length, 1);
  assert.equal(pages.fetches.length, fetched, "the window is not read again");
  goTo(1);
  await h.tick();
  assert.equal(h.events("forecast_decision").at(-1)!.reason, "change");
  assert.equal(platform.submissions.length, 2);
});

test("a market with 150 windows is answered in the 150th window, reading at most two pages per tick after the first, from the saved cursor", async () => {
  const platform = new Platform();
  platform.addMarket("1", [URL_A], Array.from({ length: 150 }, (_, i) => (i === 149 ? "OPEN" : "CLOSED")));
  const pages = scriptedSources({ [URL_A]: { body: "x" } });
  const h = await started({ platform, stateDir: await tempDir(), model: countingModel(), fetcher: pages.fetcher });
  h.at(tickTime(149));
  platform.now = tickTime(149);
  await h.tick();
  assert.equal(platform.submissions.length, 1);
  assert.equal(platform.submissions[0]!.windowId, "1-w149");
  assert.deepEqual(platform.windowReads.map((r) => r.cursor), [undefined, "cur:100"], "two pages on the first tick");
  assert.equal((await h.state()).watch!["1"]!.windowsCursor, "cur:100");
  platform.windowReads.length = 0;
  // The answered window is not listed again until its deadline; after it, one page from the saved cursor.
  await h.tick();
  assert.equal(platform.windowReads.length, 0, "nothing can be due before the deadline");
  h.at(tickTime(149) + DAY);
  await h.tick();
  assert.deepEqual(platform.windowReads.map((r) => r.cursor), ["cur:100"], "one page from the saved cursor");
  // After a restart too.
  platform.windowReads.length = 0;
  await h.restart();
  await h.tick();
  assert.deepEqual(platform.windowReads.map((r) => r.cursor), ["cur:100"]);
});

test("the cursor is saved whenever it moves, even when the model has no view, and is never built by the agent", async () => {
  const platform = new Platform();
  platform.addMarket("1", [URL_A], Array.from({ length: 250 }, (_, i) => (i === 249 ? "OPEN" : "CLOSED")));
  const model = countingModel({ probabilityBps: null });
  const pages = scriptedSources({ [URL_A]: { body: "x" } });
  const h = await started({ platform, stateDir: await tempDir(), model, fetcher: pages.fetcher });
  h.at(tickTime(249));
  await h.tick();
  assert.equal(platform.submissions.length, 0);
  // Two pages were read: from the start, and from the first cursor the server issued; the second was whole and closed.
  assert.deepEqual(platform.windowReads.map((r) => r.cursor), [undefined, "cur:100"]);
  assert.equal((await h.state()).watch!["1"]!.windowsCursor, "cur:200");
  assert.equal(model.calls.length, 0, "the open window was not reached yet");
  platform.windowReads.length = 0;
  await h.tick();
  assert.deepEqual(platform.windowReads.map((r) => r.cursor), ["cur:200"]);
  assert.equal(h.events("no_view").length, 1, "the model had no view of the open window");
  assert.equal((await h.state()).watch!["1"]!.windowsCursor, "cur:200");
  // Every cursor the agent sent was one the platform issued.
  assert.ok(platform.windowReads.every((r) => r.cursor === undefined || /^cur:(100|200)$/.test(r.cursor)));
  // And a later restart still reads from it.
  platform.windowReads.length = 0;
  await h.restart();
  await h.tick();
  assert.deepEqual(platform.windowReads.map((r) => r.cursor), ["cur:200"]);
});

test("a model without watchList or revise uses spec.sources and probabilityBps", async () => {
  const platform = new Platform();
  platform.addMarket("1", [URL_A], ["OPEN"]);
  const asked: string[] = [];
  const model: Model = {
    questions: async () => [],
    fromSuggestion: async () => null,
    probabilityBps: async () => {
      asked.push("probabilityBps");
      return 4200;
    },
    outcome: async () => null,
    creationObjection: async () => null,
    appeal: async () => false,
  };
  const pages = scriptedSources({ [URL_A]: { body: "x" } });
  const h = await started({ platform, stateDir: await tempDir(), model, fetcher: pages.fetcher });
  h.at(tickTime(0));
  await h.tick();
  assert.deepEqual(pages.fetches, [URL_A]);
  assert.deepEqual(asked, ["probabilityBps"]);
  assert.equal(platform.submissions[0]!.probabilityBps, 4200);
  assert.equal(noteOf(platform, platform.submissions[0]!).summary, "");
});

test("the signed message equals the old shape except contentHash", async () => {
  const { platform, h } = await oneMarket();
  await h.tick();
  const answer = platform.submissions[0]!;
  const window = platform.markets.get("1")!.windows[0]!;
  assert.deepEqual(Object.keys(platform.submitBodies[0]!).sort(), ["contentHash", "horizon", "probabilityBps", "scheduledAt", "signature"]);
  const old = {
    forecaster: account.address,
    markets: MARKETS,
    marketId: "1",
    horizon: window.horizon,
    scheduledAt: window.scheduledAt,
    probabilityBps: 6000,
    contentHash: NO_CONTENT_HASH,
  };
  const now = { ...old, contentHash: answer.contentHash };
  assert.equal(await verifyTypedData({ address: account.address, ...forecastTypedData({ anchor: ANCHOR, message: now }), signature: answer.signature }), true);
  assert.equal(await verifyTypedData({ address: account.address, ...forecastTypedData({ anchor: ANCHOR, message: old }), signature: answer.signature }), false);
  assert.equal(answer.digest, forecastDigest({ anchor: ANCHOR, message: now }));
  assert.notEqual(answer.digest, forecastDigest({ anchor: ANCHOR, message: old }));
});

test("agentParts returns the fixture fetcher: a URL outside the world answers NOT_IN_WORLD, and main.ts never references httpsFetcher", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "page.txt"), "hello");
  const world = {
    dir,
    questions: { q: { spec: {}, closeInSeconds: 1, maxPairs: 1, sources: { "https://example.com/page": "page.txt" } } },
    suggestions: {},
    agents: { alice: { roles: ["forecaster"], beliefs: {} } },
  } as never;
  const env = { name: "alice", roles: ["forecaster"], apiUrl: "", rpcUrl: "", key: "0x", worldPath: "", stateDir: "" } as never;
  const parts = agentParts(env, world);
  assert.deepEqual(await parts.fetcher("https://other.example/x", {}), { status: "error", code: "NOT_IN_WORLD" });
  const served = await parts.fetcher("https://example.com/page", {});
  assert.equal(served.status, 200);
  assert.equal(parts.heartbeatSeconds, 336 * 3600, "the default heartbeat is 14 days");
  assert.equal(agentParts({ ...(env as object), heartbeatSeconds: 7200 } as never, world).heartbeatSeconds, 7200);
  assert.equal(typeof parts.model.watchList, "function");
  assert.equal(typeof fixtureFetcher, "function");
  const main = await readFile(new URL("../examples/agents/src/main.ts", import.meta.url), "utf8");
  assert.doesNotMatch(main, /httpsFetcher|httpsTransport|https\.request/);
  assert.match(main, /fetcher: fixtureFetcher\(world\)/);
});

test("91 windows, 4 source changes, a 14-day heartbeat: 8 analyses and 91 signatures (every window gets one, as an analysis or a carry-forward); no heartbeat: 5 analyses; a 7-day heartbeat: 15", async () => {
  const run = async (heartbeatDays: number) => {
    const platform = new Platform();
    platform.addMarket("1", [URL_A], Array.from({ length: 91 }, () => "UPCOMING" as const));
    const pages = scriptedSources({ [URL_A]: { body: "<p>v0</p>" } });
    const model = countingModel();
    const h = await started({ platform, stateDir: await tempDir(), model, fetcher: pages.fetcher, heartbeatSeconds: heartbeatDays * DAY });
    const changes = new Set([10, 35, 60, 80]);
    for (let i = 0; i < 91; i++) {
      if (changes.has(i)) pages.set(URL_A, `<p>v${i}</p>`);
      platform.openOnly("1", i);
      h.at(tickTime(i));
      platform.now = tickTime(i);
      await h.tick();
    }
    const kinds = platform.submissions.map((s) => noteOf(platform, s).kind);
    return { analyses: model.calls.length, signatures: platform.submissions.length, noteAnalyses: kinds.filter((k) => k === "analysis").length, fetches: pages.fetches.length };
  };
  assert.deepEqual(await run(14), { analyses: 8, signatures: 91, noteAnalyses: 8, fetches: 91 });
  assert.deepEqual(await run(1_000_000), { analyses: 5, signatures: 91, noteAnalyses: 5, fetches: 91 });
  assert.deepEqual(await run(7), { analyses: 15, signatures: 91, noteAnalyses: 15, fetches: 91 });
});

// -- Rulings of the Task 2 reviews ----------------------------------------------------------------

test("the watch records of markets that are no longer OPEN are dropped once nothing is pending for them", async () => {
  const platform = new Platform();
  for (const id of ["1", "2", "3"]) platform.addMarket(id, [URL_A], ["OPEN"]);
  const pages = scriptedSources({ [URL_A]: { body: "x" } });
  const h = await started({ platform, stateDir: await tempDir(), model: countingModel(), fetcher: pages.fetcher });
  h.at(tickTime(0));
  platform.now = tickTime(0);
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(Object.keys((await h.state()).watch!).sort(), ["1", "2", "3"]);
  // Market 2 has a snapshot waiting (its file is gone); market 3 has an intent that cannot be read.
  const state = h.ctx.state.data;
  state.watch!["2"]!.pendingSnapshots = [{ hash: keccak256(utf8("s")), mediaType: "text/html", windowId: "2-w0" }];
  state.watch!["3"]!.intent = { windowId: "3-w0", kind: "analysis", noteBytes: "{}", probabilityBps: 5000 };
  await h.ctx.state.save();
  for (const id of ["1", "2", "3"]) platform.closeMarket(id);
  await h.tick();
  assert.deepEqual(Object.keys((await h.state()).watch ?? {}).sort(), ["2", "3"], "only the records with something pending stay");
  // Their windows close: the snapshot is dropped (no file) and the intent is dropped (not a note); the records go.
  platform.window("2-w0").status = "CLOSED";
  platform.window("3-w0").status = "CLOSED";
  h.at(tickTime(0) + 60);
  await h.tick();
  assert.deepEqual(Object.keys((await h.state()).watch ?? {}), []);
  assert.equal(h.events("snapshot_upload_failed").length, 1);
  assert.equal(h.events("intent_dropped").length, 1);
});

test("one market's failure does not stop the tick for the others, and a log line carries a code and never a raw message", async () => {
  const platform = new Platform();
  for (const id of ["1", "2", "3", "4"]) platform.addMarket(id, [URL_A], ["OPEN"]);
  const pages = scriptedSources({ [URL_A]: { body: "x" } });
  const model = countingModel();
  const inner = model.revise!;
  model.revise = async (m, input) => {
    if (m.marketId === 3n) throw new Error("secret-token-abc is in this message");
    return inner(m, input);
  };
  platform.beforeListWindows = (id) => {
    if (id === "2") throw apiError(500, "INTERNAL");
  };
  const h = await started({ platform, stateDir: await tempDir(), model, fetcher: pages.fetcher });
  h.at(tickTime(0));
  platform.now = tickTime(0);
  for (let i = 0; i < 3; i++) await h.tick();
  assert.deepEqual(platform.submissions.map((s) => s.windowId).sort(), ["1-w0", "4-w0"]);
  assert.ok(h.events("forecaster_market_error").length >= 1);
  assert.ok(h.events("forecaster_market_error").every((e) => e.marketId === "2" && e.code === "INTERNAL"));
  assert.ok(h.events("analysis_failed").some((l) => l.marketId === "3"));
  assert.ok(!JSON.stringify(h.lines).includes("secret-token-abc"));
});

test("a throwing fetcher or watchList is one market's failure with a stable code", async () => {
  const platform = new Platform();
  for (const id of ["1", "2"]) platform.addMarket(id, [URL_A], ["OPEN"]);
  const model = {
    ...countingModel(),
    watchList: async (m: { marketId: bigint }) => {
      if (m.marketId === 1n) throw new Error("hunter2 leaks here");
      return [URL_A];
    },
  } as Model;
  const throwing: SourceFetcher = async () => {
    throw new Error("socket exploded with hunter2");
  };
  const h = await started({ platform, stateDir: await tempDir(), model, fetcher: throwing });
  h.at(tickTime(0));
  platform.now = tickTime(0);
  await h.tick();
  await h.tick();
  assert.ok(!JSON.stringify(h.lines).includes("hunter2"));
  const errors = h.events("forecaster_market_error");
  assert.ok(errors.length >= 1 && errors.every((e) => e.marketId === "1" && typeof e.code === "string" && /^[A-Za-z0-9_:]+$/.test(e.code)));
  // Market 2's source threw: it is UNREACHABLE (FETCHER_FAILED), and a cold start still analyses.
  assert.deepEqual(platform.submissions.map((s) => s.windowId), ["2-w0"]);
  const note = noteOf(platform, platform.submissions[0]!);
  assert.deepEqual(note.evidence.map((e) => [e.status, e.note, e.fingerprint]), [["UNREACHABLE", "FETCHER_FAILED", null]]);
});

test("a rate limit still reaches the loop so that it backs off", async () => {
  const platform = new Platform();
  platform.addMarket("1", [URL_A], ["OPEN"]);
  platform.beforeListWindows = () => {
    throw apiError(429, "RATE_LIMITED");
  };
  const h = await started({ platform, stateDir: await tempDir(), fetcher: scriptedSources().fetcher });
  await assert.rejects(h.tick(), (error: unknown) => error instanceof BlinkApiError && error.status === 429);
});

test("a tick checks the sources of at most MAX_MARKETS_WORKED_PER_TICK markets and every market is served in turn", async () => {
  assert.ok(MAX_MARKETS_WORKED_PER_TICK >= 1 && MAX_MARKETS_WORKED_PER_TICK <= 4);
  const ids = ["1", "2", "3", "4", "5", "6", "7"];
  const platform = new Platform();
  for (const id of ids) platform.addMarket(id, [`https://m${id}.example/p`], ["OPEN"]);
  const pages = scriptedSources(Object.fromEntries(ids.map((id) => [`https://m${id}.example/p`, { body: "x" }])));
  const model = countingModel();
  const h = await started({ platform, stateDir: await tempDir(), model, fetcher: pages.fetcher });
  h.at(tickTime(0));
  platform.now = tickTime(0);
  const answered: string[][] = [];
  let seen = 0;
  for (let tick = 0; tick < Math.ceil(ids.length / MAX_MARKETS_WORKED_PER_TICK) + 1; tick++) {
    const fetchesBefore = pages.fetches.length;
    await h.tick();
    assert.ok(pages.fetches.length - fetchesBefore <= MAX_MARKETS_WORKED_PER_TICK, "bounded per tick");
    answered.push(platform.submissions.slice(seen).map((s) => s.windowId));
    seen = platform.submissions.length;
  }
  assert.equal(platform.submissions.length, ids.length, "all served");
  // In turn: nobody is answered twice, and the order is stable.
  assert.deepEqual(answered.flat(), ids.map((id) => `${id}-w0`));
  assert.ok(answered.every((tick) => tick.length <= MAX_MARKETS_WORKED_PER_TICK));
});

test("a market whose check is already kept for the window does not use the budget again", async () => {
  const platform = new Platform();
  for (const id of ["1", "2", "3"]) platform.addMarket(id, [`https://m${id}.example/p`], ["OPEN"]);
  const pages = scriptedSources(Object.fromEntries(["1", "2", "3"].map((id) => [`https://m${id}.example/p`, { body: "x" }])));
  const model = countingModel();
  const h = await started({ platform, stateDir: await tempDir(), model, fetcher: pages.fetcher });
  h.at(tickTime(0));
  // Market 1's answer keeps failing, so its window stays open with its check kept.
  platform.beforeUpload = (bytes) => {
    if (text(bytes).includes('"marketId":"1"')) throw new TypeError("fetch failed");
  };
  for (let i = 0; i < 4; i++) await h.tick();
  assert.deepEqual(platform.submissions.map((s) => s.windowId).sort(), ["2-w0", "3-w0"]);
  assert.equal(pages.fetches.filter((u) => u.includes("m1")).length, 1, "read once for the window");
});

test("the default forecaster is created with createForecaster", () => {
  assert.equal(typeof defaultForecaster, "function");
  assert.equal(typeof createForecaster(), "function");
});

// ---- Review fixes (round 1) ---------------------------------------------------------------------

const EIGHT_MIB = 8 * 1024 * 1024;
const noteSubject = { marketId: "1", markets: MARKETS, forecaster: account.address, horizon: 0, scheduledAt: BASE + DAY };
const fp = ("0x" + "44".repeat(32)) as Hex;
const noteItem = (url: string, status: "NEW" | "CHANGED" | "UNCHANGED" | "UNREACHABLE", extra: Record<string, unknown> = {}) => ({
  url,
  status,
  since: null,
  observedAt: BASE,
  fingerprint: fp,
  snapshot: null,
  note: "",
  ...extra,
});
const droppedCount = (h: { events: (name: string) => Line[] }, event: string) =>
  h.events(event).reduce((sum, l) => sum + (l.dropped as number), 0);

test("a source whose canonical URL keeps a backslash is dropped with watch_url_invalid, and the window is still answered with one model call", async () => {
  const query = "https://x.example/?q=\\";
  const fragment = "https://y.example/#\\frag";
  assert.equal(new URL(query).href, query, "the URL parser keeps the backslash");
  assert.equal(new URL(fragment).href, fragment);
  const { platform, model, h, goTo } = await oneMarket({ sources: [URL_A, query, fragment] });
  for (let i = 0; i < 3; i++) {
    h.at(tickTime(0) + i * 20);
    await h.tick();
  }
  assert.equal(h.events("forecaster_market_error").length, 0);
  assert.equal(platform.submissions.length, 1);
  assert.equal(model.calls.length, 1, "one model call, and none wasted on a note that cannot be built");
  assert.deepEqual(noteOf(platform, platform.submissions[0]!).evidence.map((e) => e.url), [URL_A]);
  assert.equal(droppedCount(h, "watch_url_invalid"), 2);
  assert.equal(droppedCount(h, "watch_url_too_long"), 0, "these URLs are short: they are invalid, not too long");
  goTo(1);
  await h.tick();
  assert.equal(platform.submissions.length, 2, "the next window is answered too");
});

test("isCanonicalHttpsUrl refuses a backslash in the query and in the fragment, and a state file naming such a URL is corrupt", async () => {
  assert.equal(isCanonicalHttpsUrl("https://x.example/?q=\\"), false);
  assert.equal(isCanonicalHttpsUrl("https://x.example/#\\"), false);
  assert.equal(isCanonicalHttpsUrl("https://x.example/?q=a"), true);
  const dir = await tempDir();
  const sources = { "https://x.example/?q=\\": { fingerprint: fp, checkedAt: 1 } };
  await writeFile(join(dir, "state.json"), JSON.stringify({ salts: {}, acted: {}, fills: {}, watch: { "1": { sources } } }));
  await assert.rejects(loadState(dir), new Error("STATE_CORRUPT"));
});

test("the builder drops a NEW, UNCHANGED or UNREACHABLE item that the note schema refuses, and still throws for a CHANGED one", () => {
  const input = (items: ReturnType<typeof noteItem>[]) => ({
    kind: "analysis" as const,
    subject: noteSubject,
    salt: ("0x" + "33".repeat(32)) as Hex,
    checkedAt: BASE,
    priorDigest: null,
    summary: "",
    items,
  });
  const bad = "https://x.example/?q=\\";
  const bytes = buildNote(
    input([noteItem(URL_A, "UNCHANGED"), noteItem(bad, "UNCHANGED"), noteItem(bad, "NEW"), noteItem(bad, "UNREACHABLE", { fingerprint: null }), noteItem(URL_B, "NEW")]),
  );
  const parsed = parseForecastNote(bytes);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.note.evidence.map((e) => e.url), [URL_A, URL_B]);
  assert.throws(() => buildNote(input([noteItem(bad, "CHANGED", { since: BASE - 10 })])), /NOTE_INVALID/);
});

test("a backoff in the middle of the market loop keeps the rotation: every market is answered over several ticks", async () => {
  const platform = new Platform();
  const ids = ["1", "2", "3", "4", "5"];
  for (const id of ids) platform.addMarket(id, [`https://m${id}.example/p`], ["OPEN"]);
  const pages = scriptedSources(Object.fromEntries(ids.map((id) => [`https://m${id}.example/p`, { body: "x" }])));
  const h = await started({ platform, stateDir: await tempDir(), model: countingModel(), fetcher: pages.fetcher });
  h.at(tickTime(0));
  platform.now = tickTime(0);
  // A read allowance of 2 window listings per tick, which refills between ticks.
  let reads = 0;
  platform.beforeListWindows = () => {
    if (++reads > 2) throw apiError(429, "RATE_LIMITED");
  };
  for (let t = 0; t < 10; t++) {
    reads = 0;
    await h.tick().catch(() => {});
    h.at(tickTime(0) + (t + 1) * 30);
  }
  assert.deepEqual(platform.submissions.map((s) => s.windowId).sort(), ids.map((id) => `${id}-w0`));
});

test("a tick lists the windows of a market only when something can be due: nothing is listed for 60 idle markets within 30 s of their last listing", async () => {
  const platform = new Platform();
  const ids = Array.from({ length: 60 }, (_, i) => String(i + 1));
  for (const id of ids) platform.addMarket(id, [URL_A], ["OPEN", "UPCOMING"]);
  const pages = scriptedSources({ [URL_A]: { body: "x" } });
  const h = await started({ platform, stateDir: await tempDir(), model: countingModel(), fetcher: pages.fetcher });
  h.at(tickTime(0));
  platform.now = tickTime(0);
  for (let t = 0; t < 40 && platform.submissions.length < ids.length; t++) await h.tick();
  assert.equal(platform.submissions.length, 60);
  const before = platform.windowReads.length;
  await h.tick();
  h.at(tickTime(0) + 20);
  await h.tick();
  assert.equal(platform.windowReads.length - before, 0, "no window listing for an idle market");
  // Past the short horizon the platform is asked again, once per market.
  h.at(tickTime(0) + 40);
  await h.tick();
  assert.equal(platform.windowReads.length - before, 60);
  // The next window opens: it is listed and answered.
  for (const id of ids) platform.openOnly(id, 1);
  h.at(tickTime(1));
  platform.now = tickTime(1);
  for (let t = 0; t < 40 && platform.submissions.length < 120; t++) await h.tick();
  assert.equal(platform.submissions.length, 120);
});

test("a window the model has no view of, or that was missed, is not listed again until it is over", async () => {
  const model = countingModel({ probabilityBps: null });
  const { platform, h } = await oneMarket({ model });
  await h.tick();
  assert.equal(h.events("no_view").length, 1);
  const before = platform.windowReads.length;
  await h.tick();
  await h.tick();
  assert.equal(platform.windowReads.length, before);
});

test("a clock that jumps backwards does not keep a market idle", async () => {
  const { platform, h, goTo } = await oneMarket();
  await h.tick();
  platform.openOnly("1", 1);
  h.at(tickTime(0) - DAY);
  await h.tick();
  assert.equal(platform.submissions.length, 2, "listed again although the idle time lies in the future");
  void goTo;
});

/** Markets with a changed source in window 1, which then closes: every snapshot is waiting to be archived. */
async function closedSnapshots(opts: { markets: number; urls: (id: string) => string[]; body: (url: string) => string }) {
  const platform = new Platform();
  const ids = Array.from({ length: opts.markets }, (_, i) => String(i + 1));
  const all = [...new Set(ids.flatMap(opts.urls))];
  for (const id of ids) platform.addMarket(id, opts.urls(id), ["OPEN", "UPCOMING"]);
  const pages = scriptedSources(Object.fromEntries(all.map((u) => [u, { body: "first " + u }])));
  const h = await started({ platform, stateDir: await tempDir(), model: countingModel(), fetcher: pages.fetcher });
  h.at(tickTime(0));
  platform.now = tickTime(0);
  for (let t = 0; t < ids.length + 2; t++) await h.tick();
  assert.equal(platform.submissions.length, ids.length);
  for (const u of all) pages.set(u, opts.body(u));
  for (const id of ids) platform.openOnly(id, 1);
  h.at(tickTime(1));
  platform.now = tickTime(1);
  for (let t = 0; t < ids.length + 2; t++) await h.tick();
  assert.equal(platform.submissions.length, 2 * ids.length);
  for (const id of ids) platform.setStatus(id, 1, "CLOSED");
  h.at(tickTime(1) + 600);
  return { platform, h, ids, all };
}
const pendingCount = async (h: { state: () => Promise<{ watch?: Record<string, { pendingSnapshots?: unknown[] }> }> }) =>
  Object.values((await h.state()).watch ?? {}).reduce((sum, r) => sum + (r.pendingSnapshots?.length ?? 0), 0);

test("at most 20 snapshot objects are uploaded in one tick, and the rest are carried to the next ticks", async () => {
  const { platform, h } = await closedSnapshots({
    markets: 4,
    urls: (id) => Array.from({ length: 20 }, (_, i) => `https://m${id}-s${i}.example/`),
    body: (u) => "second " + u,
  });
  assert.equal(await pendingCount(h), 80);
  const perTick: number[] = [];
  for (let t = 0; t < 6; t++) {
    const before = platform.uploads.length;
    await h.tick();
    perTick.push(platform.uploads.length - before);
  }
  assert.ok(perTick.every((n) => n <= 20), `per tick: ${perTick}`);
  assert.equal(perTick.reduce((a, b) => a + b, 0), 80);
  assert.equal(await pendingCount(h), 0);
  assert.equal(new Set(platform.uploads.map((u) => u.hash)).size, platform.uploads.length, "each object once");
});

test("at most 8 MiB of snapshots are uploaded in one tick", async () => {
  const { platform, h } = await closedSnapshots({
    markets: 2,
    urls: (id) => Array.from({ length: 10 }, (_, i) => `https://m${id}-s${i}.example/`),
    body: (u) => u + "x".repeat(900_000),
  });
  const perTick: number[] = [];
  for (let t = 0; t < 8; t++) {
    const before = platform.uploads.length;
    await h.tick();
    perTick.push(platform.uploads.slice(before).reduce((sum, u) => sum + u.size, 0));
  }
  assert.ok(perTick.every((n) => n <= EIGHT_MIB), `bytes per tick: ${perTick}`);
  assert.equal(await pendingCount(h), 0, "all of it arrives over the ticks");
});

test("a snapshot shared by several markets is uploaded once in a tick, and every market's record is cleared", async () => {
  const { platform, h } = await closedSnapshots({ markets: 5, urls: () => [URL_A], body: () => "<p>shared</p>" });
  assert.equal(await pendingCount(h), 5);
  const hash = keccak256(utf8("<p>shared</p>"));
  const before = platform.uploads.length;
  await h.tick();
  assert.equal(platform.uploads.slice(before).filter((u) => u.hash === hash).length, 1);
  assert.equal(await pendingCount(h), 0);
});

test("a resumed intent is charged to the per-tick budget like a fresh check", async () => {
  const platform = new Platform();
  const ids = ["1", "2", "3", "4", "5"];
  for (const id of ids) platform.addMarket(id, [URL_A], ["OPEN"]);
  const pages = scriptedSources({ [URL_A]: { body: "x" } });
  const h = await started({ platform, stateDir: await tempDir(), model: countingModel(), fetcher: pages.fetcher });
  h.at(tickTime(0));
  platform.now = tickTime(0);
  platform.beforeUpload = () => {
    throw new TypeError("fetch failed");
  };
  for (let t = 0; t < 3; t++) await h.tick();
  const saved = (await h.state()).watch!;
  assert.deepEqual(ids.filter((id) => saved[id]?.intent), ids, "every market has an intent saved");
  platform.beforeUpload = undefined;
  await h.restart();
  const perTick: number[] = [];
  for (let t = 0; t < 4; t++) {
    const before = platform.submissions.length;
    await h.tick();
    perTick.push(platform.submissions.length - before);
  }
  assert.ok(perTick.every((n) => n <= MAX_MARKETS_WORKED_PER_TICK), `resubmits per tick: ${perTick}`);
  assert.equal(platform.submissions.length, 5);
});

test("a 4xx other than 408 and 429 on submit is final for the window: one attempt, forecast_refused, and the next window still runs", async () => {
  const { platform, h, goTo } = await oneMarket();
  let attempts = 0;
  platform.beforeSubmit = () => {
    attempts++;
    throw apiError(403, "ROLE_REQUIRED");
  };
  for (let i = 0; i < 4; i++) {
    h.at(tickTime(0) + i * 20);
    await h.tick();
  }
  assert.equal(attempts, 1, "one attempt");
  const refused = h.events("forecast_refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.code, "ROLE_REQUIRED");
  const state = await h.state();
  assert.equal(state.watch!["1"]!.intent, undefined);
  assert.ok(state.acted["forecaster.submitted"]!.includes("1-w0"));
  platform.beforeSubmit = undefined;
  goTo(1);
  await h.tick();
  assert.deepEqual(platform.submissions.map((s) => s.windowId), ["1-w1"]);
});

test("a 408 or a 5xx on submit is retried, not final", async () => {
  const { platform, h } = await oneMarket();
  let failures = 2;
  platform.beforeSubmit = () => {
    if (failures-- === 2) throw apiError(408, "REQUEST_TIMEOUT");
    if (failures === 0) throw apiError(502, "BAD_GATEWAY");
  };
  for (let i = 0; i < 5; i++) {
    h.at(tickTime(0) + i * 20);
    await h.tick();
  }
  assert.equal(h.events("forecast_refused").length, 0);
  assert.equal(platform.submissions.length, 1);
});

test("a 400 on the note upload is final too, and drops the intent's snapshots", async () => {
  const { platform, pages, h, goTo } = await oneMarket();
  await h.tick();
  pages.set(URL_A, "<p>changed</p>");
  goTo(1);
  let attempts = 0;
  platform.beforeUpload = (_bytes, mediaType) => {
    if (mediaType !== "application/json") return;
    attempts++;
    throw apiError(400, "INVALID_CONTENT");
  };
  for (let i = 0; i < 3; i++) {
    h.at(tickTime(1) + i * 20);
    await h.tick();
  }
  assert.equal(attempts, 1);
  assert.equal(h.events("forecast_refused").length, 1);
  assert.equal(h.events("forecast_refused")[0]!.code, "INVALID_CONTENT");
  const state = await h.state();
  assert.equal(state.watch!["1"]!.intent, undefined);
  assert.equal(state.watch!["1"]!.pendingSnapshots, undefined);
  await assert.rejects(stat(join(h.stateDir, "snapshots", keccak256(utf8("<p>changed</p>")))), { code: "ENOENT" });
  platform.beforeUpload = undefined;
  goTo(2);
  await h.tick();
  assert.equal(platform.submissions.length, 2);
});

test("a restart after a resumed submit does not analyse the same change again: the intent carries the fingerprints it was based on", async () => {
  const { platform, pages, model, goTo, h } = await oneMarket();
  await h.tick();
  pages.set(URL_A, "<p>changed</p>");
  goTo(1);
  platform.afterSubmitStored = () => {
    platform.afterSubmitStored = undefined;
    throw new TypeError("fetch failed");
  };
  await h.tick();
  const saved = (await h.state()).watch!["1"]!;
  assert.ok(saved.intent && "next" in saved.intent, "the intent names the fingerprints to commit");
  await h.restart();
  await h.tick();
  assert.equal(platform.submissions.length, 2);
  const after = (await h.state()).watch!["1"]!;
  assert.deepEqual(after.sources, (saved.intent as { next: unknown }).next, "committed with the submitted mark");
  assert.equal(after.prior!.windowId, "1-w1");
  goTo(2);
  await h.tick();
  assert.equal(h.events("forecast_decision").at(-1)!.action, "carry_forward");
  assert.equal(model.calls.length, 2, "the cold start and the change; nothing more");
});

test("a state file whose intent names fingerprints that are not valid is corrupt", async () => {
  const dir = await tempDir();
  const intent = (next: unknown) => ({ windowId: "w", kind: "analysis", noteBytes: "{}", probabilityBps: 5000, next });
  const write = (next: unknown) =>
    writeFile(join(dir, "state.json"), JSON.stringify({ salts: {}, acted: {}, fills: {}, watch: { "1": { sources: {}, intent: intent(next) } } }));
  await write({ [URL_A]: { fingerprint: fp, checkedAt: 1 } });
  await loadState(dir);
  await write({ "https://x.example/?q=\\": { fingerprint: fp, checkedAt: 1 } });
  await assert.rejects(loadState(dir), new Error("STATE_CORRUPT"));
  await write({ [URL_A]: { fingerprint: "nope", checkedAt: 1 } });
  await assert.rejects(loadState(dir), new Error("STATE_CORRUPT"));
  await write("x");
  await assert.rejects(loadState(dir), new Error("STATE_CORRUPT"));
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify({ salts: {}, acted: {}, fills: {}, watch: { "1": { sources: {}, intent: { ...intent(undefined), sent: "yes" } } } }),
  );
  await assert.rejects(loadState(dir), new Error("STATE_CORRUPT"), "sent is a boolean");
});

test("when a market leaves OPEN and its record is pruned, the ids of its windows leave the answered list; other markets keep theirs", async () => {
  const platform = new Platform();
  for (const id of ["1", "2", "3", "4"]) platform.addMarket(id, [URL_A], ["OPEN", "UPCOMING"]);
  const pages = scriptedSources({ [URL_A]: { body: "x" } });
  const h = await started({ platform, stateDir: await tempDir(), model: countingModel(), fetcher: pages.fetcher });
  h.at(tickTime(0));
  platform.now = tickTime(0);
  for (let i = 0; i < 4; i++) await h.tick();
  assert.deepEqual((await h.state()).acted["forecaster.submitted"]!.sort(), ["1-w0", "2-w0", "3-w0", "4-w0"]);
  for (const id of ["1", "2", "3"]) platform.closeMarket(id);
  await h.tick();
  assert.deepEqual(Object.keys((await h.state()).watch!), ["3", "4"], "two records are forgotten in a tick");
  await h.tick();
  assert.deepEqual(Object.keys((await h.state()).watch!), ["4"]);
  assert.deepEqual((await h.state()).acted["forecaster.submitted"], ["4-w0"]);
});

test("a clock that jumps backwards does not freeze the retries: an open window is asked about again, a snapshot retry and an analysis retry are due", async () => {
  // A cached OPEN window: the platform closes it, then the clock goes back an hour.
  const open = await oneMarket();
  await open.h.tick();
  open.pages.set(URL_A, "<p>changed</p>");
  open.goTo(1);
  await open.h.tick();
  await open.h.tick();
  const hash = keccak256(utf8("<p>changed</p>"));
  open.platform.setStatus("1", 1, "CLOSED");
  open.h.at(tickTime(1) - 3600);
  await open.h.tick();
  assert.equal(open.platform.contents.has(hash), true, "the window was asked about again");

  // A snapshot retry set an hour ahead is due when the clock goes back.
  const retry = await withPendingSnapshot();
  retry.platform.beforeUpload = (_bytes, mediaType) => {
    if (mediaType === "text/html") throw apiError(503, "INDEX_STALE");
  };
  retry.h.at(retry.deadline + 10);
  await retry.h.tick();
  retry.platform.beforeUpload = undefined;
  retry.h.at(retry.deadline + 10 - 3600);
  await retry.h.tick();
  assert.equal(retry.platform.contents.has(retry.hash), true);

  // An analysis retry spaced from a time that now lies an hour ahead is due.
  const model = countingModel();
  model.failWith = new Error("boom");
  const analysis = await oneMarket({ model });
  await analysis.h.tick();
  analysis.h.at(tickTime(0) - 3600);
  await analysis.h.tick();
  assert.equal(model.calls.length, 2);
});

test("a resumed intent whose note is not for this window is dropped with INTENT_SUBJECT_MISMATCH and never signed", async () => {
  const { platform, model, h } = await oneMarket();
  platform.beforeUpload = () => {
    throw new TypeError("fetch failed");
  };
  await h.tick();
  platform.beforeUpload = undefined;
  const data = await h.state();
  const intent = data.watch!["1"]!.intent!;
  assert.ok(intent.noteBytes.includes('"marketId":"1"'));
  intent.noteBytes = intent.noteBytes.replace('"marketId":"1"', '"marketId":"2"');
  await saveState(h.stateDir, data);
  await h.restart();
  await h.tick();
  assert.equal(platform.submissions.length, 0, "nothing was signed for the wrong note");
  assert.equal(platform.uploads.length, 0);
  const dropped = h.events("intent_dropped");
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]!.reason, "INTENT_SUBJECT_MISMATCH");
  await h.tick();
  assert.equal(platform.submissions.length, 1, "the window is answered afresh");
  assert.ok(noteBelongsTo(noteOf(platform, platform.submissions[0]!), subjectOf(platform, "1", 0)));
  assert.equal(model.calls.length, 2);
});

test("a snapshot file is synced before the state that names it, and the state's temporary file before it is renamed", async () => {
  const { pages, goTo, h } = await oneMarket();
  await h.tick();
  pages.set(URL_A, "<p>changed</p>");
  goTo(1);
  const hash = keccak256(utf8("<p>changed</p>"));
  const probe = await open(join(h.stateDir, "probe"), "w");
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const original = proto.sync;
  const seen: { stateTmp: boolean; snapshotTmp: boolean; stateNamesIt: boolean }[] = [];
  proto.sync = async function (this: unknown) {
    const names = await readdir(h.stateDir).catch(() => [] as string[]);
    const snaps = await readdir(join(h.stateDir, "snapshots")).catch(() => [] as string[]);
    const state = await readFile(join(h.stateDir, "state.json"), "utf8").catch(() => "");
    seen.push({
      stateTmp: names.includes("state.json.tmp"),
      snapshotTmp: snaps.some((n) => n.endsWith(".tmp")),
      stateNamesIt: state.includes(hash),
    });
    return original.call(this);
  };
  try {
    await h.tick();
  } finally {
    proto.sync = original;
  }
  assert.ok(seen.some((s) => s.snapshotTmp && !s.stateNamesIt), "the snapshot is synced before any state names it");
  assert.ok(seen.some((s) => s.stateTmp), "the state's temporary file is synced before the rename");
});

test("housekeeping removes the files in snapshots/ that no record names, and never one that a record still names", async () => {
  const { h, hash, platform } = await (async () => {
    const ctx = await oneMarket();
    await ctx.h.tick();
    ctx.pages.set(URL_A, "<p>changed</p>");
    ctx.goTo(1);
    await ctx.h.tick();
    return { ...ctx, hash: keccak256(utf8("<p>changed</p>")) };
  })();
  const dir = join(h.stateDir, "snapshots");
  const stray = keccak256(utf8("stray"));
  await writeFile(join(dir, stray), "stray");
  await writeFile(join(dir, stray + ".tmp"), "half written");
  await writeFile(join(dir, "notes.txt"), "not ours");
  await h.restart();
  await h.tick();
  const left = (await readdir(dir)).sort();
  assert.deepEqual(left, [hash, "notes.txt"].sort(), "the named file and a foreign file stay; the stray ones go");
  platform.setStatus("1", 1, "CLOSED");
  h.at(tickTime(1) + 3600);
  await h.tick();
  assert.equal(platform.contents.has(hash), true, "the named file was still there to be uploaded");
});

test("two contexts in one process never share the forecaster's memory", async () => {
  const failing = countingModel();
  failing.failWith = new Error("boom");
  const a = await oneMarket({ model: failing });
  const modelB = countingModel();
  const b = await oneMarket({ model: modelB });
  const tick = createForecaster({ now: () => a.h.clock.ms });
  b.h.clock.ms = a.h.clock.ms;
  await tick(a.h.ctx);
  assert.equal(failing.calls.length, 1);
  await tick(b.h.ctx);
  assert.equal(modelB.calls.length, 1, "B is not held back by A's failed attempt for the same market and window ids");
  assert.equal(b.platform.submissions.length, 1);
  // And an idle market in A is not idle in B.
  failing.failWith = undefined as never;
  a.h.clock.ms += 60_000;
  b.h.clock.ms = a.h.clock.ms;
  await tick(a.h.ctx);
  assert.equal(a.platform.submissions.length, 1);
});

test("a window that the platform does not know (404) is final for an intent and for a snapshot", async () => {
  const intentCase = await oneMarket();
  intentCase.platform.beforeUpload = () => {
    throw new TypeError("fetch failed");
  };
  await intentCase.h.tick();
  intentCase.platform.beforeUpload = undefined;
  await intentCase.h.restart();
  intentCase.platform.beforeGetWindow = () => {
    throw apiError(404, "NOT_FOUND");
  };
  await intentCase.h.tick();
  const dropped = intentCase.h.events("intent_dropped");
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]!.reason, "WINDOW_NOT_FOUND");
  assert.ok(intentCase.h.events("forecaster_market_error").every((e) => e.code !== "NOT_FOUND"));
  assert.equal((await intentCase.h.state()).watch!["1"]!.intent === undefined || (await intentCase.h.state()).watch!["1"]!.intent!.windowId === "1-w0", true);

  const snapCase = await withPendingSnapshot();
  snapCase.platform.beforeGetWindow = () => {
    throw apiError(404, "NOT_FOUND");
  };
  await snapCase.h.tick();
  const failed = snapCase.h.events("snapshot_upload_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.code, "WINDOW_NOT_FOUND");
  assert.equal((await snapCase.h.state()).watch!["1"]!.pendingSnapshots, undefined);
  await assert.rejects(stat(join(snapCase.h.stateDir, "snapshots", snapCase.hash)), { code: "ENOENT" });
  const errors = snapCase.h.events("forecaster_market_error").length;
  await snapCase.h.tick();
  assert.equal(snapCase.h.events("forecaster_market_error").length, errors, "no repeated failure");
});

test("a window lookup that fails with another error for a whole give-up period drops the snapshot with WINDOW_LOOKUP_FAILED", async () => {
  const late = await withPendingSnapshot();
  late.platform.beforeGetWindow = () => {
    throw apiError(500, "INTERNAL");
  };
  const first = late.deadline + 10;
  late.h.at(first);
  await late.h.tick();
  assert.equal(late.h.events("snapshot_upload_failed").length, 0, "kept at first");
  late.h.at(first + 86_400 - 1);
  await late.h.tick();
  assert.equal(late.h.events("snapshot_upload_failed").length, 0);
  late.h.at(first + 86_400);
  await late.h.tick();
  const failed = late.h.events("snapshot_upload_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.code, "WINDOW_LOOKUP_FAILED");
  assert.equal((await late.h.state()).watch!["1"]!.pendingSnapshots, undefined);
});

test("an error code in the log comes from a fixed list: an all-caps secret-like message is never logged", async () => {
  const model = countingModel();
  model.failWith = new Error("SECRETTOKEN_ABC123XYZ");
  const { h } = await oneMarket({ model });
  await h.tick();
  const code = h.events("analysis_failed")[0]!.code as string;
  assert.ok(!JSON.stringify(h.lines).includes("SECRETTOKEN"), "the message is not logged");
  assert.match(code, /^[A-Za-z0-9_:]+$/);
  // A code the agent itself throws is still named.
  const known = countingModel();
  known.failWith = new Error("REVISE_INVALID");
  const second = await oneMarket({ model: known });
  await second.h.tick();
  assert.equal(second.h.events("analysis_failed")[0]!.code, "REVISE_INVALID");
});

test("retries are spaced from the time an attempt really started, even when the check before it was slow", async () => {
  const model = countingModel();
  model.failWith = new Error("boom");
  const platform = new Platform();
  platform.addMarket("1", [URL_A], ["OPEN", "UPCOMING"]);
  const pages = scriptedSources({ [URL_A]: { body: "x" } });
  let slow = true;
  let clock: { ms: number } | undefined;
  const fetcher: SourceFetcher = async (url, validators) => {
    if (slow && clock) {
      slow = false;
      clock.ms += 40_000;
    }
    return pages.fetcher(url, validators);
  };
  const h = await started({ platform, stateDir: await tempDir(), model, fetcher });
  clock = h.clock;
  h.at(tickTime(0));
  for (let t = 0; t < 8; t++) {
    await h.tick();
    h.clock.ms += 1000;
  }
  assert.ok(model.calls.length >= 1);
  const times = model.calls.map((c) => c.at);
  for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= 10, `attempts at ${times}`);
});

test("a final refusal (409) marks the window, logs forecast_refused, drops the intent and its snapshots in one save, and sends no second submit", async () => {
  const { platform, pages, goTo, h } = await oneMarket();
  await h.tick();
  pages.set(URL_A, "<p>changed</p>");
  goTo(1);
  platform.submissions.push({
    submissionId: "other",
    windowId: "1-w1",
    forecaster: account.address.toLowerCase(),
    probabilityBps: 4000,
    contentHash: ("0x" + "dd".repeat(32)) as Hex,
    digest: ("0x" + "ee".repeat(32)) as Hex,
    leaf: ("0x" + "ee".repeat(32)) as Hex,
    signature: "0x" as Hex,
    verifiedBlock: 1,
    receivedAt: BASE,
    withdrawnAt: null,
  });
  const disk: { intent: boolean; snapshots: number; acted: boolean }[] = [];
  const realSave = h.ctx.state.save;
  h.ctx.state.save = async () => {
    await realSave();
    const rec = (await h.state()).watch?.["1"];
    disk.push({ intent: !!rec?.intent, snapshots: rec?.pendingSnapshots?.length ?? 0, acted: (await h.state()).acted["forecaster.submitted"]!.includes("1-w1") });
  };
  const bodies = platform.submitBodies.length;
  for (let i = 0; i < 3; i++) {
    h.at(tickTime(1) + i * 20);
    await h.tick();
  }
  assert.equal(platform.submitBodies.length - bodies, 1, "no second submit");
  assert.equal(h.events("forecast_refused").length, 1);
  assert.equal(h.events("forecast_refused")[0]!.code, "FORECAST_ALREADY_SUBMITTED");
  assert.ok(!disk.some((s) => !s.intent && s.snapshots > 0), "the intent and its snapshots are never dropped apart");
  const last = disk.at(-1)!;
  assert.deepEqual(last, { intent: false, snapshots: 0, acted: true });
  await assert.rejects(stat(join(h.stateDir, "snapshots", keccak256(utf8("<p>changed</p>")))), { code: "ENOENT" });
});

test("a windows cursor that the server rejects (INVALID_CURSOR) is dropped and the windows are read from the first page", async () => {
  const platform = new Platform();
  platform.addMarket("1", [URL_A], Array.from({ length: 150 }, (_, i) => (i === 149 ? "OPEN" : "CLOSED")));
  const pages = scriptedSources({ [URL_A]: { body: "x" } });
  const h = await started({ platform, stateDir: await tempDir(), model: countingModel(), fetcher: pages.fetcher });
  h.at(tickTime(149));
  platform.now = tickTime(149);
  h.ctx.state.data.watch = { "1": { sources: {}, windowsCursor: "stale-cursor" } };
  await h.ctx.state.save();
  await h.tick();
  assert.deepEqual(platform.windowReads.map((r) => r.cursor).slice(0, 2), ["stale-cursor", undefined]);
  assert.equal(platform.submissions.length, 1, "the window was found from the first page");
  assert.notEqual((await h.state()).watch!["1"]!.windowsCursor, "stale-cursor");
});

// ---- Review fixes (round 2) ---------------------------------------------------------------------

test("an empty window list does not idle the market for long: a window that opens 40 s later and lasts 80 s is answered while it is open", async () => {
  const platform = new Platform();
  platform.addMarket("1", [URL_A], []);
  const pages = scriptedSources({ [URL_A]: { body: "x" } });
  const h = await started({ platform, stateDir: await tempDir(), model: countingModel(), fetcher: pages.fetcher });
  const t0 = tickTime(0);
  const w: Win = { windowId: "1-w0", horizon: 0, horizonType: "DAILY", scheduledAt: t0 + 120, openAt: t0 + 40, deadline: t0 + 120, status: "UPCOMING", root: null, rootAt: null };
  for (let t = t0; t <= t0 + 130; t += 2) {
    h.at(t);
    platform.now = t;
    if (t === t0 + 10) platform.markets.get("1")!.windows.push(w);
    w.status = t < w.openAt ? "UPCOMING" : t < w.deadline ? "OPEN" : "CLOSED";
    await h.tick();
  }
  assert.equal(platform.submissions.length, 1);
  assert.ok(platform.submissions[0]!.receivedAt < w.deadline, "answered while the window was open");
});

test("a local clock far behind the platform's still answers a window while it is open", async () => {
  const { platform, h } = await oneMarket({ windows: 3 });
  await h.tick();
  const ws = platform.markets.get("1")!.windows;
  ws[0]!.status = "CLOSED";
  platform.now = ws[1]!.openAt - 3000;
  h.at(ws[1]!.openAt - 3000);
  await h.tick();
  platform.openOnly("1", 1);
  let answered = false;
  for (let t = ws[1]!.openAt; t < ws[1]!.deadline; t += 30) {
    platform.now = t;
    h.at(t - 2000);
    await h.tick();
    if (platform.submissions.some((s) => s.windowId === "1-w1")) {
      answered = true;
      break;
    }
  }
  assert.ok(answered);
});

test("an idle market is listed at most once every 30 s: 60 idle markets over 10 ticks of 2 s make at most 60 listings, and keep being listed over a longer time", async () => {
  const platform = new Platform();
  const ids = Array.from({ length: 60 }, (_, i) => String(i + 1));
  for (const id of ids) platform.addMarket(id, [URL_A], ["OPEN", "UPCOMING"]);
  const pages = scriptedSources({ [URL_A]: { body: "x" } });
  const h = await started({ platform, stateDir: await tempDir(), model: countingModel(), fetcher: pages.fetcher });
  h.at(tickTime(0));
  platform.now = tickTime(0);
  for (let t = 0; t < 40 && platform.submissions.length < ids.length; t++) await h.tick();
  assert.equal(platform.submissions.length, 60);
  const start = platform.windowReads.length;
  for (let i = 1; i <= 10; i++) {
    h.at(tickTime(0) + i * 2);
    await h.tick();
  }
  assert.ok(platform.windowReads.length - start <= 60, `${platform.windowReads.length - start} listings`);
  for (let i = 11; i <= 40; i++) {
    h.at(tickTime(0) + i * 2);
    await h.tick();
  }
  const total = platform.windowReads.length - start;
  assert.ok(total >= 60 && total <= 180, `${total} listings over 80 s`);
});

test("a page that ends with an OPEN window does not hide the next page: windows 99 and 100 are both answered while open", async () => {
  const platform = new Platform();
  platform.addMarket("1", [URL_A], Array.from({ length: 101 }, (_, i) => (i < 99 ? "CLOSED" : i === 99 ? "OPEN" : "UPCOMING")));
  const ws = platform.markets.get("1")!.windows;
  const d = ws[99]!.deadline;
  ws[100]!.scheduledAt = d + 5;
  ws[100]!.deadline = d + 5;
  ws[100]!.openAt = d + 5 - 1800;
  const pages = scriptedSources({ [URL_A]: { body: "x" } });
  const h = await started({ platform, stateDir: await tempDir(), model: countingModel(), fetcher: pages.fetcher });
  h.at(ws[99]!.openAt + 10);
  platform.now = ws[99]!.openAt + 10;
  await h.tick();
  ws[100]!.status = "OPEN";
  for (let t = 1; t < 50; t++) {
    h.at(ws[99]!.openAt + 10 + t * 30);
    platform.now = h.clock.ms / 1000;
    await h.tick();
  }
  const answered = platform.submissions.map((s) => s.windowId).sort();
  assert.deepEqual(answered, ["1-w100", "1-w99"]);
  // The saved cursor never moved past a page that held an open window.
  assert.equal((await h.state()).watch!["1"]!.windowsCursor, undefined);
});

test("an intent whose submit may have reached the platform survives a final refusal: after the window closes, prior is set and the snapshots are uploaded", async () => {
  const { platform, pages, h, goTo } = await oneMarket();
  await h.tick();
  pages.set(URL_A, "<p>changed</p>");
  goTo(1);
  // The answer is stored but the response is lost; from then on the role is revoked.
  platform.afterSubmitStored = () => {
    platform.afterSubmitStored = undefined;
    platform.beforeSubmit = () => {
      throw apiError(403, "ROLE_REQUIRED");
    };
    throw new TypeError("fetch failed");
  };
  await h.tick();
  assert.equal((await h.state()).watch!["1"]!.intent!.sent, true, "saved before the first submit");
  await h.tick();
  assert.equal(h.events("forecast_refused")[0]!.code, "ROLE_REQUIRED");
  const kept = await h.state();
  assert.ok(kept.watch!["1"]!.intent, "kept for the settlement");
  assert.ok(kept.acted["forecaster.submitted"]!.includes("1-w1"));
  const hash = keccak256(utf8("<p>changed</p>"));
  assert.equal(platform.contents.has(hash), false, "not before the window closes");
  platform.setStatus("1", 1, "CLOSED");
  h.at(tickTime(1) + 3600);
  await h.tick();
  const after = (await h.state()).watch!["1"]!;
  assert.equal(after.intent, undefined);
  assert.equal(after.prior!.windowId, "1-w1");
  assert.equal(after.prior!.digest, platform.submissions[1]!.digest);
  assert.equal(platform.contents.has(hash), true);
});

/** Markets that left OPEN, each with a record; `failing` ones cannot have their windows read. */
async function leftOpen(failing: string[], healthy: string) {
  const platform = new Platform();
  const ids = [...failing, healthy];
  for (const id of ids) platform.addMarket(id, [URL_A], ["OPEN"]);
  const pages = scriptedSources({ [URL_A]: { body: "x" } });
  const h = await started({ platform, stateDir: await tempDir(), model: countingModel(), fetcher: pages.fetcher });
  h.at(tickTime(0));
  platform.now = tickTime(0);
  for (let t = 0; t < ids.length + 2; t++) await h.tick();
  assert.equal(platform.submissions.length, ids.length);
  for (const id of ids) platform.closeMarket(id);
  platform.beforeListWindows = (id) => {
    if (failing.includes(id)) throw apiError(500, "INTERNAL");
  };
  return { platform, h };
}

test("markets whose windows cannot be read do not starve the healthy ones: pruning takes two markets a tick and a failing market goes to the back", async () => {
  const three = await leftOpen(["1", "2", "3"], "4");
  await three.h.tick();
  await three.h.tick();
  assert.equal((await three.h.state()).watch!["4"], undefined, "pruned within two ticks");
  const six = await leftOpen(["1", "2", "3", "4", "5", "6"], "7");
  for (let t = 0; t < 4; t++) await six.h.tick();
  assert.equal((await six.h.state()).watch!["7"], undefined, "pruned within four ticks");
  assert.deepEqual(Object.keys((await six.h.state()).watch!).sort(), ["1", "2", "3", "4", "5", "6"]);
});
