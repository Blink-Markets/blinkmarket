import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bytesToHex, keccak256, maxUint256, parseEventLogs, toBytes, type Abi, type Hex, type LocalAccount } from "viem";
import {
  BlinkApiError,
  GM_LT_V1,
  QUESTION_CLASS,
  ROLE,
  agentAbi,
  createBlinkClient,
  quoteTypedData,
  templateIdFor,
} from "../../packages/client/src/index.ts";
import { createContext, type AgentContext, type AgentEnv, type RoleName } from "../../examples/agents/src/lib/env.ts";
import { createLogger } from "../../examples/agents/src/lib/log.ts";
import type { RoleTick } from "../../examples/agents/src/lib/loop.ts";
import { fixtureModel, type Model } from "../../examples/agents/src/lib/model.ts";
import { onboard } from "../../examples/agents/src/lib/session.ts";
import { parseWorld, type World } from "../../examples/agents/src/lib/world.ts";
import { challenger } from "../../examples/agents/src/roles/challenger.ts";
import { loadState } from "../../examples/agents/src/lib/state.ts";
import { juror } from "../../examples/agents/src/roles/juror.ts";
import { keeper } from "../../examples/agents/src/roles/keeper.ts";
import { proposer } from "../../examples/agents/src/roles/proposer.ts";
import { startAlphaPlatform, type AlphaPlatform } from "../../scripts/alpha/platform.ts";

// The resolution roles over the in-process platform. Time is chain time: a scenario moves Anvil's
// clock to the next deadline (the platform's own clocks only gate the index's freshness), so a full
// arbitration takes seconds instead of the 330 s of the alpha parameters. The roles never see the
// difference: they read chain time from the latest block.
//
// Wallet challenges spent (the API allows 30 per IP per hour): 9 = one `issue` per onboarded agent
// (3 jurors, creator, proposer, challenger, maker = 7) plus the restarted juror's `issue` and `revoke`.

const SOURCE = "Q3 results. GAAP gross margin was 61.0 percent for the quarter.";
const TITLES = {
  gm: "Gross margin below 65 percent",
  disputed: "Disputed result",
  ambiguous: "Ambiguous question",
  silent: "Nobody proposes",
  missing: "Missing evidence",
  restart: "Juror restart",
  conflict: "Juror with a position",
  race: "Two keepers",
  durable: "Juror persistence",
  blocked: "Refused claim",
  blocked2: "Vote during a refused claim",
  rejected: "Rejected creation challenge",
} as const;
type Key = keyof typeof TITLES;

const questionSpec = (key: Key) => ({
  schema: "blink.market-spec/0.2",
  title: TITLES[key],
  question: TITLES[key] + "?",
  class: key === "gm" ? "A" : "B",
  resolution: { yes: "Yes.", no: "No." },
  sources: [key === "gm" ? "https://example.com/results" : "https://example.com/" + key],
  ...(key === "gm"
    ? {
        computation: {
          templateId: GM_LT_V1.templateId,
          parserHash: GM_LT_V1.parserHash,
          extraction: '{"thresholdBps":6500}',
        },
      }
    : {}),
});
const OBJECTION = { ground: "AMBIGUOUS", evidence: "which source counts?" } as const;
const worldJson = () => ({
  questions: Object.fromEntries(
    (Object.keys(TITLES) as Key[]).map((key) => [
      key,
      {
        spec: questionSpec(key),
        closeInSeconds: 400,
        maxPairs: 50,
        ...(key === "gm" ? { sources: { "https://example.com/results": "results.txt" } } : {}),
      },
    ]),
  ),
  suggestions: {},
  agents: {
    proposer: {
      roles: ["proposer"],
      beliefs: {
        gm: {},
        disputed: { outcome: "YES", appeal: true },
        restart: { outcome: "YES" },
        conflict: { outcome: "YES" },
        race: { outcome: "YES" },
        durable: { outcome: "YES" },
        rejected: { outcome: "YES" },
        blocked: { outcome: "YES" },
        blocked2: { outcome: "YES" },
      },
    },
    challenger: {
      roles: ["challenger"],
      beliefs: {
        // The challenger recomputes the class A outcome from source bytes, not a stated outcome.
        gm: {},
        disputed: { outcome: "NO" },
        restart: { outcome: "NO" },
        conflict: { outcome: "NO" },
        durable: { outcome: "NO" },
        blocked: { outcome: "NO" },
        blocked2: { outcome: "NO" },
        // Objects to the spec first and, once that fails, disputes the result.
        rejected: { objection: OBJECTION, outcome: "NO" },
        ambiguous: { objection: OBJECTION },
      },
    },
    ...Object.fromEntries(
      ["juror-a", "juror-b", "juror-c"].map((name) => [
        name,
        {
          roles: ["juror"],
          beliefs: {
            disputed: { outcome: "NO" },
            restart: { outcome: "NO" },
            conflict: { outcome: "NO" },
            durable: { outcome: "NO" },
            rejected: { outcome: "NO" },
            blocked: { outcome: "NO" },
            blocked2: { outcome: "NO" },
            // The model finds the proposal right; the missing bytes still make it unsupported.
            missing: { outcome: "YES" },
            ambiguous: { objection: OBJECTION },
          },
        },
      ]),
    ),
  },
});

type Line = { event: string; [field: string]: unknown };
type Agent = { name: string; ctx: AgentContext; lines: Line[]; env: AgentEnv; account: LocalAccount };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isBackoff = (error: unknown): error is BlinkApiError =>
  error instanceof BlinkApiError && (error.status === 429 || (error.status === 503 && error.body.code === "INDEX_STALE"));

let platform: AlphaPlatform;
let world: World;
let directory: string;
let anonymous: ReturnType<typeof createBlinkClient>;
const agents = {} as Record<
  "creator" | "maker" | "proposer" | "challenger" | "jurorA" | "jurorB" | "jurorC" | "keeper1" | "keeper2",
  Agent
>;

const chain = () => platform.anvil.publicClient;
const markets = () => platform.deployment.generation.markets as Hex;
const resolution = () => platform.deployment.generation.resolution as Hex;
const chainNow = async () => (await chain().getBlock()).timestamp;

