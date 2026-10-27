import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BlinkApiError, GM_LT_V1 } from "../packages/client/src/index.ts";
import { loadAgentEnv } from "../examples/agents/src/lib/env.ts";
import type { AgentContext } from "../examples/agents/src/lib/env.ts";
import { createLogger } from "../examples/agents/src/lib/log.ts";
import { runAgent } from "../examples/agents/src/lib/loop.ts";
import { fixtureModel, type MarketView } from "../examples/agents/src/lib/model.ts";
import { emptyState, loadState, saveState } from "../examples/agents/src/lib/state.ts";
import { parseWorld } from "../examples/agents/src/lib/world.ts";

const KEY = "0x" + "11".repeat(32);
const API_SECRET = "blk_live_" + "d4".repeat(16);
const repository = fileURLToPath(new URL("..", import.meta.url));

async function tempDir() {
  return mkdtemp(join(tmpdir(), "blink-agents-test-"));
}
async function withTemp<T>(run: (dir: string) => Promise<T>) {
  const dir = await tempDir();
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A JSON-RPC node that answers `eth_chainId` with the given chain. */
async function stubNode(chainId: number) {
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { id } = JSON.parse(body) as { id: number };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x" + chainId.toString(16) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const environment = (rpc: string): Record<string, string> => ({
  BLINK_AGENT_NAME: "alice",
  BLINK_AGENT_ROLES: "trader,maker",
  BLINK_API_URL: "http://127.0.0.1:3001",
  BLINK_RPC_URL: rpc,
  BLINK_AGENT_KEY: KEY,
  BLINK_WORLD: "/tmp/world.json",
  BLINK_AGENT_STATE_DIR: "/tmp/state",
});

test("loadAgentEnv rejects a missing variable and a non-84532 chain", async () => {
  const good = await stubNode(84532);
  const wrong = await stubNode(1);
  try {
    const env = await loadAgentEnv(environment(good.url));
    assert.deepEqual(env.roles, ["trader", "maker"]);
    assert.equal(env.name, "alice");
    for (const name of Object.keys(environment(good.url))) {
      const { [name]: _removed, ...rest } = environment(good.url);
      await assert.rejects(loadAgentEnv(rest), new Error(`MISSING_ENV:${name}`));
    }
    await assert.rejects(loadAgentEnv(environment(wrong.url)), new Error("WRONG_CHAIN"));
    // The key is only ever sent to a node on this machine, and a malformed value is refused by name.
    await assert.rejects(
      loadAgentEnv(environment("https://rpc.blink.invalid")),
      new Error("RPC_NOT_LOOPBACK"),
    );
    await assert.rejects(
      loadAgentEnv({ ...environment(good.url), BLINK_AGENT_ROLES: "trader,wizard" }),
      new Error("INVALID_ENV:BLINK_AGENT_ROLES"),
    );
    await assert.rejects(
      loadAgentEnv({ ...environment(good.url), BLINK_AGENT_KEY: "0x1234" }),
      (error: Error) => error.message === "INVALID_ENV:BLINK_AGENT_KEY" && !error.message.includes("1234"),
    );
  } finally {
    await good.close();
    await wrong.close();
  }
});

