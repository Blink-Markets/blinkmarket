// Manual check, never in CI: a Coinbase CDP server wallet can onboard to Blink and sign every agent
// payload. Run it with `pnpm check:cdp-wallet` on the operator's machine, with CDP_API_KEY_ID,
// CDP_API_KEY_SECRET and CDP_WALLET_SECRET in the env file the script names (default
// ~/.config/blink/cdp.env). The script runs this file through tests/cdp/run.mjs, which masks those
// values in all output. Without all three the test skips. The values are read only by the CDP SDK:
// this file never prints, logs or asserts on them. CDP only signs here. Every transaction goes to
// the local Anvil (chain 84532); nothing is sent to Base Sepolia and no CDP faucet or send is used.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CdpClient } from "@coinbase/cdp-sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Hex,
  type LocalAccount,
} from "viem";
import { toAccount } from "viem/accounts";
import { ROLE, agentAbi, createBlinkClient } from "../../packages/client/src/index.ts";
import type { AgentContext, RoleName } from "../../examples/agents/src/lib/env.ts";
import { createLogger } from "../../examples/agents/src/lib/log.ts";
import { runAgent, type RoleTick } from "../../examples/agents/src/lib/loop.ts";
import { fixtureModel } from "../../examples/agents/src/lib/model.ts";
import { onboard } from "../../examples/agents/src/lib/session.ts";
import { loadState, saveState } from "../../examples/agents/src/lib/state.ts";
import { parseWorld } from "../../examples/agents/src/lib/world.ts";
import { creator } from "../../examples/agents/src/roles/creator.ts";
import { forecaster } from "../../examples/agents/src/roles/forecaster.ts";
import { maker } from "../../examples/agents/src/roles/maker.ts";
import { createTrader } from "../../examples/agents/src/roles/trader.ts";
import { startAlphaPlatform, waitFor, type AlphaPlatform } from "../../scripts/alpha/platform.ts";
import { redacted } from "./redact.ts";

const CREDENTIALS = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"] as const;
const ACCOUNT_NAME = "blink-p3-check";
const CHAIN_ID = 84532;
const GAS_MONEY = "0x56bc75e2d63100000"; // 100 test ETH, set on the local Anvil only
const QUESTION = "Will the CDP check company report a GAAP gross margin below 40 percent?";

// The CDP account is the maker and the forecaster; a test account takes the quote.
const world = parseWorld(
  {
    questions: {
      q: {
        spec: {
          schema: "blink.market-spec/0.2",
          title: QUESTION,
          question: QUESTION,
          class: "B",
          resolution: { yes: "Yes.", no: "No." },
          sources: ["https://example.com/cdp-check"],
        },
        closeInSeconds: 240,
        maxPairs: 100,
      },
    },
    suggestions: {},
    agents: {
      creator: { roles: ["creator"], creates: ["q"], beliefs: {} },
      cdp: { roles: ["maker", "forecaster"], beliefs: { q: { probabilityBps: 6000 } } },
      taker: { roles: ["trader"], beliefs: { q: { probabilityBps: 8000 } } },
    },
  },
  tmpdir(),
);

type Line = { event: string; [field: string]: unknown };
type Agent = { ctx: AgentContext; lines: Line[] };

/** The reference runtime's context, for any viem account: the CDP wallet signs, the node is the local Anvil. */
async function startAgent(
  platform: AlphaPlatform,
  dirs: string[],
  who: { name: "creator" | "cdp" | "taker"; account: LocalAccount; roles: RoleName[] },
): Promise<Agent> {
  const stateDir = await mkdtemp(join(tmpdir(), "blink-cdp-check-"));
  dirs.push(stateDir);
  const chain = defineChain({
    id: CHAIN_ID,
    name: "Blink local",
    nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [platform.rpcUrl] } },
  });
  const transport = http(platform.rpcUrl, { retryCount: 0 });
  const client = createBlinkClient(platform.apiUrl);
  const data = await loadState(stateDir);
  const lines: Line[] = [];
  const ctx: AgentContext = {
    name: who.name,
    roles: who.roles,
    apiUrl: platform.apiUrl,
    client,
    publicClient: createPublicClient({ chain, transport, pollingInterval: 100, cacheTime: 0 }),
    walletClient: createWalletClient({ account: who.account, chain, transport }),
    account: who.account,
    deployment: (await client.getDeployment()).deployment,
    model: fixtureModel(world, who.name),
    state: { data, save: () => saveState(stateDir, data) },
    log: createLogger(who.name, [], (line) => lines.push(JSON.parse(line) as Line)),
  };
  await onboard(ctx);
  return { ctx, lines };
}