async function startAgent(
  name: string,
  roles: RoleName[],
  account: LocalAccount,
  options: { stateDir?: string; join?: boolean; model?: Model } = {},
): Promise<Agent> {
  const key = bytesToHex((account as unknown as { getHdKey(): { privateKey: Uint8Array } }).getHdKey().privateKey);
  const stateDir = options.stateDir ?? join(directory, name);
  await mkdir(stateDir, { recursive: true });
  const env: AgentEnv = {
    name,
    roles,
    apiUrl: platform.apiUrl,
    rpcUrl: platform.rpcUrl,
    key,
    worldPath: "",
    stateDir,
  };
  const lines: Line[] = [];
  const log = createLogger(name, [key], (line) => lines.push(JSON.parse(line) as Line));
  const ctx = await createContext(env, { model: options.model ?? fixtureModel(world, name), log, pollingIntervalMs: 100 });
  if (options.join !== false) await onboard(ctx);
  return { name, ctx, lines, env, account };
}

/** One tick, repeated after the wait the API asks for when it is rate limited or its index lags. */
async function run(agent: Agent, tick: RoleTick) {
  for (let attempt = 0; ; attempt++)
    try {
      return await tick(agent.ctx);
    } catch (error) {
      if (!isBackoff(error) || attempt >= 60) throw error;
      await sleep((error.retryAfterSeconds ?? 1) * 1000);
    }
}

/** Returns once the API's index has read every block mined so far. */
async function indexed() {
  const target = await chain().getBlockNumber();
  for (let i = 0; i < 240; i++) {
    try {
      const { index } = await anonymous.getDeployment();
      if (!index.stale && BigInt(index.indexedBlock) >= target) return;
    } catch (error) {
      if (!isBackoff(error)) throw error;
    }
    await sleep(500);
  }
  throw new Error("INDEX_NOT_CAUGHT_UP");
}

/** Moves chain time to `seconds` with one mined block (a later chain time stays as it is). */
async function warpTo(seconds: bigint) {
  for (let i = 0; i < 5; i++) {
    if ((await chainNow()) >= seconds) return;
    try {
      await platform.anvil.setNextTimestamp(seconds);
      await platform.anvil.mine(1);
    } catch {
      await sleep(200);
    }
  }
  assert.ok((await chainNow()) >= seconds, "chain time could not be moved");
}

async function write(account: LocalAccount, address: Hex, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  const hash = await platform.anvil
    .wallet(account)
    .writeContract({ address, abi, functionName, args } as never);
  const receipt = await chain().waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", functionName);
  return receipt;
}

const eventsOf = async (address: Hex, abi: Abi, eventName: string, args?: Record<string, unknown>) =>
  (await chain().getContractEvents({
    address,
    abi,
    eventName,
    ...(args ? { args } : {}),
    fromBlock: BigInt(platform.deployment.startBlock),
    toBlock: "latest",
  } as never)) as unknown as { args: Record<string, any> }[];
const resolutionEvents = (eventName: string, args?: Record<string, unknown>) =>
  eventsOf(resolution(), agentAbi.resolution as Abi, eventName, args);

async function chainMarket(marketId: bigint) {
  return chain().readContract({ address: markets(), abi: agentAbi.markets, functionName: "getMarket", args: [marketId] });
}
async function chainDispute(disputeId: bigint) {
  const [dispute, round] = await chain().readContract({
    address: resolution(),
    abi: agentAbi.resolution,
    functionName: "getDispute",
    args: [disputeId],
  });
  return { dispute, round };
}
const busd = (address: Hex) =>
  chain().readContract({
    address: platform.deployment.shared.busd as Hex,
    abi: agentAbi.usd,
    functionName: "balanceOf",
    args: [address],
  });
const STATE = { PENDING: 0, OPEN: 1, PROPOSED: 2, DISPUTED: 3, FINAL: 4, CANCELLED: 5 } as const;
const OUTCOME_CODE = { YES: 0, NO: 1, INVALID: 2 } as const;

type Created = { marketId: bigint; openAt: bigint; closeAt: bigint; proposalDeadline: bigint; hardDeadline: bigint };

/** What a creator agent does, by hand: spec bytes to the content store, the template, the market. */
async function createMarket(key: Key): Promise<Created> {
  const bytes = new TextEncoder().encode(JSON.stringify(world.questions[key]!.spec));
  const { hash: specHash } = await agents.creator.ctx.client.uploadContent(bytes, "application/json");
  const template =
    key === "gm"
      ? GM_LT_V1
      : {
          cls: QUESTION_CLASS.B_VERIFIABLE,
          parserHash: ("0x" + "00".repeat(32)) as Hex,
          uri: "blink://templates/b-test",
          templateId: templateIdFor(QUESTION_CLASS.B_VERIFIABLE, ("0x" + "00".repeat(32)) as Hex, "blink://templates/b-test"),
        };
  const { admin } = platform.accounts;
  await write(admin, markets(), agentAbi.markets, "registerTemplate", [template.cls, template.parserHash, template.uri]);
  const closeAt = (await chainNow()) + 400n;
  const receipt = await write(admin, markets(), agentAbi.markets, "createMarket", [
    {
      templateId: template.templateId,
      specHash,
      specURI: `${platform.apiUrl}/v1/content/${specHash}`,
      replay: false,
      closeAt,
      proposalDeadline: closeAt + 200n,
      hardDeadline: closeAt + 1200n,
      maxPairs: 50n,
    },
  ]);
  const [created] = parseEventLogs({ abi: agentAbi.markets, logs: receipt.logs, eventName: "MarketCreated" });
  const marketId = created!.args.marketId;
  const m = await chainMarket(marketId);
  return {
    marketId,
    openAt: BigInt(m.openAt),
    closeAt,
    proposalDeadline: BigInt(m.proposalDeadline),
    hardDeadline: BigInt(m.hardDeadline),
  };
}

/** The keeper opens the market once its creation window is over. */
async function openMarket(m: Created) {
  await warpTo(m.openAt);
  await indexed();
  await run(agents.keeper1, keeper);
  assert.equal((await chainMarket(m.marketId)).state, STATE.OPEN);
}

/** The proposer agent proposes after close; waits for the index to show it. */
async function propose(m: Created) {
  await warpTo(m.closeAt);
  await indexed();
  await run(agents.proposer, proposer);
  assert.equal((await chainMarket(m.marketId)).state, STATE.PROPOSED);
  await indexed();
}

/**
 * Losing a dispute slashes the role stake of the loser, which can take it below the minimum and
 * with it the role. The reference agents do not top themselves up, so a scenario that follows one
 * restores the role the way an operator would.
 */
