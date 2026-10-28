import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";
import { erc20Abi, keccak256, parseEventLogs, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { agentAbi, BlinkApiError, createBlinkClient } from "../packages/client/src/index.ts";
import { ROLE } from "../packages/client/src/protocol-constants.ts";
import { assertNoRoleKeys } from "../packages/runtime/src/index.ts";
import { rebuildChainProjection } from "../packages/application/src/chain-indexer.ts";
import { postgresProtocolIndexStore } from "../packages/adapters/src/protocol-index-store.ts";
import { protocolAbi } from "./local-alpha.ts";
import { ALPHA_FORECAST_SCHEDULE, startAlphaPlatform } from "./alpha/platform.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "tmp/alpha-autonomous");
const defaultWorld = join(root, "examples/agents/worlds/drill.json");
const mnemonic = "test test test test test test test test test test test junk";
const readLimit = { capacity: 600, refillPerSecond: 100 };
const TICK_SECONDS = 2;
const scenarios = ["normal", "dispute", "creation", "timeout", "suggestion"] as const;
const roleId: Record<string, number> = { creator: ROLE.CREATOR, maker: ROLE.MAKER, trader: ROLE.TAKER, forecaster: ROLE.FORECASTER, proposer: ROLE.PROPOSER, challenger: ROLE.CHALLENGER, juror: ROLE.JUROR };
type World = { questions: Record<string, { spec: { title: string; class: "A" | "B" | "C" }; closeInSeconds: number; sources?: Record<string, string> }>; suggestions: Record<string, string>; agents: Record<string, { roles: string[]; beliefs: Record<string, unknown> }>; notes?: string };
type Actor = { name: string; roles: string[]; account: LocalAccount; child: ChildProcess; tail: string[]; quoteEvents: { rfqId: string; marketId: string }[] };
let activeSignal: AbortSignal | undefined;
const liveAgents = new Set<ChildProcess>();
process.once("exit", () => { for (const child of liveAgents) child.kill("SIGKILL"); });

function argsOf(args: string[]) {
  let backend: "postgres" | "pglite" = "postgres";
  let world = process.env.BLINK_AUTONOMOUS_WORLD ?? defaultWorld;
  let timeout = Number(process.env.BLINK_AUTONOMOUS_SCENARIO_TIMEOUT_SECONDS ?? 1800);
  let timeoutDeadlineSeconds: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--backend") backend = args[++i] as typeof backend;
    else if (args[i] === "--world") world = args[++i]!;
    else if (args[i] === "--scenario-timeout-seconds") timeout = Number(args[++i]);
    else if (args[i] === "--timeout-deadline-seconds") timeoutDeadlineSeconds = Number(args[++i]);
    else throw new Error("INVALID_ARGUMENT:" + args[i]);
  }
  if (!["postgres", "pglite"].includes(backend) || !Number.isInteger(timeout) || timeout < 1 ||
      (timeoutDeadlineSeconds !== undefined && (!Number.isInteger(timeoutDeadlineSeconds) || timeoutDeadlineSeconds < 1)))
    throw new Error("INVALID_DRILL_OPTIONS");
  return { backend, world: resolve(world), timeout, timeoutDeadlineSeconds };
}

async function waitFor<T>(what: string, until: number, read: () => Promise<T | null | undefined | false>): Promise<T> {
  let last: unknown;
  for (;;) {
    if (activeSignal?.aborted) throw new Error(`SCENARIO_ABORTED:${what}`);
    try { const value = await read(); if (value !== null && value !== undefined && value !== false) return value; }
    catch (error) {
      if (error instanceof BlinkApiError && (error.status === 401 || error.status === 403)) throw error;
      last = error;
    }
    if (activeSignal?.aborted) throw new Error(`SCENARIO_ABORTED:${what}`);
    if (Date.now() >= until) throw new Error(`SCENARIO_TIMEOUT:${what}${last ? ":" + String(last) : ""}`);
    await delay(1000);
  }
}