const events = (agent: Agent, name: string) => agent.lines.filter((l) => l.event === name);

/** One tick of a role; a refusal that asks to come back later is waited out, as the agent loop does. */
async function tick(role: RoleTick, ctx: AgentContext) {
  for (let attempt = 1; ; attempt++)
    try {
      return await role(ctx);
    } catch (error) {
      const refusal = error as { status?: number; body?: { code?: string }; retryAfterSeconds?: number };
      const backoff = refusal.status === 429 || refusal.body?.code === "INDEX_STALE";
      if (!backoff || attempt >= 10) throw error;
      await new Promise((r) => setTimeout(r, (refusal.retryAfterSeconds ?? 2) * 1000));
    }
}

/** A transaction from a plain Anvil test account (setup of the market, not the CDP wallet), waited for. */
async function write(platform: AlphaPlatform, who: LocalAccount, address: string, abi: Abi, functionName: string, args: unknown[] = []) {
  const receipt = await platform.anvil.publicClient.waitForTransactionReceipt({
    hash: await platform.anvil.wallet(who).writeContract({ address: address as Hex, abi, functionName, args, gas: 5_000_000n } as never),
  });
  assert.equal(receipt.status, "success", functionName);
}

/** An arbiter stakes platform tokens: createMarket is bounded by what the jurors have at stake. */
async function stakeJurors(platform: AlphaPlatform) {
  const { shared, generation, params } = platform.deployment;
  const arbiter = platform.accounts.arbiter;
  const call = (address: string, abi: unknown, fn: string, args: unknown[] = []) =>
    write(platform, arbiter, address, abi as Abi, fn, args);
  await call(shared.faucet, agentAbi.faucet, "claim");
  await call(shared.busd, agentAbi.usd, "approve", [generation.registry, BigInt(params.registrationFee)]);
  await call(generation.registry, agentAbi.registry, "register");
  const tokens = 990n * 10n ** 18n;
  await call(shared.token, agentAbi.platformToken, "approve", [generation.jurors, tokens]);
  await call(generation.jurors, agentAbi.jurors, "stake", [tokens]);
}

/** Creates the market with the reference creator, waits out the creation window, and opens it as a keeper would. */
async function openMarket(platform: AlphaPlatform, dirs: string[]): Promise<string> {
  await stakeJurors(platform);
  const agent = await startAgent(platform, dirs, { name: "creator", account: platform.accounts.admin, roles: ["creator"] });
  await tick(creator, agent.ctx);
  const marketId = String(events(agent, "market_created")[0]?.marketId);
  const markets = platform.deployment.generation.markets;
  const chainTime = async () => (await platform.anvil.publicClient.getBlock()).timestamp;
  const { openAt } = (await platform.anvil.publicClient.readContract({
    address: markets as Hex,
    abi: agentAbi.markets,
    functionName: "getMarket",
    args: [BigInt(marketId)],
  } as never)) as { openAt: bigint };
  await waitFor("the creation window", async () => (await chainTime()) >= openAt, 120_000, 500);
  await write(platform, platform.accounts.keeper, markets, agentAbi.markets as Abi, "open", [BigInt(marketId)]);
  await waitFor("the market open in the index", async () => (await agent.ctx.client.getMarket({ marketId })).market.state === "OPEN", 120_000);
  return marketId;
}

/** Faucet claim, register, MAKER and FORECASTER, and an API key issued on the wallet proof: all from the CDP account. */
async function checkOnboarding(cdp: Agent) {
  const names = cdp.lines.map((l) => l.event);
  for (const step of ["faucet_claimed", "registered", "api_key_issued"]) assert.ok(names.includes(step), step);
  assert.equal(events(cdp, "joined_role").length, 2);
  for (const role of [ROLE.MAKER, ROLE.FORECASTER])
    assert.equal(
      await cdp.ctx.publicClient.readContract({
        address: cdp.ctx.deployment.generation.registry as Hex,
        abi: agentAbi.registry,
        functionName: "hasRole",
        args: [cdp.ctx.account.address, role],
      }),
      true,
    );
  // The API accepted the wallet proof: the key it issued works on an authenticated route.
  assert.deepEqual((await cdp.ctx.client.listRfqs()).items, []);
}