async function restoreRole(account: LocalAccount, role: number) {
  const registry = platform.deployment.generation.registry as Hex;
  const args = [account.address, role] as const;
  if (await chain().readContract({ address: registry, abi: agentAbi.registry, functionName: "hasRole", args })) return;
  const stake = await chain().readContract({ address: registry, abi: agentAbi.registry, functionName: "roleStake", args });
  const missing = BigInt(platform.deployment.params.minRoleStake) - stake;
  await write(account, platform.deployment.shared.busd as Hex, agentAbi.usd as Abi, "approve", [registry, missing]);
  await write(account, registry, agentAbi.registry, "addRoleStake", [role, missing]);
  assert.equal(await chain().readContract({ address: registry, abi: agentAbi.registry, functionName: "hasRole", args }), true);
}

async function disputeOf(marketId: bigint) {
  const [opened] = await resolutionEvents("DisputeOpened", { marketId });
  assert.ok(opened, "a dispute was opened");
  return opened.args.disputeId as bigint;
}

const votesBy = (agent: Agent, eventName: "VoteCommitted" | "VoteRevealed", disputeId: bigint) =>
  resolutionEvents(eventName, { disputeId, juror: agent.account.address });

/** Commit, reveal and settle one round of a dispute with the given jurors; returns the round that was played. */
async function playRound(disputeId: bigint, jurors: Agent[]) {
  await indexed();
  await Promise.all(jurors.map((j) => run(j, juror)));
  const { round } = await chainDispute(disputeId);
  await warpTo(round.commitEnd);
  await indexed();
  await Promise.all(jurors.map((j) => run(j, juror)));
  await warpTo(round.revealEnd);
  await indexed();
  await run(agents.keeper1, keeper);
  return round;
}

/** The keeper finalizes the dispute after the appeal window. */
async function finalizeDispute(disputeId: bigint) {
  const { round } = await chainDispute(disputeId);
  assert.equal(round.settled, true);
  await warpTo(round.appealEnd);
  await indexed();
  await run(agents.keeper1, keeper);
  assert.equal((await chainDispute(disputeId)).dispute.settled, true);
}

/** The same agent's model after a change of mind: it now answers YES, the opposite of what the world file says. */
const changedMind = (name: string): Model => ({
  ...fixtureModel(world, name),
  outcome: async () => ({ outcome: "YES", evidence: new Uint8Array() }),
});

/**
 * Makes `target[name]` fail `times` times, when `match` accepts the arguments, and pass through
 * after that; returns the undo. Stands in for a failing disk or a dead RPC at one call.
 */
function failing(target: any, name: string, message: string, times = 1, match: (args: any[]) => boolean = () => true) {
  const real = target[name];
  let left = times;
  target[name] = (...args: any[]) =>
    left > 0 && match(args) ? (left--, Promise.reject(new Error(message))) : real.apply(target, args);
  return () => {
    target[name] = real;
  };
}

const lines = (agent: Agent, event: string) => agent.lines.filter((l) => l.event === event);

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "blink-resolution-roles-"));
  await writeFile(join(directory, "results.txt"), SOURCE);
  world = parseWorld(worldJson(), directory);
  // The default public read limit (60 calls, then 1 a second, per client IP) is shared here by every
  // agent and the test on one loopback address, and a commit or reveal window is 30 s: the bucket
  // is made large so that the timing of a scenario does not depend on it.
  platform = await startAlphaPlatform({ backend: "pglite", publicReadLimit: { capacity: 10_000, refillPerSecond: 10_000 } });
  anonymous = createBlinkClient(platform.apiUrl);
  const a = platform.accounts;
  // Jurors stake first: a market's maximum payout is bounded by the juror stake at its creation.
  agents.jurorA = await startAgent("juror-a", ["juror"], a.arbiter);
  agents.jurorB = await startAgent("juror-b", ["juror"], a.minter);
  agents.jurorC = await startAgent("juror-c", ["juror"], a.taker);
  agents.creator = await startAgent("creator", ["creator"], a.admin);
  agents.proposer = await startAgent("proposer", ["proposer"], a.proposer);
  agents.challenger = await startAgent("challenger", ["challenger"], a.challenger);
  agents.maker = await startAgent("maker", ["maker"], a.maker);
  // Keepers hold no role and need no API key: every read they make is public.
  agents.keeper1 = await startAgent("keeper-1", ["keeper"], a.keeper, { join: false });
  agents.keeper2 = await startAgent("keeper-2", ["keeper"], a.taker2, { join: false });
  // The creator's bond comes out of its wallet; the test creates markets for it, so it approves once.
  await write(a.admin, platform.deployment.shared.busd as Hex, agentAbi.usd as Abi, "approve", [markets(), maxUint256]);
});

after(async () => {
  await platform?.stop();
  await rm(directory, { recursive: true, force: true });
});

test(
  "honest proposer proposes the computed class A outcome with archived evidence and keeper finalizes it",
  { timeout: 600_000 },
  async () => {
    const m = await createMarket("gm");
    await openMarket(m);
    assert.equal(lines(agents.keeper1, "open").length, 1);
    await propose(m);

    const [proposed] = await resolutionEvents("Proposed", { id: m.marketId });
    const evidenceHash = keccak256(toBytes(SOURCE));
    assert.equal(proposed!.args.outcome, OUTCOME_CODE.YES, "61.0% is below the 65% threshold");
    assert.equal(proposed!.args.evidenceHash, evidenceHash);
    assert.equal(proposed!.args.evidenceURI, `/v1/content/${evidenceHash}`);
    assert.equal(new TextDecoder().decode(await anonymous.getContent(evidenceHash)), SOURCE);
    assert.equal(proposed!.args.proposer.toLowerCase(), agents.proposer.account.address.toLowerCase());

    // The challenger recomputes the same outcome from the same bytes and leaves the proposal alone.
    await run(agents.challenger, challenger);
    assert.equal((await resolutionEvents("DisputeOpened", { marketId: m.marketId })).length, 0);
    assert.equal(lines(agents.challenger, "challenged").length, 0);

    await warpTo(proposed!.args.challengeEnd);
    await indexed();
    await run(agents.keeper1, keeper);
    const finalized = await chainMarket(m.marketId);
    assert.equal(finalized.state, STATE.FINAL);
    assert.equal(finalized.finalOutcome, OUTCOME_CODE.YES);
    assert.equal(lines(agents.keeper1, "finalize_unchallenged").length, 1);

    // A FINAL market's fees are distributed by the keeper on a later tick.
    await indexed();
    await run(agents.keeper1, keeper);
    assert.equal((await chainMarket(m.marketId)).feesDistributed, true);
    assert.equal(lines(agents.keeper1, "distribute_fees").length, 1);
    for (const agent of [agents.proposer, agents.challenger, agents.keeper1])
      assert.equal(lines(agent, "tick_error").length, 0);
  },
);

