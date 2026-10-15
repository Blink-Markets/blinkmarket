import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeFunctionData,
  keccak256,
  parseTransaction,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildApi } from "../../apps/api/src/server.js";
import { tradingServices } from "../../apps/api/src/trading.js";
import { buildSignerServer } from "../../apps/signer/src/server.js";
import { buildTrader } from "../../apps/worker/src/trader.js";
import {
  blinkMarketAbi,
  blinkTestUsdAbi,
} from "../../packages/adapters/src/blink-abi.js";
import { chainLogReader } from "../../packages/adapters/src/chain-log-reader.js";
import { postgresChainIndexStore } from "../../packages/adapters/src/chain-index-store.js";
import { encodeAllowedCall } from "../../packages/adapters/src/signing-calldata.js";
import { postgresJobQueue } from "../../packages/adapters/src/job-queue.js";
import { readKeyFile } from "../../packages/adapters/src/key-file.js";
import { postgresSignerStore } from "../../packages/adapters/src/signing-store.js";
import { viemSignerRpc } from "../../packages/adapters/src/signing-rpc.js";
import { postgresReservationReader } from "../../packages/adapters/src/trading-store.js";
import { createChainIndexer } from "../../packages/application/src/chain-indexer.js";
import {
  createReservationQuoteCheck,
  createSignerService,
} from "../../packages/application/src/signer.js";
import {
  bindWallet,
  createTestDatabase,
  inviteAgent,
} from "../helpers/database.js";
import { deployBlink, startAnvil } from "../helpers/anvil.js";
import { poolAs } from "../helpers/research.js";
import { privateKeyOf, sha256Hex } from "../helpers/signer-fixture.js";
import { DEPLOYMENT, seedSnapshotRows } from "../helpers/trading.js";

const API_TOKEN = "anvil-trader-quote-api";
const WORKER_TOKEN = "anvil-trader-worker";
const signal = new AbortController().signal;