async function startActors(world: World, worldPath: string, apiUrl: string, rpcUrl: string, stateDir: string, actors: Actor[]): Promise<void> {
  const roster = Object.entries(world.agents);
  // Juror stake must precede creation-dispute snapshots; send handles the faucet checkpoint gas race.
  const ordered = roster.map(([name, actor]) => ({ name, actor, slot: roster.findIndex(([other]) => other === name) }))
    .sort((a, b) => Number(a.actor.roles.includes("creator")) - Number(b.actor.roles.includes("creator")) || Number(b.actor.roles.includes("juror")) - Number(a.actor.roles.includes("juror")));
  for (const { name, actor, slot } of ordered) {
    const account = mnemonicToAccount(mnemonic, { addressIndex: slot + 10 });
    const key = toHex((account as unknown as { getHdKey(): { privateKey: Uint8Array } }).getHdKey().privateKey);
    const env = {
      BLINK_AGENT_NAME: name,
      BLINK_AGENT_ROLES: actor.roles.join(","),
      BLINK_API_URL: apiUrl,
      BLINK_RPC_URL: rpcUrl,
      BLINK_AGENT_KEY: key,
      BLINK_WORLD: worldPath,
      BLINK_AGENT_STATE_DIR: join(stateDir, name),
    };
    const child = spawn(process.execPath, ["--import", "tsx", "examples/agents/src/main.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const tail: string[] = [];
    const quoteEvents: Actor["quoteEvents"] = [];
    const log = createWriteStream(join(output, "agents", name + ".log"), { flags: "w" });
    const captureLine = (line: string) => {
      log.write(line + "\n");
      if (line) { tail.push(line); tail.splice(0, Math.max(0, tail.length - 20)); }
      try {
        const event = JSON.parse(line);
        if (event.event === "quote_posted" && typeof event.rfqId === "string" && typeof event.marketId === "string")
          quoteEvents.push({ rfqId: event.rfqId, marketId: event.marketId });
      } catch { /* non-JSON agent output */ }
    };
    liveAgents.add(child);
    if (child.stdout) createInterface({ input: child.stdout }).on("line", captureLine);
    if (child.stderr) createInterface({ input: child.stderr }).on("line", captureLine);
    child.once("close", () => { liveAgents.delete(child); log.end(); });
    actors.push({ name, roles: actor.roles, account, child, tail, quoteEvents });
    const ready = await waitFor(`agent ${name} onboard`, Date.now() + 180_000, async () => {
      if (child.exitCode !== null) return "exited";
      return tail.some((line) => { try { return JSON.parse(line).event === "started"; } catch { return false; } }) ? "started" : null;
    });
    if (ready === "exited") throw new Error(`AGENT_EXIT:${name}:${child.exitCode}:address=${account.address}`);
  }
}

async function main() {
  const config = argsOf(process.argv.slice(2));
  assertNoRoleKeys(process.env);
  const world = JSON.parse(await readFile(config.world, "utf8")) as World;
  const roster = Object.keys(world.agents);
  assert.ok(roster.length >= 13, "drill world must contain the independent reference agents");
  await mkdir(join(output, "agents"), { recursive: true });
  const stateDir = join(output, "state-" + randomUUID()); await mkdir(stateDir, { recursive: true });
  const started = Date.now();
  const report: Record<string, { status: "pass" | "fail"; durationSeconds?: number; error?: string }> = Object.fromEntries(scenarios.map((s) => [s, { status: "fail" as const }]));
  let platform: Awaited<ReturnType<typeof startAlphaPlatform>> | undefined;
  let apiClient: ReturnType<typeof createBlinkClient> | undefined;
  let actors: Actor[] = [];
  let agentHealth: ReturnType<typeof setInterval> | undefined;
  let agentExited: Actor | undefined;
  let failure: unknown;
  let r6: Record<string, any> = {};
  let scenarioDeadlines = {} as Record<typeof scenarios[number], number>;
  const abort = new AbortController();
  activeSignal = abort.signal;
  const interrupt = (signal: string) => { failure ??= new Error("DRILL_INTERRUPTED:" + signal); abort.abort(); };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const ids: Record<string, string> = {};
  const lastStates: Record<string, string> = {};
  try {
    platform = await startAlphaPlatform({ backend: config.backend, forecastSchedule: ALPHA_FORECAST_SCHEDULE, publicReadLimit: readLimit, accountCount: 32 } as never);
    await startActors(world, config.world, platform.apiUrl, platform.rpcUrl, stateDir, actors);
    agentHealth = setInterval(() => {
      const exited = actors.find((actor) => actor.child.exitCode !== null && actor.child.exitCode !== 0);
      if (exited && !abort.signal.aborted) {
        agentExited = exited;
        failure ??= new Error(`AGENT_EXIT:${exited.name}:${exited.child.exitCode}:address=${exited.account.address}`);
        abort.abort();
      }
    }, 500);
    const api = apiClient = createBlinkClient(platform.apiUrl);
    const deployment = (await api.getDeployment()).deployment;
    const deadlines = {} as Record<typeof scenarios[number], number>;
    const deadlineFor = (scenario: typeof scenarios[number]) => deadlines[scenario] ?? Date.now() + config.timeout * 1000;
    const p = deployment.params;
    const schedule = (key: string) => {
      const q = world.questions[key]!;
      const cls = q.spec.class === "A" ? 0 : q.spec.class === "B" ? 1 : 2;
      const ready = p.creationWindow[cls]! + p.firstUseExtraWindow + world.questions[key]!.closeInSeconds;
      return { class: cls, marketCloseAfterStartSeconds: ready, earliestFinalAfterStartSeconds: ready + TICK_SECONDS + p.resultChallengeWindow[cls]! };
    };
    const disputed = schedule("dispute");
    r6 = {
      disputeAppealRoundOpensAfterStartSeconds: disputed.marketCloseAfterStartSeconds + TICK_SECONDS + p.resultChallengeWindow[disputed.class]! + p.commitSeconds + p.revealSeconds + p.appealSeconds,
      normal: schedule("normal"),
      creation: schedule("creation"),
      suggestion: schedule("suggestion"),
      timeout: schedule("timeout"),
      phaseInFinalizedMarkets: p.phaseInFinalizedMarkets,
    };
    r6.timeout.hardDeadlineAfterStartSeconds = r6.timeout.marketCloseAfterStartSeconds + 120 +
      p.resultChallengeWindow[r6.timeout.class]! + p.maxRounds * (p.commitSeconds + p.revealSeconds + p.appealSeconds) + 60;
    r6.expectedFinalizedCountAtAppealRound2 = [r6.normal, r6.suggestion]
      .filter((item) => item.earliestFinalAfterStartSeconds < r6.disputeAppealRoundOpensAfterStartSeconds).length +
      Number(r6.timeout.hardDeadlineAfterStartSeconds < r6.disputeAppealRoundOpensAfterStartSeconds);
    assert.ok(r6.expectedFinalizedCountAtAppealRound2 < p.phaseInFinalizedMarkets);
    const timingSlack = 180;
    const hardCloseBudget = (item: typeof disputed) => item.marketCloseAfterStartSeconds + 120 +
      p.resultChallengeWindow[item.class]! + p.maxRounds * (p.commitSeconds + p.revealSeconds + p.appealSeconds) + 60 + timingSlack;
    const scenarioBudgets = {
      normal: r6.normal.earliestFinalAfterStartSeconds + timingSlack,
      dispute: hardCloseBudget(disputed),
      creation: p.creationWindow[r6.creation.class]! + p.firstUseExtraWindow +
        p.commitSeconds + p.revealSeconds + p.appealSeconds + timingSlack,
      timeout: hardCloseBudget(r6.timeout),
      suggestion: r6.suggestion.earliestFinalAfterStartSeconds + timingSlack,
    };
    scenarioDeadlines = Object.fromEntries(scenarios.map((name) => [name,
      Math.min(name === "timeout" ? (config.timeoutDeadlineSeconds ?? config.timeout) : config.timeout, scenarioBudgets[name]),
    ])) as Record<typeof scenarios[number], number>;
    const event = async (contract: "markets" | "resolution", eventName: string, args: Record<string, unknown> = {}, toBlock?: bigint) => platform!.anvil.publicClient.getContractEvents({ address: deployment.generation[contract] as Address, abi: contract === "markets" ? protocolAbi.markets : protocolAbi.resolution, eventName, args, fromBlock: BigInt(deployment.startBlock), ...(toBlock === undefined ? {} : { toBlock }) } as never) as Promise<any[]>;
    const transfers = async (hash: Hex, from: Address, to: Address) => {
      const receipt = await platform!.anvil.publicClient.getTransactionReceipt({ hash });
      return parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs.filter((log) => log.address.toLowerCase() === deployment.shared.busd.toLowerCase()) })
        .filter((transfer) => transfer.args.from.toLowerCase() === from.toLowerCase() && transfer.args.to.toLowerCase() === to.toLowerCase());
    };
    const market = async (key: string) => {
      const title = world.questions[key]!.spec.title;
      const page = await api.listMarkets({ limit: 100 });
      const item = page.items.find((m: any) => m.spec?.ok && m.spec.spec.title === title);
      if (!item) return null;
      ids[key] = item.market.marketId;
      lastStates[key] = item.market.state;
      return item;
    };
    const waitMarket = (key: string) => waitFor("market " + key, deadlineFor(key as typeof scenarios[number]), () => market(key));
    const state = async (key: string, wanted: string) => waitFor(key + " " + wanted, deadlineFor(key as typeof scenarios[number]), async () => {
      const item = await waitMarket(key); const read = await api.getMarket({ marketId: item.market.marketId });
      return read.market.state === wanted ? read : null;
    });
    const complete = async (name: typeof scenarios[number], work: () => Promise<void>) => {
      const at = Date.now();
      deadlines[name] = at + scenarioDeadlines[name] * 1000;
      try { await work(); report[name] = { status: "pass", durationSeconds: Math.round((Date.now() - at) / 1000) }; }
      catch (error) { report[name] = { status: "fail", durationSeconds: Math.round((Date.now() - at) / 1000), error: String(error) }; failure ??= error; abort.abort(); }
    };
    const suggestionText = Object.keys(world.suggestions)[0]!;
    const suggestion = await api.submitSuggestion({ text: suggestionText }) as any;
    const suggestionId: string = suggestion.id;
    const traders = actors.filter((a) => a.roles.includes("trader"));
    const redeem = async (key: typeof scenarios[number]) => {
      for (const trader of traders) {
        const redeemed = await waitFor(`${key} redemption ${trader.name}`, deadlineFor(key), async () => {
          const rows = await api.getPositions({ address: trader.account.address });
          const redeemed = await event("markets", "PositionRedeemed", { marketId: BigInt(ids[key]!), account: trader.account.address });
          return rows.items.find((p: any) => p.marketId === ids[key] && redeemed.some((e) => String(e.args.payout) === p.redeemedPayoutMicros)) ?? null;
        });
        const payout = BigInt(redeemed.redeemedPayoutMicros);
        const chainPosition = await platform!.anvil.publicClient.readContract({ address: deployment.generation.markets as Address, abi: agentAbi.markets, functionName: "getPosition", args: [BigInt(ids[key]!), trader.account.address] }) as readonly [bigint, bigint];
        assert.deepEqual(chainPosition, [0n, 0n], `${trader.name} position remains after redeem`);
        if (key === "timeout") {
          const receipt = (await event("markets", "PositionRedeemed", { marketId: BigInt(ids[key]!), account: trader.account.address }))[0]!;
          assert.equal(payout, (BigInt(receipt.args.yes) + BigInt(receipt.args.no)) * 500_000n);
        }
      }
    };
    const running = [
      complete("normal", async () => {
        const pending = await waitMarket("normal"); assert.equal(pending.market.creationChallenged, false);
        const opened = await state("normal", "OPEN"); const id = opened.market.marketId;
        await waitFor("normal quotes and fill", deadlineFor("normal"), async () => {
          const byRfq = new Map<string, Set<string>>();
          for (const maker of actors.filter((actor) => actor.roles.includes("maker"))) for (const quote of maker.quoteEvents)
            if (quote.marketId === id) { const names = byRfq.get(quote.rfqId) ?? new Set<string>(); names.add(maker.name); byRfq.set(quote.rfqId, names); }
          const publicQuotes = [...byRfq.values()].some((makers) => makers.size >= 2);
          const fills = await event("markets", "QuoteFilled", { marketId: BigInt(id) });
          return publicQuotes && fills.length ? true : null;
        });
        for (const maker of actors.filter((actor) => actor.roles.includes("maker")))
          assert.ok((await api.getMakerStats(maker.account.address)).quotesRelayed > 0, `${maker.name} relay stats omit its accepted quote`);
        await waitFor("normal forecast anchored root", deadlineFor("normal"), async () => {
          const windows = await api.listForecastWindows({ marketId: id });
          for (const w of windows.items) if (w.root && w.status === "CLOSED") {
            const forecasts = await api.listForecasts({ marketId: id }, { windowId: w.windowId });
            if (forecasts.items.length === 0) continue;
            const at = await platform!.anvil.publicClient.readContract({ address: deployment.shared.anchor as Address, abi: agentAbi.anchor, functionName: "anchoredAt", args: [w.root as Hex] });
            if (BigInt(at) > 0n) return w;
          }
          return null;
        });
        await state("normal", "FINAL");
        const [finalized] = await event("markets", "MarketFinalized", { marketId: BigInt(id) });
        assert.ok(finalized, "normal finalization event missing");
        assert.equal((await event("markets", "CreationChallenged", { marketId: BigInt(id) }, finalized.blockNumber)).length, 0);
        assert.equal((await event("resolution", "DisputeOpened", { marketId: BigInt(id) }, finalized.blockNumber)).length, 0);
        const final = await api.getMarket({ marketId: id }); const spec = world.questions.normal!;
        const normalProposals = await event("resolution", "Proposed", { id: BigInt(id) });
        assert.equal(normalProposals.length, 1);
        assert.equal(normalProposals[0]!.args.proposer.toLowerCase(), actors.find((actor) => actor.name === "proposer-honest")!.account.address.toLowerCase());
        const source = new Uint8Array(await readFile(join(dirname(config.world), spec.sources!["https://example.com/q3-results"]!)));
        assert.equal(final.proposal!.evidenceHash.toLowerCase(), keccak256(source).toLowerCase()); assert.equal(final.proposal!.outcome, "NO");
        const distributed = await waitFor("normal fees distributed", deadlineFor("normal"), async () => {
          const rows = await event("markets", "FeesDistributed", { marketId: BigInt(id) });
          const fees = await api.getFees({ marketId: id });
          return rows.length === 1 && fees.fees?.poolMicros === String(rows[0]!.args.amount) ? { row: rows[0], fees } : null;
        });
        assert.equal(distributed.fees.fees!.poolMicros, String(distributed.row.args.amount));
        await redeem("normal");
      }),
      complete("dispute", async () => {
        await state("dispute", "OPEN"); const item = await waitMarket("dispute"); const id = item.market.marketId;
        const opened = await waitFor("dispute opened", deadlineFor("dispute"), async () => (await event("resolution", "DisputeOpened", { marketId: BigInt(id) }))[0] ?? null);
        const did = BigInt(opened.args.disputeId);
        const challenger = actors.find((a) => a.name === "challenger")!;
        await waitFor("appeal and second round", deadlineFor("dispute"), async () => (await event("resolution", "Appealed", { disputeId: did })).length === 1 && (await event("resolution", "RoundSettled", { disputeId: did })).length === 2 ? true : null);
        const finalEvent = await waitFor("dispute settled", deadlineFor("dispute"), async () => (await event("resolution", "DisputeFinalized", { disputeId: did }))[0] ?? null);
        assert.equal(Number(finalEvent.args.choice), 1); assert.equal((await state("dispute", "FINAL")).market.finalOutcome, "NO");
        const bondTransfers = await transfers(finalEvent.transactionHash, deployment.generation.resolution as Address, challenger.account.address);
        assert.ok(bondTransfers.reduce((sum, item) => sum + item.args.value, 0n) > BigInt(opened.args.bond), "challenger did not receive the slashed proposer and appeal bond");
        assert.equal(await platform!.anvil.publicClient.readContract({ address: deployment.generation.registry as Address, abi: agentAbi.registry, functionName: "hasRole", args: [actors.find((a) => a.name === "proposer-liar")!.account.address, ROLE.PROPOSER] }), false);
        const rounds = await event("resolution", "RoundSettled", { disputeId: did });
        const dispute = await api.getDispute({ disputeId: String(did) });
        assert.equal(rounds.length, 2); assert.equal(dispute.rounds.length, 2);
        const liarProposals = await event("resolution", "Proposed", { proposer: actors.find((actor) => actor.name === "proposer-liar")!.account.address });
        assert.ok(liarProposals.length > 0, "liar did not propose on the dispute market");
        assert.ok(liarProposals.every((proposal) => proposal.args.id === BigInt(id)), "liar proposed outside its dispute scenario");
        assert.ok(dispute.rounds.every((round) => round.creditThreshold === 0));
        await redeem("dispute");
      }),
      complete("creation", async () => {
        const item = await waitMarket("creation"); const id = BigInt(item.market.marketId);
        const opened = await waitFor("creation dispute", deadlineFor("creation"), async () => (await event("resolution", "DisputeOpened", { marketId: id }))[0] ?? null);
        const resolved = await waitFor("creation bond resolved", deadlineFor("creation"), async () => (await event("markets", "CreationResolved", { marketId: id }))[0] ?? null);
        assert.equal(resolved.args.challenger.toLowerCase(), actors.find((a) => a.name === "challenger")!.account.address.toLowerCase());
        assert.equal(resolved.args.upheld, true); assert.ok(BigInt(resolved.args.bond) > 0n);
        const bondTransfers = await transfers(resolved.transactionHash, deployment.generation.markets as Address, actors.find((a) => a.name === "challenger")!.account.address);
        assert.ok(bondTransfers.some((item) => item.args.value === BigInt(resolved.args.bond) - BigInt(resolved.args.jurorCut)), "creation bond was not transferred to the challenger");
        assert.equal(await platform!.anvil.publicClient.readContract({ address: deployment.generation.registry as Address, abi: agentAbi.registry, functionName: "hasRole", args: [actors.find((a) => a.name === "creator-challenge")!.account.address, ROLE.CREATOR] }), false);
        const cancelled = await state("creation", "CANCELLED"); assert.equal(cancelled.market.creationChallenged, false);
        assert.equal((await event("markets", "CreationChallenged", { marketId: id })).length, 1);
        assert.equal((await event("markets", "MarketOpened", { marketId: id })).length, 0);
        const rounds = await event("resolution", "RoundSettled", { disputeId: BigInt(opened.args.disputeId) });
        assert.ok(rounds.length >= 1);
        assert.ok(rounds.every((round) => Number(round.args.choice) === 1), "creation jurors did not uphold the ambiguous question");
        const dispute = await api.getDispute({ disputeId: String(opened.args.disputeId) });
        assert.ok(dispute.rounds.length > 0, "creation API rounds missing");
        assert.equal(dispute.rounds.length, rounds.length, "creation API and settled chain round counts differ");
        assert.ok(dispute.rounds.every((round) => round.creditThreshold === 0));
      }),
      complete("timeout", async () => {
        const item = await waitMarket("timeout"); const id = item.market.marketId; await state("timeout", "OPEN");
        const final = await waitFor("timeout invalid", deadlineFor("timeout"), async () => { const m = await api.getMarket({ marketId: id }); return m.market.state === "FINAL" && m.market.finalOutcome === "INVALID" ? m : null; });
        lastStates.timeout = final.market.state;
        const [finalized] = await event("markets", "MarketFinalized", { marketId: BigInt(id) });
        assert.ok(finalized, "timeout finalization event missing");
        const block = await platform!.anvil.publicClient.getBlock({ blockHash: finalized.blockHash });
        const chainMarket = await platform!.anvil.publicClient.readContract({ address: deployment.generation.markets as Address, abi: agentAbi.markets, functionName: "getMarket", args: [BigInt(id)] });
        assert.ok(block.timestamp >= chainMarket.hardDeadline, "timeout finalized before its hard deadline");
        assert.equal(final.market.finalOutcome, "INVALID"); await redeem("timeout");
      }),
      complete("suggestion", async () => {
        const linked = await waitFor("suggestion MARKET_CREATED", deadlineFor("suggestion"), async () => { const s = await api.getSuggestion(suggestionId); return s.status === "MARKET_CREATED" ? s : null; });
        const item = await waitMarket("suggestion"); const spec = await api.getMarketSpec({ marketId: item.market.marketId }, item.market.specHash);
        assert.equal(spec.suggestionId, suggestionId); assert.equal(linked.status, "MARKET_CREATED");
        await state("suggestion", "FINAL"); await redeem("suggestion");
      }),
    ];
    await Promise.all(running);

    if (agentExited) {
      const nextClaimAt = await platform.anvil.publicClient.readContract({ address: deployment.shared.faucet as Address, abi: agentAbi.faucet, functionName: "nextClaimAt", args: [agentExited.account.address] });
      const balance = await platform.anvil.publicClient.readContract({ address: deployment.shared.busd as Address, abi: agentAbi.usd, functionName: "balanceOf", args: [agentExited.account.address] });
      failure = new Error(`AGENT_EXIT:${agentExited.name}:${agentExited.child.exitCode}:address=${agentExited.account.address}:faucetNext=${nextClaimAt}:busdBalance=${balance}`);
    }

    for (const actor of actors) for (const role of actor.roles) if (roleId[role] !== undefined) {
      const account = await api.getAccount({ address: actor.account.address });
      const chainCredit: bigint = await platform.anvil.publicClient.readContract({ address: deployment.generation.registry as Address, abi: agentAbi.registry, functionName: "creditOf", args: [actor.account.address, roleId[role]] });
      const apiRole = (role === "trader" ? "TAKER" : role.toUpperCase()) as keyof typeof account.roles;
      assert.equal(BigInt(account.roles[apiRole].credit), BigInt(chainCredit), `${actor.name}/${role} credit`);
    }
    const platformProcesses = (platform as any).processes as Record<string, { env: NodeJS.ProcessEnv }> | undefined;
    if (platformProcesses) for (const service of Object.values(platformProcesses)) {
      assertNoRoleKeys(service.env);
      for (const actor of actors) {
        const key = toHex((actor.account as unknown as { getHdKey(): { privateKey: Uint8Array } }).getHdKey().privateKey);
        assert.ok(!Object.values(service.env).includes(key), `role key leaked into platform environment (${actor.name})`);
      }
    }
    const verification = await rebuildChainProjection(postgresProtocolIndexStore((platform as any).indexerPool), platform.deploymentId, { verify: true, workerId: "alpha-autonomous-verify", reader: (platform as any).logReader });
    assert.deepEqual(verification.differences, []); assert.ok(verification.eventCount > 0);
    if (failure) throw failure;
  } catch (error) {
    failure ??= error;
    if (apiClient) try {
      const page = await apiClient.listMarkets({ limit: 100 });
      for (const [key, question] of Object.entries(world.questions)) {
        const item = page.items.find((market: any) => market.spec?.ok && market.spec.spec.title === question.spec.title);
        if (item) { ids[key] = item.market.marketId; lastStates[key] = item.market.state; }
      }
    } catch { /* preserve the latest indexed states already collected */ }
  }
  finally {
    clearInterval(agentHealth);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    activeSignal = undefined;
    for (const actor of actors) actor.child.kill("SIGTERM");
    await Promise.all(actors.map((actor) => new Promise<void>((done) => {
      if (actor.child.exitCode !== null || actor.child.signalCode !== null) return done();
      const kill = setTimeout(() => actor.child.kill("SIGKILL"), 10_000); actor.child.once("exit", () => (clearTimeout(kill), done()));
    })));
    try { await platform?.stop(); }
    catch (error) { failure ??= error; }
  }
  const result = { backend: config.backend, startedAt: new Date(started).toISOString(), durationSeconds: Math.round((Date.now() - started) / 1000), roster, expectedMinimumWalletChallenges: roster.length, apiPublicReadLimit: readLimit, slashedRoleDutyNote: world.notes, scenarioDeadlinesSeconds: scenarioDeadlines, r6, scenarios: report, lastIndexedStates: lastStates, result: failure ? "fail" : "pass", error: failure instanceof Error ? failure.message : undefined };
  await writeFile(join(output, "report.json"), JSON.stringify(result, null, 2) + "\n");
  if (failure) {
    const logs = actors.map((actor) => `${actor.name}:\n${actor.tail.join("\n")}`).join("\n");
    console.error(String(failure) + "\nLast indexed states: " + JSON.stringify({ markets: Object.fromEntries(Object.keys(ids).map((key) => [key, lastStates[key]])), scenarios: report }) + "\nLast agent log lines:\n" + logs); process.exitCode = 1;
  } else console.log(`autonomous drill passed in ${result.durationSeconds}s`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : "AUTONOMOUS_FAILED"); process.exitCode = 1; });