test(
  "challenger challenges a wrong proposal, jurors vote the truth, the proposer appeals once and loses again, and the proposer bond goes to the challenger",
  { timeout: 900_000 },
  async () => {
    const m = await createMarket("disputed");
    await openMarket(m);
    const agent = agents.proposer;
    const wallet = agent.ctx.walletClient as any;
    const publicClient = agent.ctx.publicClient as any;
    const originalWrite = wallet.writeContract;
    const originalWait = publicClient.waitForTransactionReceipt;
    let lostHash: Hex | undefined;
    let lose = "propose";
    wallet.writeContract = async (request: any) => {
      const hash = await originalWrite(request);
      if (request.functionName === lose) lostHash = hash;
      return hash;
    };
    publicClient.waitForTransactionReceipt = async (request: any) => {
      const receipt = await originalWait(request);
      if (request.hash === lostHash) { lostHash = undefined; throw new Error("LOST_RECEIPT"); }
      return receipt;
    };
    await warpTo(m.closeAt);
    await indexed();
    await assert.rejects(run(agent, proposer), /LOST_RECEIPT/);
    assert.equal((await chainMarket(m.marketId)).state, STATE.PROPOSED);
    await indexed();
    const [proposed] = await resolutionEvents("Proposed", { id: m.marketId });
    assert.equal(proposed!.args.outcome, OUTCOME_CODE.YES);

    const before = await busd(agents.challenger.account.address);
    await run(agents.challenger, challenger);
    const disputeId = await disputeOf(m.marketId);
    assert.equal(lines(agents.challenger, "challenged").length, 1);
    assert.equal((await chainMarket(m.marketId)).state, STATE.DISPUTED);

    // Round 0: both jurors believe NO and vote it; the keeper settles; the proposer appeals.
    const jurors = [agents.jurorA, agents.jurorB];
    await playRound(disputeId, jurors);
    for (const j of jurors) assert.equal((await votesBy(j, "VoteCommitted", disputeId)).length, 1, j.name + " committed once");
    const [first] = await resolutionEvents("RoundSettled", { disputeId });
    assert.equal(first!.args.choice, OUTCOME_CODE.NO);
    await indexed();
    lose = "appeal";
    await assert.rejects(run(agents.proposer, proposer), /LOST_RECEIPT/);
    wallet.writeContract = originalWrite;
    publicClient.waitForTransactionReceipt = originalWait;
    assert.equal((await resolutionEvents("Appealed", { disputeId })).length, 1);

    // Round 1 (the appeal): the same jurors vote the same truth; the proposer does not appeal again.
    await playRound(disputeId, jurors);
    await indexed();
    await run(agents.proposer, proposer);
    assert.equal((await resolutionEvents("Appealed", { disputeId })).length, 1, "an appeal is made once");
    assert.equal((await resolutionEvents("RoundSettled", { disputeId })).length, 2, "both rounds settled");
    for (const j of jurors) assert.equal((await votesBy(j, "VoteRevealed", disputeId)).length, 2, j.name + " revealed twice");

    await finalizeDispute(disputeId);
    const [finalized] = await resolutionEvents("DisputeFinalized", { disputeId });
    assert.equal(finalized!.args.choice, OUTCOME_CODE.NO);
    const market = await chainMarket(m.marketId);
    assert.equal(market.state, STATE.FINAL);
    assert.equal(market.finalOutcome, OUTCOME_CODE.NO);

    // The challenger is paid the losing bonds (the proposer's and the appeal's) less the jurors' cut.
    const [appealed] = await resolutionEvents("Appealed", { disputeId });
    const losing = [proposed!.args.bond as bigint, appealed!.args.bond as bigint];
    const prize = losing.reduce((sum, bond) => sum + bond - (bond * BigInt(platform.deployment.params.jurorBondCutBps)) / 10_000n, 0n);
    assert.equal((await busd(agents.challenger.account.address)) - before, prize);
    assert.ok(prize > 0n);

    // The proposer lost: its role stake was slashed below the minimum.
    await restoreRole(agents.proposer.account, ROLE.PROPOSER);

    // After the dispute is final each juror settles both of its votes and claims.
    await indexed();
    for (const j of jurors) {
      await run(j, juror);
      assert.deepEqual(j.ctx.state.data.acted["juror.settled"]!.sort(), [`${disputeId}:0`, `${disputeId}:1`]);
      assert.equal(lines(j, "claimed_rewards").length, 1);
    }
    for (const agent of [...jurors, agents.proposer, agents.challenger, agents.keeper1])
      assert.equal(lines(agent, "tick_error").length, 0);
  },
);

test("upheld creation challenge cancels the market and pays the creator bond to the challenger", { timeout: 600_000 }, async () => {
  const m = await createMarket("ambiguous");
  await indexed();
  const creationBond = (await chainMarket(m.marketId)).creationBond;
  const before = await busd(agents.challenger.account.address);
  await run(agents.challenger, challenger);
  const disputeId = await disputeOf(m.marketId);
  const [opened] = await resolutionEvents("DisputeOpened", { disputeId });
  assert.equal(opened!.args.kind, 0, "a creation dispute");
  assert.equal(opened!.args.ground, 1, "the ambiguous ground");

  // Both jurors' models object to the spec, so both vote 1: upheld.
  await playRound(disputeId, [agents.jurorA, agents.jurorB]);
  await finalizeDispute(disputeId);

  const [finalized] = await resolutionEvents("DisputeFinalized", { disputeId });
  assert.equal(finalized!.args.choice, 1);
  assert.equal((await chainMarket(m.marketId)).state, STATE.CANCELLED);
  const cut = (creationBond * BigInt(platform.deployment.params.jurorBondCutBps)) / 10_000n;
  assert.equal((await busd(agents.challenger.account.address)) - before, creationBond - cut);
  // The creator's bond is not returned: the challenger got it, less the jurors' cut.
  assert.equal((await chainMarket(m.marketId)).creationBond, 0n);
  // The creator lost: its role stake was slashed below the minimum.
  await restoreRole(agents.creator.account, ROLE.CREATOR);
  await indexed();
  for (const j of [agents.jurorA, agents.jurorB]) await run(j, juror);
});

