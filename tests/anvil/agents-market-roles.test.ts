import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bytesToHex, decodeEventLog, keccak256, type Abi, type Hex, type HDAccount, type LocalAccount } from "viem";
import {
  GM_LT_V1,
  NO_CONTENT_HASH,
  ROLE,
  agentAbi,
  createBlinkClient,
  forecastDigest,
  forecastTypedData,
  parseMarketSpec,
} from "../../packages/client/src/index.ts";
import { createContext, type AgentContext } from "../../examples/agents/src/lib/env.ts";
import { createLogger } from "../../examples/agents/src/lib/log.ts";
import { runAgent } from "../../examples/agents/src/lib/loop.ts";
import { fixtureModel } from "../../examples/agents/src/lib/model.ts";
import { onboard } from "../../examples/agents/src/lib/session.ts";
import { loadState, saveState } from "../../examples/agents/src/lib/state.ts";
import { parseWorld } from "../../examples/agents/src/lib/world.ts";
import { creator } from "../../examples/agents/src/roles/creator.ts";
import { forecaster } from "../../examples/agents/src/roles/forecaster.ts";
import { maker, makerStop } from "../../examples/agents/src/roles/maker.ts";
import { createTrader } from "../../examples/agents/src/roles/trader.ts";
import { startAlphaPlatform, waitFor, type AlphaPlatform } from "../../scripts/alpha/platform.ts";
import type { RoleTick } from "../../examples/agents/src/lib/loop.ts";

// One platform for the file. Agents run their ticks in process, on the wall clock of the platform:
// the windows of the alpha preset (60 s creation window, 30 s extra for a new template, 60 s result
// challenge) are waited out, never skipped. The chain is not moved ahead because the API and the
// indexer would not follow. Wallet challenges spent: 7, one per onboarded agent (a fresh state
// directory has no earlier key to revoke); the API allows 30 per IP per hour.
const UNIT = 1_000_000n;
const TEXT_S1 = "Will the sample company report a GAAP gross margin below 40 percent?";
const TEXT_S2 = "Will the sample company report a GAAP gross margin below 45 percent?";

const classB = (title: string) => ({
  schema: "blink.market-spec/0.2",
  title,
  question: title + "?",
  class: "B",
  resolution: { yes: "Yes.", no: "No." },
  sources: ["https://example.com/" + encodeURIComponent(title)],
});
const classA = (title: string, thresholdBps: number) => ({
  ...classB(title),
  class: "A",
  computation: {
    templateId: GM_LT_V1.templateId,
    parserHash: GM_LT_V1.parserHash,
    extraction: JSON.stringify({ thresholdBps }),
  },
});
const worldJson = (crashTitle: string) => ({
    questions: {
      crash: { spec: classB(crashTitle), closeInSeconds: 240, maxPairs: 2 },
      clamp: { spec: classB("Clamp market"), closeInSeconds: 600, maxPairs: 100 },
      gm: { spec: classA("Gross margin below 40", 4000), closeInSeconds: 240, maxPairs: 100 },
      gm2: { spec: classA("Gross margin below 45", 4500), closeInSeconds: 240, maxPairs: 50 },
      sugg: { spec: classB("Suggested market"), closeInSeconds: 600, maxPairs: 20 },
    },
    suggestions: { [TEXT_S1]: "sugg", [TEXT_S2]: "sugg" },
    agents: {
      clamper: { roles: ["creator"], creates: ["clamp"], claimsSuggestions: true, beliefs: {} },
      // The same identity as the clamper after a restart, with a model whose answers have changed.
      crasher: { roles: ["creator"], creates: ["crash"], claimsSuggestions: true, beliefs: {} },
      creatorA: { roles: ["creator"], creates: ["gm", "gm2"], claimsSuggestions: true, beliefs: {} },
      makerA: { roles: ["maker"], beliefs: { gm: { probabilityBps: 7000 } } },
      makerB: { roles: ["maker"], beliefs: { gm: { probabilityBps: 6000 } } },
      trader: { roles: ["trader"], beliefs: { gm: { probabilityBps: 8000 } } },
      forecaster: { roles: ["forecaster"], beliefs: { gm: { probabilityBps: 6500 } } },
    },
});
const world = parseWorld(worldJson("Crash market"), tmpdir());
const changedWorld = parseWorld(worldJson("Crash market, reworded"), tmpdir());