async function world() {
  const anvil = await startAnvil();
  const deployed = await deployBlink(anvil);
  const manifest = { ...deployed.manifest, deploymentId: DEPLOYMENT };
  const market = deployed.market as Address;
  const token = deployed.token as Address;
  const t = await createTestDatabase();
  await t.db.query(
    "INSERT INTO markets.deployments(id,manifest,market_address) VALUES ($1,$2::jsonb,decode($3,'hex'))",
    [DEPLOYMENT, JSON.stringify(manifest), market.slice(2).toLowerCase()],
  );
  const keyDirectory = await mkdtemp(join(tmpdir(), "blink-trader-"));
  const cleanup: (() => Promise<void>)[] = [];
  const close = async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
    await t.close();
    await anvil.stop();
    await rm(keyDirectory, { recursive: true, force: true });
  };
  try {
    const send = async (
      account: (typeof anvil.accounts)["admin"],
      address: Address,
      abi: typeof blinkMarketAbi | typeof blinkTestUsdAbi,
      functionName: string,
      args: readonly unknown[],
    ) => {
      const hash = await anvil.wallet(account).writeContract({
        address,
        abi,
        functionName,
        args,
      } as never);
      const receipt = await anvil.publicClient.waitForTransactionReceipt({
        hash,
      });
      assert.equal(receipt.status, "success", functionName);
      return receipt;
    };
    const { admin, maker, minter, trader, proposer } = anvil.accounts;
    // The maker funds the pool; the trader gets 50 bUSD and nothing else: no allowance is ever pre-set.
    await send(minter, token, blinkTestUsdAbi, "mint", [
      maker.address,
      1_000_000_000n,
    ]);
    await send(minter, token, blinkTestUsdAbi, "mint", [
      trader.address,
      50_000_000n,
    ]);
    await send(maker, token, blinkTestUsdAbi, "approve", [
      market,
      1_000_000_000n,
    ]);
    await send(maker, market, blinkMarketAbi, "depositMaker", [1_000_000_000n]);
    const now = (await anvil.publicClient.getBlock()).timestamp;
    const closeAt = now + 3600n;
    await send(admin, market, blinkMarketAbi, "createMarket", [
      keccak256(toBytes("anvil trader market")),
      "fixture://REPLAY/anvil-trader",
      1,
      closeAt,
      closeAt + 1000n,
      closeAt + 4000n,
      120,
      10000n,
      500n,
    ]);
    await send(admin, market, blinkMarketAbi, "setTakerAllowed", [
      trader.address,
      true,
    ]);

    const indexer = createChainIndexer({
      store: postgresChainIndexStore(poolAs(t, "blink_indexer")),
      reader: chainLogReader(anvil.publicClient),
      deploymentId: DEPLOYMENT,
      marketAddress: market.toLowerCase(),
      deploymentBlock: deployed.deploymentBlock,
      workerId: "anvil-trader",
      rangeSize: 50,
    });
    const sync = async () => {
      for (let steps = 0; ; steps++) {
        assert.ok(steps < 100, "sync converges");
        const { advancedTo, reorgedTo } = await indexer.syncOnce();
        if (advancedTo === null && reorgedTo === null) return;
      }
    };

    // Identities: both platform forecasters answered in a closed window (A 0.80, B 0.50), and the
    // trader is an agent with the quote scope, its wallet verified, and a mandate.
    const forecasters = {
      a: await inviteAgent(t, { name: "fa", scopes: ["forecast:write"] }),
      b: await inviteAgent(t, { name: "fb", scopes: ["forecast:write"] }),
    };
    await t.db.exec("RESET ROLE");
    const windowId = await seedSnapshotRows(t.db, forecasters, {
      a: 0.8,
      b: 0.5,
    });
    const agent = await inviteAgent(t, {
      name: "internal-trader",
      scopes: ["trade:quote"],
    });
    await bindWallet(t, agent.agentId, trader.address);
    await t.db.exec("RESET ROLE");
    await t.db.query(
      `INSERT INTO trading.mandates(agent_id,wallet,forecaster_role,policy_version)
      VALUES($1,decode($2,'hex'),'FORECASTER_A','trader-v1')`,
      [agent.agentId, trader.address.slice(2)],
    );

    // The signer: the only process with keys. The API's token may sign maker quotes only; the
    // worker's token may sign trader transactions only. Anvil's fees exceed the production gas
    // caps, so only this isolated node lifts them.
    const keyPath = (name: string) => join(keyDirectory, name + ".key");
    const keys: Record<string, ReturnType<typeof privateKeyToAccount>> = {};
    for (const [name, account] of [
      ["maker", maker],
      ["trader", trader],
    ] as const) {
      await writeFile(keyPath(name), privateKeyOf(account) + "\n", {
        mode: 0o600,
      });
      await chmod(keyPath(name), 0o600);
      keys[name] = privateKeyToAccount(await readKeyFile(keyPath(name)));
    }
    const signerService = createSignerService({
      store: postgresSignerStore(poolAs(t, "blink_signer")),
      keys: { maker: keys.maker!, trader: keys.trader! },
      rpc: viemSignerRpc({ url: anvil.url }),
      deployment: manifest,
      callers: [
        {
          name: "quote-api",
          tokenSha256: sha256Hex(API_TOKEN),
          roles: ["maker"],
        },
        {
          name: "worker",
          tokenSha256: sha256Hex(WORKER_TOKEN),
          roles: ["trader"],
        },
      ],
      policy: {
        l1FeeMode: "local-none",
        perTxCapWei: 10n ** 16n,
        dailyCapWei: 10n ** 17n,
      },
      encodeCall: encodeAllowedCall,
      quoteCheck: createReservationQuoteCheck(postgresReservationReader()),
    });
    const signerServer = buildSignerServer(signerService);
    await signerServer.listen({ port: 0, host: "127.0.0.1" });
    cleanup.push(() => signerServer.close());
    const signerUrl =
      "http://127.0.0.1:" + (signerServer.server.address() as AddressInfo).port;

    // The public API, composed as apps/api composes trading mode, on a real loopback port.
    const { rfq, readiness } = await tradingServices(
      poolAs(t, "blink_api") as never,
      {
        deploymentId: DEPLOYMENT,
        signerUrl,
        signerToken: API_TOKEN,
        rpcUrl: anvil.url,
      },
    );
    const api = buildApi({
      stage: "m2-trading",
      config: readiness.config,
      services: [rfq],
    });
    api.log.level = "silent";
    await api.listen({ port: 0, host: "127.0.0.1" });
    cleanup.push(() => api.close());
    const apiUrl =
      "http://127.0.0.1:" + (api.server.address() as AddressInfo).port;

    // The worker's trader, composed as apps/worker composes it.
    const workerPool = poolAs(t, "blink_worker");
    const queue = postgresJobQueue(workerPool);
    const built = await buildTrader({
      pool: workerPool,
      queue,
      config: { apiKey: agent.apiKey, forecasterRole: "FORECASTER_A" },
      api: { url: apiUrl },
      execution: {
        deploymentId: DEPLOYMENT,
        signerUrl,
        signerToken: WORKER_TOKEN,
        rpcUrl: anvil.url,
      },
    });
    const evaluate = () =>
      built.handlers["trader.evaluate"]!({
        job: { id: "anvil", payload: {} } as never,
        signal,
      });
    const query = async <R = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      await t.db.exec("RESET ROLE");
      return (await t.db.query<R>(sql, params)).rows;
    };
    const read = (
      address: Address,
      abi: typeof blinkMarketAbi | typeof blinkTestUsdAbi,
      functionName: string,
      args: readonly unknown[] = [],
    ) =>
      anvil.publicClient.readContract({
        address,
        abi,
        functionName,
        args,
      } as never) as Promise<any>;
    return {
      anvil,
      deployed,
      manifest,
      market,
      token,
      t,
      send,
      sync,
      built,
      evaluate,
      query,
      read,
      agent,
      forecasters,
      windowId,
      closeAt,
      close,
      /** One fresh block so the quote's time base is current for the signer's own clock. */
      async freshHead() {
        await anvil.mine(1);
        await sync();
      },
      proposer,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test(
  "Anvil: the trader buys on its edge through the API and the restricted signer, approves exactly, fills, is accounted, and redeems after the market is final",
  { timeout: 240_000 },
  async () => {
    const w = await world();
    try {
      const { trader, admin, proposer } = w.anvil.accounts;
      const balance = () =>
        w.read(w.token, blinkTestUsdAbi, "balanceOf", [trader.address]);
      const position = () =>
        w.read(w.market, blinkMarketAbi, "getPosition", [1n, trader.address]);

      await w.freshHead();
      await w.evaluate();

      // The buy: YES, ten shares, at the ask the ensemble gave (0.65 + 200 bps), nothing more.
      const [reservation] = await w.query<{
        state: string;
        side: string;
        ask_bps: number;
      }>("SELECT state,side,ask_bps FROM trading.risk_reservations");
      assert.deepEqual(reservation, {
        state: "HELD",
        side: "YES",
        ask_bps: 6700,
      });
      const intents = await w.query<{
        kind: string;
        state: string;
        role: string;
      }>(
        "SELECT kind,state,role FROM signing.economic_intents WHERE kind IN ('APPROVE','FILL') ORDER BY created_at,id",
      );
      assert.deepEqual(intents, [
        { kind: "APPROVE", state: "INCLUDED", role: "trader" },
        { kind: "FILL", state: "INCLUDED", role: "trader" },
      ]);
      assert.deepEqual(await position(), [10n, 0n]);
      assert.equal(await balance(), 50_000_000n - 6_700_000n);

      // The approve the signer signed was for exactly the taker cost, to the market, nothing else.
      const [approve] = await w.query<{ raw_transaction: Hex }>(
        `SELECT a.raw_transaction FROM signing.artifacts a
        JOIN signing.sign_requests r ON r.id=a.sign_request_id
        JOIN signing.economic_intents i ON i.id=r.intent_id WHERE i.kind='APPROVE'`,
      );
      const tx = parseTransaction(approve!.raw_transaction);
      assert.equal(tx.to?.toLowerCase(), w.token.toLowerCase());
      assert.equal(tx.value ?? 0n, 0n);
      const decoded = decodeFunctionData({
        abi: blinkTestUsdAbi,
        data: tx.data!,
      });
      assert.equal(decoded.functionName, "approve");
      assert.deepEqual(
        (decoded.args as unknown as [string, bigint]).map((a) =>
          typeof a === "string" ? a.toLowerCase() : a,
        ),
        [w.market.toLowerCase(), 6_700_000n],
      );
      // ...and the fill spent all of it: no allowance is left standing.
      assert.equal(
        await w.read(w.token, blinkTestUsdAbi, "allowance", [
          trader.address,
          w.market,
        ]),
        0n,
      );

      // The indexer sees the fill; the next run accounts it once and buys nothing more on that window.
      await w.sync();
      await w.evaluate();
      assert.deepEqual(
        (
          await w.query<{ state: string }>(
            "SELECT state FROM trading.risk_reservations",
          )
        ).map((r) => r.state),
        ["ACCOUNTED"],
      );
      await w.evaluate();
      assert.equal(
        (await w.query("SELECT id FROM trading.risk_reservations")).length,
        1,
      );
      assert.equal(
        (
          await w.query(
            "SELECT id FROM signing.economic_intents WHERE kind IN ('APPROVE','FILL')",
          )
        ).length,
        2,
      );

      // The worker's tick schedules the evaluations and the tracking jobs the trader asked for. A window
      // that has just closed (no edge in it) gets its own evaluation.
      await w.t.db.exec("RESET ROLE");
      const justClosed = await seedSnapshotRows(w.t.db, w.forecasters, {
        hoursAgo: 0,
      });
      await w.built.tick();
      const jobs = await w.query<{ type: string; dedupe_key: string }>(
        "SELECT type,dedupe_key FROM operations.jobs ORDER BY dedupe_key",
      );
      assert.equal(jobs.filter((j) => j.type === "tx.dispatch").length, 2);
      assert.ok(
        jobs.some(
          (j) => j.dedupe_key === `trader.evaluate:window:${justClosed}`,
        ),
        "one evaluation per closed window",
      );
      assert.ok(
        jobs.some(
          (j) => j.type === "trader.evaluate" && j.dedupe_key.includes("{}"),
        ),
        "and the five-minute run",
      );

      // The market ends YES: proposed after close, unchallenged for the challenge period, finalized.
      await w.anvil.setNextTimestamp(w.closeAt + 1n);
      await w.send(proposer, w.market, blinkMarketAbi, "proposeOutcome", [
        1n,
        0, // YES
        keccak256(toBytes("anvil trader outcome")),
      ]);
      const proposedAt = (await w.anvil.publicClient.getBlock()).timestamp;
      await w.anvil.setNextTimestamp(proposedAt + 120n);
      await w.send(admin, w.market, blinkMarketAbi, "finalizeUnchallenged", [
        1n,
      ]);
      await w.freshHead();
      const before = await balance();
      await w.evaluate();
      assert.deepEqual(await position(), [0n, 0n], "redeemed on chain");
      assert.equal(
        await balance(),
        before + 10_000_000n,
        "10 shares of YES pay 10 bUSD",
      );
      assert.deepEqual(
        await w.query<{ kind: string; state: string }>(
          "SELECT kind,state FROM signing.economic_intents WHERE kind='REDEEM'",
        ),
        [{ kind: "REDEEM", state: "INCLUDED" }],
      );
      // Once the indexer folds the redeem there is nothing left to redeem, and nothing is sent twice.
      await w.sync();
      await w.evaluate();
      assert.equal(
        (
          await w.query(
            "SELECT id FROM signing.economic_intents WHERE kind='REDEEM'",
          )
        ).length,
        1,
      );
      // Only the trader role ever signed for this wallet.
      assert.deepEqual(
        (
          await w.query<{ role: string }>(
            "SELECT DISTINCT role FROM signing.economic_intents WHERE kind IN ('APPROVE','FILL','REDEEM')",
          )
        ).map((r) => r.role),
        ["trader"],
      );
    } finally {
      await w.close();
    }
  },
);