test(
  "challenger disputes the result after its creation challenge was rejected",
  { timeout: 900_000 },
  async () => {
    const m = await createMarket("rejected");
    await indexed();
    await run(agents.challenger, challenger);
    const creationDispute = await disputeOf(m.marketId);
    // The jurors' models see nothing wrong with the spec: the objection is rejected.
    await playRound(creationDispute, [agents.jurorA, agents.jurorB]);
    await finalizeDispute(creationDispute);
    assert.equal((await resolutionEvents("DisputeFinalized", { disputeId: creationDispute }))[0]!.args.choice, 0);
    // Losing slashed the challenger below the role minimum (accepted: the agents do not top up).
    await restoreRole(agents.challenger.account, ROLE.CHALLENGER);

    await openMarket(m);
    await propose(m);
    await run(agents.challenger, challenger);
    const opened = await resolutionEvents("DisputeOpened", { marketId: m.marketId });
    assert.deepEqual(opened.map((e) => e.args.kind), [0, 1], "a creation dispute, then a result dispute");
    assert.deepEqual(lines(agents.challenger, "challenged").slice(-2).map((l) => l.kind), ["CREATION", "RESULT"]);

    const resultDispute = opened[1]!.args.disputeId as bigint;
    await playRound(resultDispute, [agents.jurorA, agents.jurorB]);
    await finalizeDispute(resultDispute);
    assert.equal((await chainMarket(m.marketId)).finalOutcome, OUTCOME_CODE.NO);
    await restoreRole(agents.proposer.account, ROLE.PROPOSER);
    await indexed();
    for (const j of [agents.jurorA, agents.jurorB]) await run(j, juror);
  },
);

test(
  "juror sends no commitment before its salt is on disk, recovers from crashes and retries a failed claim",
  { timeout: 900_000 },
  async () => {
    const m = await createMarket("durable");
    await openMarket(m);
    await propose(m);
    await run(agents.challenger, challenger);
    const disputeId = await disputeOf(m.marketId);
    await indexed();
    await Promise.all([agents.jurorA, agents.jurorC].map((j) => run(j, juror)));

    // The disk fails on two ticks in a row: the second must not send what the first could not save.
    const b = agents.jurorB;
    const saltAt = `juror:${disputeId}:0`;
    const onDisk = async () => (await loadState(b.env.stateDir)).salts[saltAt];
    const repairDisk = failing(b.ctx.state, "save", "SAVE_FAILED", 2);
    await assert.rejects(juror(b.ctx), /SAVE_FAILED/);
    await assert.rejects(juror(b.ctx), /SAVE_FAILED/);
    repairDisk();
    assert.equal((await votesBy(b, "VoteCommitted", disputeId)).length, 0, "nothing was sent without a saved salt");
    assert.equal(await onDisk(), undefined);

    // The salt is saved and the process dies before the transaction goes out.
    const repairSend = failing(b.ctx.walletClient, "writeContract", "CRASH_BEFORE_SEND");
    await assert.rejects(juror(b.ctx), /CRASH_BEFORE_SEND/);
    repairSend();
    const salt = await onDisk();
    assert.match(salt!, /^1:0x[0-9a-f]{64}$/);
    assert.equal((await votesBy(b, "VoteCommitted", disputeId)).length, 0);

    // The new process commits the saved salt, once.
    const second = await startAgent("juror-b", ["juror"], b.account, {
      stateDir: b.env.stateDir,
      join: false,
      model: changedMind("juror-b"),
    });
    agents.jurorB = second;
    assert.equal(second.ctx.state.data.salts[saltAt], salt);
    await run(second, juror);
    assert.equal((await votesBy(second, "VoteCommitted", disputeId)).length, 1);
    assert.equal(await onDisk(), salt, "the committed salt is the saved one");

    // Reveal: the receipt came, and the process died before it wrote that down.
    const { round } = await chainDispute(disputeId);
    await warpTo(round.commitEnd);
    await indexed();
    await Promise.all([agents.jurorA, agents.jurorC, second].map((j) => run(j, juror)));
    const [revealedFirst] = await votesBy(second, "VoteRevealed", disputeId);
    assert.equal(revealedFirst!.args.choice, OUTCOME_CODE.NO, "the reveal is the committed choice, not the new model's");
    second.ctx.state.data.acted["juror.revealed"] = second.ctx.state.data.acted["juror.revealed"]!.filter(
      (k) => k !== `${disputeId}:0`,
    );
    await second.ctx.state.save();
    const third = await startAgent("juror-b", ["juror"], b.account, {
      stateDir: b.env.stateDir,
      join: false,
      model: changedMind("juror-b"),
    });
    agents.jurorB = third;
    await run(third, juror);
    assert.equal((await votesBy(third, "VoteRevealed", disputeId)).length, 1, "never a second reveal");
    assert.ok(third.ctx.state.data.acted["juror.revealed"]!.includes(`${disputeId}:0`), "the reveal is known again");
    assert.equal(lines(third, "tick_error").length, 0);

    await warpTo(round.revealEnd);
    await indexed();
    await run(agents.keeper1, keeper);
    await finalizeDispute(disputeId);
    await indexed();

    // The votes are settled, the claim fails once: the next tick claims, and a later one does not claim again.
    const repairClaim = failing(third.ctx.walletClient, "writeContract", "RPC_DOWN", 1, ([r]) => r.functionName === "claimRewards");
    await assert.rejects(juror(third.ctx), /RPC_DOWN/);
    repairClaim();
    assert.ok(third.ctx.state.data.acted["juror.settled"]!.includes(`${disputeId}:0`));
    assert.ok(!(third.ctx.state.data.acted["juror.claimed"] ?? []).includes(String(disputeId)));
    await run(third, juror);
    assert.equal(lines(third, "claimed_rewards").length, 1);
    assert.ok(third.ctx.state.data.acted["juror.claimed"]!.includes(String(disputeId)));
    await run(third, juror);
    assert.equal(lines(third, "claimed_rewards").length, 1);
    await restoreRole(agents.proposer.account, ROLE.PROPOSER);
    for (const j of [agents.jurorA, agents.jurorC]) await run(j, juror);
    // Later scenarios want juror B with the world file's model again.
    agents.jurorB = await startAgent("juror-b", ["juror"], b.account, { stateDir: b.env.stateDir, join: false });
  },
);