type Line = { event: string; [field: string]: unknown };
type Agent = { ctx: AgentContext; lines: Line[]; stateDir: string; writes: string[] };

let platform: AlphaPlatform;
let anonymous: ReturnType<typeof createBlinkClient>;
const dirs: string[] = [];
const ids: Record<string, string> = {};
let creatorA: Agent;
let clamper: Agent;
let makerA: Agent;
let makerB: Agent;
let trader: Agent;
let suggestionTwo = "";

/** The funded public test accounts of the platform's Anvil. */
const accounts = new Proxy({} as AlphaPlatform["accounts"], {
  get: (_target, name) => platform.accounts[name as keyof AlphaPlatform["accounts"]],
});
const markets = () => platform.deployment.generation.markets as Hex;

before(async () => {
  platform = await startAlphaPlatform({ backend: "pglite" });
  anonymous = createBlinkClient(platform.apiUrl);
});
after(async () => {
  await platform?.stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** An onboarded agent whose model answers as `modelName` of the world; every transaction it sends is listed in `writes`. */
async function startAgent(label: string, modelName: string, account: HDAccount, roles: AgentContext["roles"]): Promise<Agent> {
  const key = bytesToHex(account.getHdKey().privateKey!);
  const stateDir = await mkdtemp(join(tmpdir(), "blink-market-roles-"));
  dirs.push(stateDir);
  const lines: Line[] = [];
  const ctx = await createContext(
    { name: label, roles, apiUrl: platform.apiUrl, rpcUrl: platform.rpcUrl, key, worldPath: "", stateDir },
    {
      model: fixtureModel(world, modelName),
      log: createLogger(label, [key], (line) => lines.push(JSON.parse(line) as Line)),
      pollingIntervalMs: 100,
    },
  );
  await onboard(ctx);
  const writes: string[] = [];
  const realWrite = ctx.walletClient.writeContract.bind(ctx.walletClient);
  (ctx.walletClient as { writeContract: unknown }).writeContract = (request: { functionName: string }) => {
    writes.push(request.functionName);
    return (realWrite as (r: unknown) => Promise<Hex>)(request);
  };
  return { ctx, lines, stateDir, writes };
}

/**
 * One tick of a role. The loop backs off on `429` and `503 INDEX_STALE`; a test that calls a tick
 * directly waits the same way, because a loaded host can leave the index a little behind.
 */
async function tick(role: RoleTick, ctx: AgentContext) {
  for (let attempt = 1; ; attempt++)
    try {
      return await role(ctx);
    } catch (error) {
      const refusal = error as { status?: number; body?: { code?: string }; retryAfterSeconds?: number };
      const backoff = refusal.status === 429 || refusal.body?.code === "INDEX_STALE";
      if (!backoff || attempt >= 10)
        throw refusal.body === undefined ? error : new Error(`${refusal.status} ${refusal.body.code}`);
      await new Promise((r) => setTimeout(r, (refusal.retryAfterSeconds ?? 2) * 1000));
    }
}

/** A transaction sent by a test account itself (the arbiter's stake, a keeper's call), waited for. */
async function write(who: LocalAccount, address: string, abi: Abi, functionName: string, args: unknown[] = []) {
  const receipt = await platform.anvil.publicClient.waitForTransactionReceipt({
    hash: await platform.anvil.wallet(who).writeContract({ address: address as Hex, abi, functionName, args, gas: 5_000_000n } as never),
  });
  assert.equal(receipt.status, "success", functionName);
  return receipt;
}
const chainRead = <T>(address: string, abi: Abi, functionName: string, args: unknown[] = []) =>
  platform.anvil.publicClient.readContract({ address: address as Hex, abi, functionName, args } as never) as Promise<T>;
const chainMarket = (id: string) =>
  chainRead<{ maxPairs: bigint; specHash: Hex; openAt: bigint; closeAt: bigint }>(markets(), agentAbi.markets, "getMarket", [BigInt(id)]);
const chainNow = async () => (await platform.anvil.publicClient.getBlock()).timestamp;
const untilChainTime = (seconds: bigint) =>
  waitFor("chain time " + seconds, async () => (await chainNow()) >= seconds, 400_000, 500);

let arbiterReady = false;
/** The arbiter stakes platform tokens: createMarket is bounded by what the jurors have at stake. */
async function stakeJurors(tokens: bigint) {
  const { shared, generation, params } = platform.deployment;
  const arbiter = accounts.arbiter;
  if (!arbiterReady) {
    await write(arbiter, shared.faucet, agentAbi.faucet as Abi, "claim");
    await write(arbiter, shared.busd, agentAbi.usd as Abi, "approve", [generation.registry, BigInt(params.registrationFee)]);
    await write(arbiter, generation.registry, agentAbi.registry as Abi, "register");
    arbiterReady = true;
  }
  await write(arbiter, shared.token, agentAbi.platformToken as Abi, "approve", [generation.jurors, tokens]);
  await write(arbiter, generation.jurors, agentAbi.jurors as Abi, "stake", [tokens]);
}

const eventsOf = (agent: Agent, name: string) => agent.lines.filter((l) => l.event === name);
/** What a restarted process does: the state is read back from its directory. */
async function restart(agent: Agent) {
  const data = await loadState(agent.stateDir);
  agent.ctx.state = { data, save: () => saveState(agent.stateDir, data) };
}
/** Makes the next transaction of `functionName` land and then fail with a lost answer, once. */
function loseAnswerOnce(agent: Agent, functionName: string) {
  const send = agent.ctx.walletClient.writeContract.bind(agent.ctx.walletClient) as (r: { functionName: string }) => Promise<Hex>;
  let lost = false;
  (agent.ctx.walletClient as { writeContract: unknown }).writeContract = async (request: { functionName: string }) => {
    const hash = await send(request);
    if (request.functionName !== functionName || lost) return hash;
    lost = true;
    await platform.anvil.publicClient.waitForTransactionReceipt({ hash });
    throw new Error("socket hang up");
  };
}
const depositsOf = async (address: string) =>
  ((await platform.anvil.publicClient.getContractEvents({
    address: markets(),
    abi: agentAbi.markets,
    eventName: "MakerDeposited",
    args: { maker: address },
    fromBlock: 0n,
  } as never)) as unknown[]).length;
const createdBy = (address: string) =>
  platform.anvil.publicClient.getContractEvents({
    address: markets(),
    abi: agentAbi.markets,
    eventName: "MarketCreated",
    args: { creator: address },
    fromBlock: 0n,
  } as never) as unknown as Promise<{ args: { marketId: bigint } }[]>;
const marketsWithSuggestion = async (suggestionId: string) =>
  (await anonymous.listMarkets({ limit: 100 })).items.filter(
    (i) => i.spec.ok && i.spec.spec.suggestionId === suggestionId,
  );

/** Waits for the creation window, then opens the market as a keeper would, and for the index to show it. */
async function openMarket(id: string) {
  await untilChainTime((await chainMarket(id)).openAt);
  await write(accounts.keeper, markets(), agentAbi.markets as Abi, "open", [BigInt(id)]);
  await waitFor("market " + id + " open in the index", async () => (await anonymous.getMarket({ marketId: id })).market.state === "OPEN", 120_000);
}

test("creator clamps maxPairs to the security bound", { timeout: 300_000 }, async () => {
  clamper = await startAgent("clamper", "clamper", accounts.minter, ["creator"]);
  const nonce = () => platform.anvil.publicClient.getTransactionCount({ address: accounts.minter.address });

  // No juror stake, so no room under the security bound: nothing is sent.
  const sent = await nonce();
  await tick(creator, clamper.ctx);
  // Said once, not on every tick, while the room stays as it is.
  await tick(creator, clamper.ctx);
  assert.equal(await nonce(), sent, "no transaction");
  assert.equal(eventsOf(clamper, "cap_exhausted").length, 1);
  assert.equal(eventsOf(clamper, "market_created").length, 0);

  // 10 tokens at 1 bUSD each: attack cost 5 bUSD, over the 2x multiple, leaves room for 2 pairs.
  await stakeJurors(10n * 10n ** 18n);
  await tick(creator, clamper.ctx);
  const made = eventsOf(clamper, "market_created");
  assert.equal(made.length, 1);
  assert.equal(made[0]!.maxPairs, "2");
  assert.equal((await chainMarket(String(made[0]!.marketId))).maxPairs, 2n);
});

test("creator registers GM_LT_V1 once and creates a class A market whose spec bytes hash to specHash", { timeout: 300_000 }, async () => {
  await stakeJurors(990n * 10n ** 18n);
  creatorA = await startAgent("creatorA", "creatorA", accounts.admin, ["creator"]);
  await tick(creator, creatorA.ctx);
  // Two class A drafts share one template registration; the second tick has nothing left to do.
  assert.equal(creatorA.writes.filter((w) => w === "registerTemplate").length, 1);
  assert.equal(creatorA.writes.filter((w) => w === "createMarket").length, 2);
  await tick(creator, creatorA.ctx);
  assert.equal(creatorA.writes.filter((w) => w === "createMarket").length, 2);

  const made = eventsOf(creatorA, "market_created");
  ids.gm = String(made.find((l) => l.key === "gm")!.marketId);
  ids.gm2 = String(made.find((l) => l.key === "gm2")!.marketId);
  const specHash = String(made.find((l) => l.key === "gm")!.specHash) as Hex;
  const bytes = new TextEncoder().encode(JSON.stringify(world.questions.gm!.spec));
  assert.equal(specHash, keccak256(bytes));
  assert.equal((await chainMarket(ids.gm)).specHash, specHash);
  assert.deepEqual(await anonymous.getContent(specHash), bytes);
  assert.deepEqual(
    await anonymous.getContent(GM_LT_V1.parserHash),
    new Uint8Array(await readFile(new URL("../../packages/client/src/templates/gm-lt-v1.ts", import.meta.url))),
  );

  const { market } = await waitFor("the class A market in the index", async () => anonymous.getMarket({ marketId: ids.gm! }));
  assert.equal(market.specHash, specHash);
  assert.equal(market.specUri, `/v1/content/${specHash}`);
  assert.equal(market.class, "A");
  assert.equal(market.templateId, GM_LT_V1.templateId);
  assert.equal(market.maxPairs, "100");
  const templates = await waitFor("the template in the index", async () => {
    const listed = (await anonymous.listTemplates({ limit: 100 })).items;
    return listed.some((t) => t.templateId === GM_LT_V1.templateId) ? listed : null;
  });
  assert.equal(templates.find((t) => t.templateId === GM_LT_V1.templateId)!.class, "A");
});

test("creator claims a suggestion and records suggestionId", { timeout: 300_000 }, async () => {
  const { id } = await anonymous.submitSuggestion({ text: TEXT_S1 });
  await tick(creator, creatorA.ctx);
  assert.equal(eventsOf(creatorA, "suggestion_claimed").filter((l) => l.suggestionId === id).length, 1);
  const made = eventsOf(creatorA, "market_created").find((l) => l.suggestionId === id)!;
  assert.ok(made, "a market was created for the suggestion");
  const parsed = parseMarketSpec(await anonymous.getContent(String(made.specHash)));
  assert.ok(parsed.ok && parsed.spec.suggestionId === id);
  // The claim is on disk, not only in memory.
  assert.ok((await loadState(creatorA.stateDir)).acted["creator.claimed"]!.includes(id));
  await waitFor("the suggestion to show its market", async () => (await anonymous.getSuggestion(id)).status === "MARKET_CREATED");
});

test("two creators race one suggestion", { timeout: 300_000 }, async () => {
  const { id } = await anonymous.submitSuggestion({ text: TEXT_S2 });
  suggestionTwo = id;
  // The same identity running twice (a duplicated deployment), each with its own state directory. The
  // second one read the queue before the first claimed: it sees the suggestion as open.
  const duplicate = await startAgent("creatorA-2", "creatorA", accounts.admin, ["creator"]);
  const stale = await duplicate.ctx.client.listSuggestions({ status: "OPEN", limit: 50 });
  assert.ok(stale.items.some((i) => i.id === id));
  duplicate.ctx.client = { ...duplicate.ctx.client, listSuggestions: async () => stale };

  // The first creator is held right after its claim is saved, before it has written the market.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const realGet = creatorA.ctx.client.getSuggestion.bind(creatorA.ctx.client);
  creatorA.ctx.client = {
    ...creatorA.ctx.client,
    getSuggestion: async (suggestionId) => {
      await held;
      return realGet(suggestionId);
    },
  };
  const first = tick(creator, creatorA.ctx);
  try {
    await waitFor("the claim to be saved", async () =>
      (await loadState(creatorA.stateDir)).acted["creator.claimed"]?.includes(id) === true,
    );
    assert.equal((await anonymous.getSuggestion(id)).status, "CLAIMED");
    assert.equal((await createdBy(accounts.admin.address)).length, 3, "no market yet for the suggestion");

    // The duplicate of the same identity gets the 409, once, and creates nothing.
    await tick(creator, duplicate.ctx);
    await tick(creator, duplicate.ctx);
    assert.equal(eventsOf(duplicate, "suggestion_already_claimed").filter((l) => l.suggestionId === id).length, 1);
    assert.equal(eventsOf(duplicate, "suggestion_claimed").length, 0);
    // Another creator identity sees the claimed suggestion as taken: it neither claims nor creates.
    const before = clamper.lines.length;
    await tick(creator, clamper.ctx);
    assert.deepEqual(
      clamper.lines.slice(before).filter((l) => ["suggestion_claimed", "market_created", "cap_exhausted"].includes(l.event)),
      [],
    );
    assert.equal((await anonymous.getSuggestion(id)).status, "CLAIMED");
  } finally {
    release();
  }
  await first;

  assert.equal(eventsOf(creatorA, "suggestion_claimed").filter((l) => l.suggestionId === id).length, 1);
  assert.equal(duplicate.writes.filter((w) => w === "createMarket").length, 0);
  assert.equal(eventsOf(duplicate, "market_created").length, 0);
  // gm, gm2 and the two suggestions: nothing was created twice.
  assert.equal((await createdBy(accounts.admin.address)).length, 4);
  await waitFor("exactly one market for the suggestion", async () => (await marketsWithSuggestion(id)).length === 1);
  await waitFor("the suggestion to show its market", async () => (await anonymous.getSuggestion(id)).status === "MARKET_CREATED");
  assert.equal((await anonymous.getSuggestion(id)).claimCount, 1);
});

test("a create that landed unacknowledged is found again after a restart, even if the model now answers differently", { timeout: 300_000 }, async () => {
  const minter = accounts.minter.address;
  const before = (await createdBy(minter)).length;
  clamper.ctx.model = fixtureModel(world, "crasher");
  loseAnswerOnce(clamper, "createMarket");
  await assert.rejects(() => creator(clamper.ctx), /socket hang up/);
  assert.equal((await createdBy(minter)).length, before + 1, "the market landed");

  // What is on disk: the chosen draft with its bytes and hash, not yet done.
  const saved = await loadState(clamper.stateDir);
  const intent = saved.intents?.["draft:crash"];
  assert.ok(intent, "the intent was saved before the send");
  assert.equal(intent.specHash, keccak256(new TextEncoder().encode(intent.spec)));
  assert.ok(!saved.acted["creator.drafts"]?.includes("crash"));

  // The process restarts and the model now words the question differently: the saved bytes win.
  await restart(clamper);
  clamper.ctx.model = fixtureModel(changedWorld, "crasher");
  const writes = clamper.writes.length;
  await tick(creator, clamper.ctx);
  assert.equal(clamper.writes.slice(writes).filter((w) => w === "createMarket").length, 0);
  assert.deepEqual(eventsOf(clamper, "market_exists").map((l) => l.specHash), [intent.specHash]);
  assert.equal((await createdBy(minter)).length, before + 1, "exactly one market for the draft");
  const done = await loadState(clamper.stateDir);
  assert.ok(done.acted["creator.drafts"]!.includes("crash"));
  assert.equal(done.intents?.["draft:crash"], undefined);
  const titles = await waitFor("the draft's market in the index", async () => {
    const listed = (await anonymous.listMarkets({ limit: 100 })).items.map((i) => (i.spec.ok ? i.spec.spec.title : ""));
    return listed.some((t) => t.startsWith("Crash market")) ? listed : null;
  });
  assert.equal(titles.filter((t) => t.startsWith("Crash market")).length, 1);
  assert.ok(!titles.includes("Crash market, reworded"));
});

test("a maker whose deposit is still unmined sends it again with the same nonce, and exactly one deposit lands", { timeout: 120_000 }, async () => {
  makerA = await startAgent("makerA", "makerA", accounts.maker, ["maker"]);
  const rpc = (method: string, params: unknown[]) => platform.anvil.publicClient.request({ method, params } as never);
  const send = makerA.ctx.walletClient.writeContract.bind(makerA.ctx.walletClient) as (r: { functionName: string }) => Promise<Hex>;
  const nonces: unknown[] = [];
  let lost = false;
  (makerA.ctx.walletClient as { writeContract: unknown }).writeContract = async (request: { functionName: string; nonce?: number }) => {
    if (request.functionName !== "depositMaker") return send(request);
    nonces.push(request.nonce);
    if (lost) return send(request);
    // Mining stops, the deposit is broadcast and the answer never arrives.
    lost = true;
    await rpc("evm_setAutomine", [false]);
    await send(request);
    throw new Error("request timed out");
  };
  try {
    await assert.rejects(() => maker(makerA.ctx), /request timed out/);
    assert.equal(await depositsOf(accounts.maker.address), 0, "the deposit is not mined");
    const saved = await loadState(makerA.stateDir);
    const attempt = JSON.parse(saved.acted["maker.deposit-attempt"]![0]!) as { nonce: number; hash?: string };
    assert.equal(attempt.nonce, nonces[0], "the attempt, with its nonce, was saved before the send");
    assert.deepEqual(saved.acted["maker.deposited"] ?? [], []);

    // The process restarts and ticks again while the first deposit is still in the pool.
    await restart(makerA);
    const second = tick(maker, makerA.ctx);
    await new Promise((r) => setTimeout(r, 1500));
    await rpc("evm_setAutomine", [true]);
    await rpc("evm_mine", []);
    await second;
  } finally {
    await rpc("evm_setAutomine", [true]);
  }
  assert.deepEqual(nonces, [nonces[0], nonces[0]], "the second send reuses the nonce");
  assert.equal(await depositsOf(accounts.maker.address), 1, "exactly one deposit");
  assert.equal(await chainRead<bigint>(markets(), agentAbi.markets as Abi, "makerFree", [accounts.maker.address]), 100_000_000n);
  await tick(maker, makerA.ctx);
  assert.equal(await depositsOf(accounts.maker.address), 1);
  const done = await loadState(makerA.stateDir);
  assert.deepEqual(done.acted["maker.deposited"], ["100000000"]);
  assert.deepEqual(done.acted["maker.deposit-attempt"], []);
});

test("maker quotes only where its model has a view, and trader fills the better of two quotes", { timeout: 600_000 }, async () => {
  makerB = await startAgent("makerB", "makerB", accounts.challenger, ["maker"]);
  // A saved attempt whose nonce was used by another transaction (its onboarding): dropped, then a fresh nonce.
  makerB.ctx.state.data.acted["maker.deposit-attempt"] = [JSON.stringify({ nonce: 0 })];
  trader = await startAgent("trader", "trader", accounts.taker, ["trader"]);
  await openMarket(ids.gm!);
  await openMarket(ids.gm2!);

  const stop = new AbortController();
  const loops = [
    runAgent(makerA.ctx, [maker], { tickMs: 200, signal: stop.signal }),
    runAgent(makerB.ctx, [maker], { tickMs: 200, signal: stop.signal }),
    runAgent(
      trader.ctx,
      [createTrader({ pollMs: 200, waitMs: { quotes: 60_000, receipt: 60_000, settle: 60_000, grace: 4000 } })],
      { tickMs: 500, signal: stop.signal },
    ),
  ];
  try {
    await waitFor("the trader's fill", async () => eventsOf(trader, "filled")[0], 240_000, 500);
    const rfqId = String(eventsOf(trader, "rfq_posted")[0]!.rfqId);
    const quotes = (await trader.ctx.client.listQuotes(rfqId)).items;
    assert.deepEqual(quotes.map((q) => q.quote.priceBps).sort(), ["6300", "7300"]);

    const fills = (await platform.anvil.publicClient.getContractEvents({
      address: markets(),
      abi: agentAbi.markets,
      eventName: "QuoteFilled",
      fromBlock: 0n,
    } as never)) as unknown as { args: { maker: string; taker: string; priceBps: number; quantity: bigint } }[];
    assert.equal(fills.length, 1);
    assert.equal(fills[0]!.args.maker.toLowerCase(), accounts.challenger.address.toLowerCase());
    assert.equal(fills[0]!.args.taker.toLowerCase(), accounts.taker.address.toLowerCase());
    assert.equal(fills[0]!.args.priceBps, 6300);

    // The trader has TAKER by now. An RFQ on the market where no maker has a view gets no quote.
    const unwanted = await trader.ctx.client.createRfq({ marketId: ids.gm2, side: "YES", quantity: "10" });
    for (const agent of [makerA, makerB])
      await waitFor("a skip for the RFQ", async () =>
        agent.lines.some((l) => l.event === "quote_skipped" && l.rfqId === unwanted.rfqId && l.reason === "NO_VIEW"),
      );
    assert.deepEqual((await trader.ctx.client.listQuotes(unwanted.rfqId)).items, []);
    for (const agent of [makerA, makerB])
      assert.deepEqual(eventsOf(agent, "quote_posted").map((l) => l.marketId), [ids.gm]);
    for (const who of [accounts.maker, accounts.challenger]) assert.equal(await depositsOf(who.address), 1);
    assert.equal(eventsOf(makerB, "deposit_attempt_dropped").length, 1);
  } finally {
    stop.abort();
    await Promise.all(loops);
  }
});

test("maker raises its epoch on shutdown", { timeout: 60_000 }, async () => {
  const epoch = () => chainRead<bigint>(markets(), agentAbi.markets as Abi, "makerEpoch", [accounts.maker.address]);
  assert.equal(await epoch(), 0n);
  await makerStop(makerA.ctx);
  assert.equal(await epoch(), 1n);
});

test("forecaster submits one signed forecast per window and the API verifies it", { timeout: 600_000 }, async () => {
  const agent = await startAgent("forecaster", "forecaster", accounts.taker2, ["forecaster"]);
  const submitted: string[] = [];
  const realSubmit = agent.ctx.client.submitForecast;
  agent.ctx.client = {
    ...agent.ctx.client,
    submitForecast: (ref, input, key) => {
      submitted.push(String((input as { scheduledAt: number }).scheduledAt));
      return realSubmit(ref, input, key);
    },
  };
  // The scheduler plans the PRE_CLOSE window 160 s to 80 s before the market closes.
  await waitFor("an open forecast window", async () =>
    (await anonymous.listForecastWindows({ marketId: ids.gm! })).items.some((w) => w.status === "OPEN"), 400_000, 1000);
  await tick(forecaster, agent.ctx);
  await tick(forecaster, agent.ctx);

  const windows = eventsOf(agent, "forecast_submitted");
  assert.ok(windows.length >= 1);
  assert.equal(submitted.length, windows.length, "one submission per window, however many ticks");
  const { anchor } = platform.deployment.shared;
  const known = (await anonymous.listForecastWindows({ marketId: ids.gm!, }, { limit: 100 })).items;
  for (const line of windows) {
    const window = known.find((w) => w.windowId === line.windowId)!;
    const own = (await agent.ctx.client.listForecasts({ marketId: ids.gm! }, { windowId: window.windowId })).items;
    assert.equal(own.length, 1);
    assert.equal(own[0]!.probabilityBps, 6500);
    assert.equal(own[0]!.forecaster.toLowerCase(), accounts.taker2.address.toLowerCase());
    const message = {
      forecaster: accounts.taker2.address,
      markets: markets(),
      marketId: ids.gm!,
      horizon: window.horizon,
      scheduledAt: window.scheduledAt,
      probabilityBps: 6500,
      contentHash: NO_CONTENT_HASH,
    };
    assert.equal(own[0]!.digest, forecastDigest({ anchor, message }));
    assert.equal(
      await platform.anvil.publicClient.verifyTypedData({
        address: accounts.taker2.address,
        ...forecastTypedData({ anchor, message }),
        signature: own[0]!.signature as Hex,
      }),
      true,
    );
  }
  assert.deepEqual((await loadState(agent.stateDir)).acted["forecaster.submitted"]!.sort(), windows.map((l) => String(l.windowId)).sort());
});

test("trader redeems after FINAL and the payout equals getPosition", { timeout: 900_000 }, async () => {
  const { shared, generation, params } = platform.deployment;
  const proposer = accounts.proposer;
  await write(proposer, shared.faucet, agentAbi.faucet as Abi, "claim");
  await write(proposer, shared.busd, agentAbi.usd as Abi, "approve", [generation.registry, BigInt(params.registrationFee) + BigInt(params.minRoleStake)]);
  await write(proposer, generation.registry, agentAbi.registry as Abi, "register");
  await write(proposer, generation.registry, agentAbi.registry as Abi, "joinRole", [ROLE.PROPOSER, BigInt(params.minRoleStake)]);
  await write(proposer, shared.busd, agentAbi.usd as Abi, "approve", [generation.resolution, 10n * UNIT]);

  // The market closes, the proposer says YES, nobody challenges, a keeper finalizes.
  await untilChainTime((await chainMarket(ids.gm!)).closeAt);
  const proposed = await write(proposer, generation.resolution, agentAbi.resolution as Abi, "propose", [
    BigInt(ids.gm!), 0, keccak256("0x1234"), "ipfs://evidence",
  ]);
  let challengeEnd = 0n;
  for (const entry of proposed.logs) {
    try {
      const event = decodeEventLog({ abi: agentAbi.resolution, ...entry });
      if (event.eventName === "Proposed") challengeEnd = event.args.challengeEnd;
    } catch {
      // Not an event of the resolution ABI.
    }
  }
  assert.ok(challengeEnd > 0n);
  await untilChainTime(challengeEnd);
  await write(accounts.keeper, generation.resolution, agentAbi.resolution as Abi, "finalizeUnchallenged", [BigInt(ids.gm!)]);
  await waitFor("the market FINAL in the index", async () => (await anonymous.getMarket({ marketId: ids.gm! })).market.state === "FINAL", 120_000);

  const [yes, no] = await chainRead<[bigint, bigint]>(markets(), agentAbi.markets as Abi, "getPosition", [BigInt(ids.gm!), accounts.taker.address]);
  assert.equal(yes, 10n);
  assert.equal(no, 0n);
  const balance = () => chainRead<bigint>(shared.busd, agentAbi.usd as Abi, "balanceOf", [accounts.taker.address]);
  const balanceBefore = await balance();

  const stop = new AbortController();
  const loop = runAgent(trader.ctx, [createTrader({ pollMs: 200 })], { tickMs: 500, signal: stop.signal });
  try {
    await waitFor("the redemption", async () => eventsOf(trader, "redeemed")[0], 120_000, 500);
  } finally {
    stop.abort();
    await loop;
  }
  const redeemed = eventsOf(trader, "redeemed")[0]!;
  assert.equal(redeemed.marketId, ids.gm);
  assert.equal(redeemed.finalOutcome, "YES");
  // A YES share pays one bUSD; the log, the chain balance and the position all agree.
  assert.equal(redeemed.payoutMicros, String(yes * UNIT));
  assert.equal((await balance()) - balanceBefore, yes * UNIT);
  assert.deepEqual(await chainRead(markets(), agentAbi.markets as Abi, "getPosition", [BigInt(ids.gm!), accounts.taker.address]), [0n, 0n]);
  assert.ok(suggestionTwo.length > 0);
});