const apiError = (code: string) => ({
  code: code as never,
  message: "refused",
  requestId: "r",
  retryable: true,
  details: {},
});
/** The part of a context the loop touches: its log. */
function stubContext() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger("alice", [], (line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  return { ctx: { name: "alice", log } as unknown as AgentContext, lines };
}

test("loop backs off on INDEX_STALE and 429 and keeps ticking", async () => {
  const { ctx, lines } = stubContext();
  const stop = new AbortController();
  const slept: number[] = [];
  let calls = 0;
  let skipped = 0;
  const failing = async () => {
    calls++;
    if (calls === 1) throw new BlinkApiError(503, apiError("INDEX_STALE"), 2);
    // No Retry-After: the default is five seconds.
    if (calls === 2) throw new BlinkApiError(429, apiError("RATE_LIMITED"));
    if (calls === 3) throw new Error("NO_USABLE_QUOTE: " + KEY);
    if (calls === 4) stop.abort();
  };
  await runAgent(
    ctx,
    [failing, async () => void skipped++],
    { tickMs: 10, signal: stop.signal, sleep: async (ms) => void slept.push(ms) },
  );
  assert.equal(calls, 4);
  const backoffs = lines.filter((l) => l.event === "backoff");
  assert.deepEqual(
    backoffs.map((l) => [l.status, l.code, l.retryAfterSeconds]),
    [
      [503, "INDEX_STALE", 2],
      [429, "RATE_LIMITED", 5],
    ],
  );
  // Each wait is the server's Retry-After, then the normal period once the tick works again.
  assert.deepEqual(slept.slice(0, 2), [2000, 5000]);
  // The two rounds that backed off skipped their second tick; the round with a plain error ran it,
  // and the round that was stopped ended with its first tick. The error was logged by code only.
  assert.equal(skipped, 1);
  const failure = lines.find((l) => l.event === "tick_error");
  assert.deepEqual(failure && failure.code, "NO_USABLE_QUOTE");
  assert.ok(!JSON.stringify(lines).includes(KEY));
});

test("the loop ends after the running tick when it is stopped", async () => {
  const { ctx } = stubContext();
  const stop = new AbortController();
  let finished = false;
  const later = async () => void assert.fail("the next tick must not start");
  const slow = async () => {
    stop.abort();
    await new Promise((r) => setTimeout(r, 20));
    finished = true;
  };
  await runAgent(ctx, [slow, later], { tickMs: 10_000, signal: stop.signal });
  assert.equal(finished, true);
});

test("state survives a rename-write and a reload", async () => {
  await withTemp(async (parent) => {
    const dir = join(parent, "nested", "state");
    assert.deepEqual(await loadState(dir), emptyState());
    const state = {
      apiKeyId: "00000000-0000-4000-8000-000000000001",
      salts: { "dispute-1": "0x" + "ab".repeat(32) },
      acted: { "creator.created": ["1", "2"] },
      fills: { "7": { digest: ("0x" + "cd".repeat(32)) as `0x${string}`, expiresAt: "1700000000" } },
    };
    await saveState(dir, state);
    // Only the finished file is left: the temporary one was renamed over it.
    assert.deepEqual(await readdir(dir), ["state.json"]);
    assert.deepEqual(await loadState(dir), state);
    await saveState(dir, { ...state, acted: {} });
    assert.deepEqual((await loadState(dir)).acted, {});
    await writeFile(join(dir, "state.json"), "{not json");
    await assert.rejects(loadState(dir), new Error("STATE_CORRUPT"));
  });
});

const spec = (title: string, extra: Record<string, unknown> = {}) => ({
  schema: "blink.market-spec/0.2",
  title,
  question: title + "?",
  class: "B",
  resolution: { yes: "Yes.", no: "No." },
  sources: ["https://example.com/" + encodeURIComponent(title)],
  ...extra,
});
const worldJson = () => ({
  questions: {
    gas: { spec: spec("Gas above 1 gwei"), closeInSeconds: 300, maxPairs: 100 },
    margin: {
      spec: spec("Gross margin below 65 percent", {
        class: "A",
        sources: ["https://example.com/results"],
        computation: {
          templateId: GM_LT_V1.templateId,
          parserHash: GM_LT_V1.parserHash,
          extraction: '{"thresholdBps":6500}',
        },
      }),
      closeInSeconds: 300,
      maxPairs: 100,
      sources: { "https://example.com/results": "results.txt" },
    },
    unsourced: {
      spec: spec("Unsourced margin", {
        class: "A",
        computation: {
          templateId: GM_LT_V1.templateId,
          parserHash: GM_LT_V1.parserHash,
          extraction: '{"thresholdBps":6500}',
        },
      }),
      closeInSeconds: 300,
      maxPairs: 100,
    },
  },
  suggestions: { "Will it rain?": "gas" },
  agents: {
    alice: {
      roles: ["creator", "proposer"],
      creates: ["gas"],
      claimsSuggestions: true,
      beliefs: {
        gas: {
          outcome: "YES",
          probabilityBps: 7000,
          objection: { ground: "AMBIGUOUS", evidence: "which block?" },
          appeal: true,
        },
        // A stated outcome on a class A market is never read.
        margin: { outcome: "NO" },
        unsourced: { outcome: "YES" },
      },
    },
    bob: { roles: ["proposer"], beliefs: { gas: { outcome: "NO", probabilityBps: 2500 } } },
    carol: { roles: ["juror"], beliefs: {} },
  },
});
const view = (world: ReturnType<typeof parseWorld>, key: string): MarketView => ({
  marketId: 1n,
  specHash: ("0x" + "00".repeat(32)) as `0x${string}`,
  spec: world.questions[key]!.spec,
});

test("fixture model answers only from its own beliefs", async () => {
  await withTemp(async (dir) => {
    // 61.25% is below the 65% threshold, so the template says YES whatever anyone states.
    await writeFile(join(dir, "results.txt"), "GAAP gross margin was 61.25% in the quarter.");
    const world = parseWorld(worldJson(), dir);
    const [alice, bob, carol] = ["alice", "bob", "carol"].map((n) => fixtureModel(world, n)) as [
      ReturnType<typeof fixtureModel>,
      ReturnType<typeof fixtureModel>,
      ReturnType<typeof fixtureModel>,
    ];
    const gas = view(world, "gas");

    // Same world, same market, different agents, different answers.
    assert.equal((await alice.outcome(gas))?.outcome, "YES");
    assert.equal((await bob.outcome(gas))?.outcome, "NO");
    assert.equal(await carol.outcome(gas), null);
    assert.equal(await alice.probabilityBps(gas), 7000);
    assert.equal(await bob.probabilityBps(gas), 2500);
    assert.equal(await carol.probabilityBps(gas), null);
    assert.equal(await alice.appeal(gas), true);
    assert.equal(await bob.appeal(gas), false);
    const objection = await alice.creationObjection(gas);
    assert.equal(objection?.ground, "AMBIGUOUS");
    assert.equal(new TextDecoder().decode(objection!.evidence), "which block?");
    assert.equal(await bob.creationObjection(gas), null);

    assert.deepEqual((await alice.questions()).map((q) => q.key), ["gas"]);
    assert.deepEqual(await bob.questions(), []);
    assert.equal((await alice.fromSuggestion("Will it rain?"))?.key, "gas");
    assert.equal(await bob.fromSuggestion("Will it rain?"), null);
    assert.equal(await alice.fromSuggestion("unknown text"), null);

    // Class A: computed from the source bytes by the template, for every agent that has the source.
    const margin = view(world, "margin");
    const computed = await alice.outcome(margin);
    assert.equal(computed?.outcome, "YES");
    assert.equal(new TextDecoder().decode(computed!.evidence), "GAAP gross margin was 61.25% in the quarter.");
    assert.equal((await bob.outcome(margin))?.outcome, "YES");
    // No source for the market: null, even though alice states an outcome for it.
    assert.equal(await alice.outcome(view(world, "unsourced")), null);
    // A market that is not in the world is unknown to everyone.
    const stranger = { ...gas, spec: { ...gas.spec, title: "Not in the world" } };
    assert.equal(await alice.outcome(stranger), null);
  });
});

test("a world file is validated strictly", () => {
  const dir = tmpdir();
  const broken = (change: (w: ReturnType<typeof worldJson>) => unknown) => {
    const w = worldJson();
    return () => parseWorld(change(w) ?? w, dir);
  };
  assert.doesNotThrow(() => parseWorld(worldJson(), dir));
  assert.throws(broken((w) => void ((w as Record<string, unknown>).extra = 1)), /WORLD_INVALID: world.extra/);
  assert.throws(
    broken((w) => void (w.questions.gas.spec.title = w.questions.margin.spec.title)),
    /titles must be unique/,
  );
  assert.throws(
    broken((w) => void ((w.questions.margin as Record<string, unknown>).sources = { "https://x.test/a": "../secret" })),
    /outside the world directory/,
  );
  assert.throws(broken((w) => void (w.agents.alice.roles = ["wizard"] as never)), /roles/);
  assert.throws(broken((w) => void (w.suggestions["Will it rain?"] = "missing")), /unknown question/);
  assert.throws(
    broken((w) => void ((w.agents.bob.beliefs.gas as Record<string, unknown>).probabilityBps = 1.5)),
    /probabilityBps/,
  );
});

test("logs never contain the key or the API secret", () => {
  const lines: string[] = [];
  const log = createLogger("alice", [KEY], (line) => lines.push(line));
  // The runtime registers the API secret the moment it has one.
  log.redact(API_SECRET);
  log("started", { roles: ["trader"], note: `key ${KEY}` });
  log("api_key_issued", { header: `Bearer ${API_SECRET}`, nested: { secret: API_SECRET, n: 3n } });
  log("tick_error", { code: "FILL_REVERTED" });
  assert.equal(lines.length, 3);
  const output = lines.join("\n");
  assert.ok(!output.includes(KEY) && !output.includes(API_SECRET), output);
  for (const line of lines) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    assert.equal(entry.agent, "alice");
    assert.match(String(entry.ts), /^\d{4}-\d{2}-\d{2}T/);
  }
  assert.equal((JSON.parse(lines[1]!) as { nested: { n: string } }).nested.n, "3");
});