test(
  "a claim the chain refuses is blocked once and does not hold back a vote",
  { timeout: 900_000 },
  async () => {
    const b = agents.jurorB;
    // First dispute: played to the end, so that juror B has a settled vote and a claim to make.
    const m1 = await createMarket("blocked");
    await openMarket(m1);
    await propose(m1);
    await run(agents.challenger, challenger);
    const first = await disputeOf(m1.marketId);
    await playRound(first, [agents.jurorA, b]);
    await finalizeDispute(first);
    await restoreRole(agents.proposer.account, ROLE.PROPOSER);

    // Second dispute: open for commitments while the first claim is pending.
    const m2 = await createMarket("blocked2");
    await openMarket(m2);
    await propose(m2);
    await run(agents.challenger, challenger);
    const second = await disputeOf(m2.marketId);
    await indexed();

    // The chain refuses the claim every time (a mined revert).
    let claims = 0;
    const accept = failing(b.ctx.walletClient, "writeContract", "CLAIM_REWARDS_REVERTED", 100, ([r]) => {
      if (r.functionName !== "claimRewards") return false;
      claims++;
      return true;
    });
    const blocked = () => b.ctx.state.data.acted["juror.claimBlocked"] ?? [];
    await run(b, juror);
    assert.equal((await votesBy(b, "VoteCommitted", second)).length, 1, "the vote of the open round was cast");
    // Every claim juror B had pending (an earlier scenario's included) was refused once and is blocked.
    assert.ok(blocked().includes(String(first)));
    assert.ok(!(b.ctx.state.data.acted["juror.claimed"] ?? []).includes(String(first)), "a refusal is not a claim");
    const refused = claims;
    assert.equal(refused, blocked().length);
    assert.equal(lines(b, "claim_blocked").length, refused);
    await run(b, juror);
    await run(b, juror);
    assert.equal(claims, refused, "a refused claim is not sent again");
    assert.equal(lines(b, "claim_blocked").length, refused);

    // The second dispute runs on and its claim, once the chain accepts it, goes through.
    await playRound(second, [agents.jurorA, b]);
    await finalizeDispute(second);
    accept();
    await restoreRole(agents.proposer.account, ROLE.PROPOSER);
    await indexed();
    await run(b, juror);
    assert.equal(lines(b, "claimed_rewards").filter((l) => l.disputeId === String(second)).length, 1);
    assert.equal(lines(b, "claim_blocked").length, refused);
    await run(agents.jurorA, juror);
  },
);

test("a claim receipt that says reverted is blocked, one with an unknown status is retried", { timeout: 300_000 }, async () => {
  // The claim goes through the real `send`; only the node's answers are replaced.
  const a = agents.jurorA;
  const id = a.ctx.state.data.acted["juror.claimed"]!.at(-1)!;
  const claimed = () => a.ctx.state.data.acted["juror.claimed"]!;
  const blocked = () => a.ctx.state.data.acted["juror.claimBlocked"] ?? [];
  a.ctx.state.data.acted["juror.claimed"] = claimed().filter((x) => x !== id);
  assert.ok(!blocked().includes(id));

  let sent = 0;
  let status: string | undefined;
  const real = { write: (a.ctx.walletClient as any).writeContract, wait: (a.ctx.publicClient as any).waitForTransactionReceipt };
  (a.ctx.walletClient as any).writeContract = async (r: { functionName: string }) =>
    r.functionName === "claimRewards" ? (sent++, ("0x" + "ab".repeat(32)) as Hex) : real.write(r);
  (a.ctx.publicClient as any).waitForTransactionReceipt = async (r: unknown) =>
    sent > 0 ? { status, logs: [] } : real.wait(r);

  try {
    // An unknown status: refused by neither side, so the claim is sent again on the next tick.
    status = undefined;
    await assert.rejects(juror(a.ctx), /CLAIM_REWARDS_RECEIPT_UNKNOWN/);
    await assert.rejects(juror(a.ctx), /CLAIM_REWARDS_RECEIPT_UNKNOWN/);
    assert.equal(sent, 2);
    assert.ok(!blocked().includes(id));
    assert.equal(lines(a, "claim_blocked").length, 0);

    // A reverted receipt: blocked and logged once, never sent again.
    status = "reverted";
    await juror(a.ctx);
    assert.equal(sent, 3);
    assert.ok(blocked().includes(id));
    assert.ok(!claimed().includes(id), "a refusal is not a claim");
    assert.equal(lines(a, "claim_blocked").length, 1);
    await juror(a.ctx);
    assert.equal(sent, 3);
    assert.equal(lines(a, "claim_blocked").length, 1);
  } finally {
    (a.ctx.walletClient as any).writeContract = real.write;
    (a.ctx.publicClient as any).waitForTransactionReceipt = real.wait;
  }
});

test("no proposer means finalizeTimeout and INVALID", { timeout: 600_000 }, async () => {
  const m = await createMarket("silent");
  await openMarket(m);
  await warpTo(m.closeAt);
  await indexed();
  // The proposer's model has no answer for this question, so it proposes nothing.
  await run(agents.proposer, proposer);
  assert.equal((await resolutionEvents("Proposed", { id: m.marketId })).length, 0);
  assert.equal((await chainMarket(m.marketId)).state, STATE.OPEN);

  await warpTo(m.hardDeadline);
  await indexed();
  await run(agents.keeper1, keeper);
  const market = await chainMarket(m.marketId);
  assert.equal(market.state, STATE.FINAL);
  assert.equal(market.finalOutcome, OUTCOME_CODE.INVALID);
  assert.equal((await resolutionEvents("TimeoutFinalized", { id: m.marketId })).length, 1);
  assert.equal(lines(agents.keeper1, "finalize_timeout").length, 1);
});