/** The CDP account quotes, the taker verifies the quote and fills it on chain. */
async function checkQuote(platform: AlphaPlatform, dirs: string[], cdp: Agent) {
  const taker = await startAgent(platform, dirs, { name: "taker", account: platform.accounts.taker, roles: ["trader"] });
  const stop = new AbortController();
  const loops = [
    runAgent(cdp.ctx, [maker], { tickMs: 200, signal: stop.signal }),
    runAgent(
      taker.ctx,
      [createTrader({ pollMs: 200, waitMs: { quotes: 60_000, receipt: 60_000, settle: 60_000, grace: 4000 } })],
      { tickMs: 500, signal: stop.signal },
    ),
  ];
  try {
    await waitFor("the taker's fill", async () => events(taker, "filled")[0], 240_000, 500);
  } finally {
    stop.abort();
    await Promise.all(loops);
  }
  // The taker ran verifySignedQuote on every quote it was shown and ignored none of them.
  assert.deepEqual(events(taker, "quote_ignored"), []);
  assert.equal(events(cdp, "quote_posted").length, 1);
  const fills = (await platform.anvil.publicClient.getContractEvents({
    address: platform.deployment.generation.markets as Hex,
    abi: agentAbi.markets,
    eventName: "QuoteFilled",
    fromBlock: 0n,
  } as never)) as unknown as { args: { maker: string; taker: string } }[];
  assert.equal(fills.length, 1);
  assert.equal(fills[0]!.args.maker.toLowerCase(), cdp.ctx.account.address.toLowerCase());
  assert.equal(fills[0]!.args.taker.toLowerCase(), taker.ctx.account.address.toLowerCase());
}

/** The CDP account signs a Forecast and the forecast route accepts it. */
async function checkForecast(cdp: Agent, marketId: string) {
  await waitFor("an open forecast window", async () =>
    (await cdp.ctx.client.listForecastWindows({ marketId })).items.some((w) => w.status === "OPEN"), 400_000, 1000);
  await tick(forecaster, cdp.ctx);
  const submitted = events(cdp, "forecast_submitted");
  assert.ok(submitted.length >= 1);
  for (const line of submitted) {
    const stored = (await cdp.ctx.client.listForecasts({ marketId }, { windowId: String(line.windowId) })).items;
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.forecaster.toLowerCase(), cdp.ctx.account.address.toLowerCase());
  }
}

/** Runs one named stage of the check; the CDP test passes a wrapper that redacts failures. */
export type Stage = <T>(name: string, run: () => Promise<T>) => Promise<T>;
const plain: Stage = (_name, run) => run();

/**
 * Everything the CDP check asserts, for any viem account. The test below passes the CDP server
 * account; a local run with a public Anvil test account proves the flow without credentials.
 */
export async function checkWalletOnboardsAndSigns(account: LocalAccount, stage: Stage = plain): Promise<void> {
  const platform = await stage("platform", () => startAlphaPlatform({ backend: "pglite" }));
  const dirs: string[] = [];
  try {
    const cdp = await stage("onboard", async () => {
      // Gas money on the local Anvil is test setup: the wallet itself is never funded by CDP.
      await platform.anvil.publicClient.request({ method: "anvil_setBalance", params: [account.address, GAS_MONEY] } as never);
      const agent = await startAgent(platform, dirs, { name: "cdp", account, roles: ["maker", "forecaster"] });
      await checkOnboarding(agent);
      return agent;
    });
    const marketId = await stage("market", () => openMarket(platform, dirs));
    await stage("quote", () => checkQuote(platform, dirs, cdp));
    await stage("forecast", () => checkForecast(cdp, marketId));
  } finally {
    await stage("platform", () => platform.stop());
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }
}

const missing = CREDENTIALS.filter((name) => !process.env[name]);
const skip = missing.length > 0 ? `no CDP credentials: ${missing.join(", ")} not set (see BLINK_CDP_ENV)` : false;
if (skip) console.log(`SKIP cdp-wallet: ${skip}`);

test("CDP server account onboards and signs every agent payload", { skip, timeout: 900_000 }, async () => {
  // The SDK would otherwise send error details and usage to Coinbase analytics.
  process.env.DISABLE_CDP_ERROR_REPORTING = "true";
  process.env.DISABLE_CDP_USAGE_TRACKING = "true";
  // toAccount is inside the stage too: viem's InvalidAddressError embeds the address the SDK returned.
  const account = await redacted("acquire", async () =>
    toAccount(await new CdpClient().evm.getOrCreateAccount({ name: ACCOUNT_NAME })),
  );
  await checkWalletOnboardsAndSigns(account, redacted);
});