/** A tree with just enough packages for the boundary checker, plus the example files given. */
async function fixtureTree(files: Record<string, string>) {
  const dir = await tempDir();
  const put = async (path: string, text: string) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  };
  for (const name of ["schemas", "domain", "ports", "application", "adapters", "runtime", "client"]) {
    await put(`packages/${name}/package.json`, "{}");
    await put(`packages/${name}/src/index.ts`, "export {};\n");
  }
  for (const name of ["web", "worker"]) await put(`apps/${name}/package.json`, "{}");
  for (const [path, text] of Object.entries(files)) await put(path, text);
  return dir;
}
function runBoundaries(cwd: string) {
  const run = spawnSync(process.execPath, [join(repository, "scripts/check-boundaries.mjs")], {
    cwd,
    encoding: "utf8",
  });
  return { status: run.status, output: run.stdout + run.stderr };
}

test("boundary check rejects an examples import of @blink/schemas, an adapters path and an inline parseAbi", async () => {
  const clean = await fixtureTree({
    "examples/agents/src/main.ts": [
      'import { createBlinkClient } from "@blink/client";',
      'import { GM_LT_V1 } from "@blink/client/templates/gm-lt-v1";',
      'import { http } from "viem";',
      'import { privateKeyToAccount } from "viem/accounts";',
      'import { readFile } from "node:fs/promises";',
      'import { helper } from "./lib/helper.ts";',
      "export {};",
    ].join("\n"),
    "examples/agents/src/lib/helper.ts": 'import { main } from "../main.ts";\nexport const helper = 1;\n',
  });
  const dirty = await fixtureTree({
    "examples/agents/src/schemas.ts": 'import { quoteTypes } from "@blink/schemas";\n',
    "examples/agents/src/adapters.ts": 'import { x } from "../../../packages/adapters/src/index.ts";\n',
    "examples/agents/src/outside.ts": 'import { y } from "../../other/thing.ts";\n',
    "examples/agents/src/abi.ts": 'import { parseAbi } from "viem";\nexport const abi = parseAbi(["function x()"]);\n',
    "examples/agents/src/paths.ts": 'export const out = "contracts/out/Blink.json";\nexport const app = "apps/web";\n',
    "examples/agents/src/dynamic.ts": 'export const load = () => import("pg");\n',
  });
  try {
    const ok = runBoundaries(clean);
    assert.equal(ok.status, 0, ok.output);
    const bad = runBoundaries(dirty);
    assert.equal(bad.status, 1, bad.output);
    assert.match(bad.output, /schemas\.ts: .*@blink\/schemas/);
    assert.match(bad.output, /adapters\.ts: .*packages\/adapters/);
    assert.match(bad.output, /adapters\.ts: an example must not name packages\//);
    assert.match(bad.output, /outside\.ts: .*other\/thing/);
    assert.match(bad.output, /abi\.ts: .*parseAbi/);
    assert.match(bad.output, /paths\.ts: an example must not name contracts\/out/);
    assert.match(bad.output, /paths\.ts: an example must not name apps\//);
    assert.match(bad.output, /dynamic\.ts: .*not pg/);
  } finally {
    await rm(clean, { recursive: true, force: true });
    await rm(dirty, { recursive: true, force: true });
  }
});