test("juror votes against a proposal whose evidence bytes are missing", { timeout: 600_000 }, async () => {
  const m = await createMarket("missing");
  await openMarket(m);
  await warpTo(m.closeAt);
  // A proposal for YES whose evidence hash names bytes nobody ever stored.
  const evidenceHash = keccak256(toBytes("evidence that was never uploaded"));
  const bond = (50n * 1_000_000n * BigInt(platform.deployment.params.proposerBondBps)) / 10_000n;
  const { proposer: account } = platform.accounts;
  await write(account, platform.deployment.shared.busd as Hex, agentAbi.usd as Abi, "approve", [resolution(), bond]);
  await write(account, resolution(), agentAbi.resolution as Abi, "propose", [
    m.marketId,
    OUTCOME_CODE.YES,
    evidenceHash,
    `/v1/content/${evidenceHash}`,
  ]);
  await indexed();
  await assert.rejects(anonymous.getContent(evidenceHash), (e) => e instanceof BlinkApiError && e.status === 404);

  // The challenger has no belief about this question: it challenges because the bytes are missing.
  await run(agents.challenger, challenger);
  const disputeId = await disputeOf(m.marketId);

  // Both jurors' models say YES, which is what was proposed; unsupported, they vote NO all the same.
  const jurors = [agents.jurorA, agents.jurorB];
  await playRound(disputeId, jurors);
  for (const j of jurors) {
    const [revealed] = await votesBy(j, "VoteRevealed", disputeId);
    assert.equal(revealed!.args.choice, OUTCOME_CODE.NO, j.name);
  }
  await finalizeDispute(disputeId);
  const market = await chainMarket(m.marketId);
  assert.equal(market.state, STATE.FINAL);
  assert.equal(market.finalOutcome, OUTCOME_CODE.NO);
  // The proposer of the unsupported proposal lost its bond and part of its role stake.
  await restoreRole(agents.proposer.account, ROLE.PROPOSER);
  await indexed();
  for (const j of jurors) await run(j, juror);
});

test("juror restarted after commit still reveals", { timeout: 600_000 }, async () => {
  const m = await createMarket("restart");
  await openMarket(m);
  await propose(m);
  await run(agents.challenger, challenger);
  const disputeId = await disputeOf(m.marketId);

  // Juror B commits, and the process dies.
  const first = agents.jurorB;
  await indexed();
  await run(first, juror);
  assert.equal((await votesBy(first, "VoteCommitted", disputeId)).length, 1);
  const saltAt = `juror:${disputeId}:0`;
  const salt = first.ctx.state.data.salts[saltAt];
  assert.match(salt!, /^1:0x[0-9a-f]{64}$/, "the choice and the salt were saved with the commit");
  // Worse: the commit landed but its answer was lost, so the saved state never recorded it.
  first.ctx.state.data.acted["juror.committed"] = first.ctx.state.data.acted["juror.committed"]!.filter(
    (k) => k !== `${disputeId}:0`,
  );
  await first.ctx.state.save();

  // A new process is built from the state directory alone (it onboards again, as `main` does).
  // Its model has changed its mind meanwhile; the vote is still the one that was committed.
  const second = await startAgent("juror-b", ["juror"], first.account, {
    stateDir: first.env.stateDir,
    model: changedMind("juror-b"),
  });
  agents.jurorB = second;
  assert.equal(second.ctx.state.data.salts[saltAt], salt);
  await run(second, juror);
  await run(second, juror);
  assert.equal((await votesBy(second, "VoteCommitted", disputeId)).length, 1, "never a second commit");
  assert.equal(lines(second, "commit_recovered").length, 1);
  assert.equal(lines(second, "committed").length, 0);

  const { round } = await chainDispute(disputeId);
  await warpTo(round.commitEnd);
  await indexed();
  await run(second, juror);
  const revealed = await votesBy(second, "VoteRevealed", disputeId);
  assert.equal(revealed.length, 1, "the restarted juror reveals what was committed");
  assert.equal(revealed[0]!.args.choice, OUTCOME_CODE.NO);

  await warpTo(round.revealEnd);
  await indexed();
  await run(agents.keeper1, keeper);
  await finalizeDispute(disputeId);
  assert.equal((await chainMarket(m.marketId)).finalOutcome, OUTCOME_CODE.NO);
  await indexed();
  await run(second, juror);
  assert.equal(lines(second, "claimed_rewards").length, 1);
  assert.equal(lines(second, "tick_error").length, 0);
  await restoreRole(agents.proposer.account, ROLE.PROPOSER);
});

test("conflicted juror never commits", { timeout: 900_000 }, async () => {
  const m = await createMarket("conflict");
  await openMarket(m);

  // Juror C takes a position: the maker quotes, juror C fills as a taker.
  const { maker, taker } = platform.accounts;
  const usd = platform.deployment.shared.busd as Hex;
  await write(maker, usd, agentAbi.usd as Abi, "approve", [markets(), maxUint256]);
  await write(maker, markets(), agentAbi.markets, "depositMaker", [20_000_000n]);
  await write(taker, usd, agentAbi.usd as Abi, "approve", [platform.deployment.generation.registry as Hex, maxUint256]);
  await write(taker, platform.deployment.generation.registry as Hex, agentAbi.registry, "joinRole", [
    ROLE.TAKER,
    BigInt(platform.deployment.params.minRoleStake),
  ]);
  await write(taker, usd, agentAbi.usd as Abi, "approve", [markets(), maxUint256]);
  const now = await chainNow();
  const fields = {
    marketId: String(m.marketId),
    specHash: (await chainMarket(m.marketId)).specHash,
    maker: maker.address.toLowerCase(),
    taker: taker.address.toLowerCase(),
    side: "0" as const,
    quantity: "10",
    priceBps: "5000",
    validAfter: String(now),
    expiresAt: String(now + 50n),
    nonce: "1",
    epoch: "0",
  };
  const signature = await maker.signTypedData(quoteTypedData(fields, platform.deployment) as never);
  await write(taker, markets(), agentAbi.markets, "fillQuote", [
    {
      marketId: m.marketId,
      specHash: fields.specHash,
      maker: maker.address,
      taker: taker.address,
      side: 0,
      quantity: 10n,
      priceBps: 5000,
      validAfter: now,
      expiresAt: now + 50n,
      nonce: 1n,
      epoch: 0n,
    },
    signature,
  ]);
  const [yes] = await chain().readContract({
    address: markets(),
    abi: agentAbi.markets,
    functionName: "getPosition",
    args: [m.marketId, taker.address],
  });
  assert.equal(yes, 10n);

  await propose(m);
  await run(agents.challenger, challenger);
  const disputeId = await disputeOf(m.marketId);

  // Juror A is free to vote and shows that the dispute is votable; juror C holds a position.
  await indexed();
  await run(agents.jurorC, juror);
  await run(agents.jurorA, juror);
  assert.equal((await votesBy(agents.jurorA, "VoteCommitted", disputeId)).length, 1);
  assert.equal((await votesBy(agents.jurorC, "VoteCommitted", disputeId)).length, 0);
  assert.equal(lines(agents.jurorC, "skipped_vote").length, 1);
  assert.equal(lines(agents.jurorC, "skipped_vote")[0]!.reason, "CONFLICTED");
  assert.equal(agents.jurorC.ctx.state.data.salts[`juror:${disputeId}:0`], undefined, "no salt is made for a vote that is never cast");

  // The conflicted juror also stays out of the later phases of this round.
  const { round } = await chainDispute(disputeId);
  await warpTo(round.commitEnd);
  await indexed();
  await run(agents.jurorC, juror);
  await run(agents.jurorA, juror);
  assert.equal((await votesBy(agents.jurorC, "VoteRevealed", disputeId)).length, 0);
  await warpTo(round.revealEnd);
  await indexed();
  await run(agents.keeper1, keeper);
  await finalizeDispute(disputeId);
  assert.equal((await chainMarket(m.marketId)).finalOutcome, OUTCOME_CODE.NO);
  assert.equal(lines(agents.jurorC, "tick_error").length, 0);
  await restoreRole(agents.proposer.account, ROLE.PROPOSER);
});

test("two keepers race finalize", { timeout: 600_000 }, async () => {
  const m = await createMarket("race");
  await openMarket(m);
  await propose(m);
  const [proposed] = await resolutionEvents("Proposed", { id: m.marketId });
  await warpTo(proposed!.args.challengeEnd);
  // Both keepers read the market in the same instant, before either finalize lands in the index.
  await indexed();

  await Promise.all([agents.keeper1.ctx, agents.keeper2.ctx].map((ctx) => keeper(ctx)));
  assert.equal((await resolutionEvents("UnchallengedFinalized", { id: m.marketId })).length, 1);
  assert.equal((await chainMarket(m.marketId)).state, STATE.FINAL);
  const finalizations = (event: string) =>
    [agents.keeper1, agents.keeper2].flatMap((k) => lines(k, event)).filter((l) => l.marketId === String(m.marketId));
  assert.equal(finalizations("finalize_unchallenged").length, 1, "one keeper wins");
  const raced = finalizations("raced").filter((l) => l.action === "FINALIZE_UNCHALLENGED");
  assert.equal(raced.length, 1, "the other keeper logs the lost race once");
  assert.equal(raced[0]!.error, "InvalidState");
  for (const k of [agents.keeper1, agents.keeper2]) assert.equal(lines(k, "tick_error").length, 0);
});

test("keeper anchors a closed window root once and leaves a root that is anchored already", { timeout: 300_000 }, async () => {
  // The platform has no forecaster here, so the windows the keeper reads come from a stand-in API
  // client; the anchoring itself is the real BlinkAnchor on chain.
  const fresh = keccak256(toBytes("window root nobody anchored"));
  const taken = keccak256(toBytes("window root anchored by someone else"));
  const anchor = platform.deployment.shared.anchor as Hex;
  await write(platform.accounts.maker, anchor, agentAbi.anchor as Abi, "anchor", [taken]);
  const window = (windowId: string, root: Hex) => ({
    windowId,
    status: "CLOSED",
    deadline: 1,
    root,
  });
  const empty = { items: [], next: null };
  const standIn = {
    listMarkets: async ({ state }: { state: string }) =>
      state === "FINAL"
        ? {
            items: [{ market: { marketId: "9999", state: "FINAL", feesDistributed: true } }],
            next: null,
          }
        : empty,
    listForecastWindows: async () => ({
      items: [window("w-fresh", fresh), window("w-taken", taken)],
      nextCursor: null,
    }),
  };
  const watcher = await startAgent("keeper-anchor", ["keeper"], platform.accounts.taker2, { join: false });
  watcher.ctx.client = standIn as never;
  await keeper(watcher.ctx);

  const anchoredAt = (root: Hex) =>
    chain().readContract({ address: anchor, abi: agentAbi.anchor, functionName: "anchoredAt", args: [root] });
  assert.notEqual(await anchoredAt(fresh), 0n);
  const anchored = await eventsOf(anchor, agentAbi.anchor as Abi, "Anchored");
  assert.equal(anchored.filter((e) => e.args.root === fresh).length, 1);
  assert.equal(anchored.filter((e) => e.args.root === taken).length, 1, "the keeper did not send a second anchor");
  assert.equal(lines(watcher, "anchor").length, 1);
  // The market is handled for good: a second tick reads nothing and sends nothing.
  await keeper(watcher.ctx);
  assert.equal(lines(watcher, "anchor").length, 1);
});

test("keeper keeps a closed window without a root pending until the root appears", { timeout: 300_000 }, async () => {
  const late = keccak256(toBytes("window root published long after the deadline"));
  const anchor = platform.deployment.shared.anchor as Hex;
  // The deadline is far in the past, yet the root is not there: a worker backlog, not a lost window.
  let root: Hex | null = null;
  const standIn = {
    listMarkets: async ({ state }: { state: string }) => ({
      items: state === "FINAL" ? [{ market: { marketId: "9998", state: "FINAL", feesDistributed: true } }] : [],
      next: null,
    }),
    listForecastWindows: async () => ({
      items: [{ windowId: "w-late", status: "CLOSED", deadline: 1, root }],
      nextCursor: null,
    }),
  };
  const watcher = await startAgent("keeper-late", ["keeper"], platform.accounts.taker2, { join: false });
  watcher.ctx.client = standIn as never;
  const anchors = async () =>
    (await eventsOf(anchor, agentAbi.anchor as Abi, "Anchored")).filter((e) => e.args.root === late).length;

  await keeper(watcher.ctx);
  assert.equal(await anchors(), 0);
  assert.deepEqual(watcher.ctx.state.data.acted["keeper.anchorsDone"] ?? [], [], "the market is not done");
  root = late;
  await keeper(watcher.ctx);
  assert.equal(await anchors(), 1, "the late root is anchored on the next tick");
  assert.deepEqual(watcher.ctx.state.data.acted["keeper.anchorsDone"], ["9998"]);
  await keeper(watcher.ctx);
  assert.equal(await anchors(), 1);
});
