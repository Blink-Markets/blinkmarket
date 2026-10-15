import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { buildApi } from "../../apps/api/src/server.js";
import { tradingServices } from "../../apps/api/src/trading.js";
import { buildSignerServer } from "../../apps/signer/src/server.js";
import { buildExecution } from "../../apps/worker/src/execution.js";
import {
  blinkMarketAbi,
  blinkTestUsdAbi,
} from "../../packages/adapters/src/blink-abi.js";
import { chainLogReader } from "../../packages/adapters/src/chain-log-reader.js";
import { postgresChainIndexStore } from "../../packages/adapters/src/chain-index-store.js";
import { postgresFaucetStore } from "../../packages/adapters/src/faucet-store.js";
import { postgresForecastStore } from "../../packages/adapters/src/forecast-store.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { postgresIdentityStore } from "../../packages/adapters/src/identity-store.js";
import { postgresJobQueue } from "../../packages/adapters/src/job-queue.js";
import { postgresMarketReadStore } from "../../packages/adapters/src/market-read-store.js";
import { encodeAllowedCall } from "../../packages/adapters/src/signing-calldata.js";
import { viemSignerRpc } from "../../packages/adapters/src/signing-rpc.js";
import { postgresSignerStore } from "../../packages/adapters/src/signing-store.js";
import {
  createSpecArchive,
  encodeNewSpec,
} from "../../packages/adapters/src/spec-archive.js";
import { postgresReservationReader } from "../../packages/adapters/src/trading-store.js";
import {
  postgresTxTrackingStore,
  txTrackingManifest,
} from "../../packages/adapters/src/tx-tracking-store.js";
import { txReceiptReader } from "../../packages/adapters/src/tx-receipt-reader.js";
import { createChainIndexer } from "../../packages/application/src/chain-indexer.js";
import { createTxTracker } from "../../packages/application/src/tx-tracking.js";
import { createFaucetService } from "../../packages/application/src/faucet.js";
import { createForecastService } from "../../packages/application/src/forecasts.js";
import {
  authenticateIdentity,
  createIdentityService,
} from "../../packages/application/src/identity.js";
import { createMarketReadService } from "../../packages/application/src/market-read.js";
import {
  createReservationQuoteCheck,
  createSignerService,
} from "../../packages/application/src/signer.js";
import { startWorker } from "../../packages/application/src/worker-runtime.js";
import { runAgent } from "../../examples/agent/run.js";
import { deployBlink, startAnvil } from "../helpers/anvil.js";
import { createTestDatabase, inviteAgent } from "../helpers/database.js";
import { poolAs } from "../helpers/research.js";
import { privateKeyOf, sha256Hex } from "../helpers/signer-fixture.js";
import { DEPLOYMENT, seedSnapshotRows } from "../helpers/trading.js";

const QUOTE_TOKEN = "client-agent-quote-token";
const EXECUTION_TOKEN = "client-agent-execution-token";

/**
 * The real API, signer, worker and indexer over one PGlite database and a local Anvil (chain ID
 * 84532), with one OPEN market, a funded maker and an invited agent that has no wallet yet. Blocks
 * come from a loop the test can hold back; `settle()` proposes and finalizes the outcome YES.
 */
async function stack() {
  const anvil = await startAnvil();
  const t = await createTestDatabase();
  const cleanup: (() => Promise<void> | void)[] = [];
  const stopBackground = async () => {
    for (const fn of cleanup.splice(0).reverse())
      await Promise.resolve(fn()).catch(() => undefined);
  };
  try {
    const deployed = await deployBlink(anvil);
    const manifest = { ...deployed.manifest, deploymentId: DEPLOYMENT };
    const market = deployed.market as Address;
    const token = deployed.token as Address;
    await t.db.query(
      "INSERT INTO markets.deployments(id,manifest,market_address) VALUES ($1,$2::jsonb,decode($3,'hex'))",
      [DEPLOYMENT, JSON.stringify(manifest), market.slice(2).toLowerCase()],
    );
    const { admin, maker, proposer, minter, taker, keeper } = anvil.accounts;
    const send = async (
      account: typeof admin,
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
    };

    // --- chain: a funded maker, an allowed taker, one OPEN market with a real frozen spec ---
    await send(minter, token, blinkTestUsdAbi, "mint", [
      maker.address,
      1_000_000_000n,
    ]);
    await send(maker, token, blinkTestUsdAbi, "approve", [
      market,
      1_000_000_000n,
    ]);
    await send(maker, market, blinkMarketAbi, "depositMaker", [1_000_000_000n]);
    await send(admin, market, blinkMarketAbi, "setTakerAllowed", [
      taker.address,
      true,
    ]);
    const evidenceId = randomUUID();
    const now = (await anvil.publicClient.getBlock()).timestamp;
    const closeAt = now + 3600n;
    const frozen = encodeNewSpec(
      {
        schemaVersion: "blink.market.v0.1.1",
        mode: "REPLAY",
        templateId: "GM_LT_V1",
        entityId: "fixture-company-not-real",
        fiscalPeriod: "FY2025Q1",
        periodStart: "2025-01-01",
        periodEnd: "2025-03-31",
        metric: "quarterly_gaap_reported_gross_margin",
        thresholdBps: 7000,
        comparator: "LT",
        sourceAllowlist: ["https://example.com/fixture-only"],
        valueVersion: "FIRST_QUALIFYING_RELEASE",
        missingValueOutcome: "INVALID",
        invalidYesPayoutMicros: 500000,
        invalidNoPayoutMicros: 500000,
        closeAt: String(closeAt),
        proposalDeadline: String(closeAt + 1000n),
        hardDeadline: String(closeAt + 4000n),
        challengeSeconds: 120,
        fundingType: "PLATFORM_RESEARCH_SUBSIDY",
        sourceEvidenceIds: [evidenceId],
        resolutionPolicy: {
          hardDeadlineOutcome: "INVALID",
          unfinalizedProposalAtHardDeadline: "INVALID",
          invalidPayoutRule: "HALF_PER_SIDE_NOT_PURCHASE_REFUND",
          authorityModel: "TEAM_OPERATED_WHITELISTED_ROLES",
        },
      },
      now,
    );
    const specUri = "memory://spec/1";
    const objects = new Map([[specUri, frozen.bytes]]);
    const archive = createSpecArchive({
      read: async (uri) => objects.get(uri) ?? assert.fail("missing " + uri),
      putIfAbsent: async () => assert.fail("read-only archive"),
    });
    await send(admin, market, blinkMarketAbi, "createMarket", [
      frozen.hash,
      specUri,
      1,
      closeAt,
      closeAt + 1000n,
      closeAt + 4000n,
      120,
      10000n,
      500n,
    ]);

    // --- the indexer and the transaction tracker, kept in step with the chain by a short timer ---
    const indexer = createChainIndexer({
      store: postgresChainIndexStore(poolAs(t, "blink_indexer")),
      reader: chainLogReader(anvil.publicClient),
      deploymentId: DEPLOYMENT,
      marketAddress: market.toLowerCase(),
      deploymentBlock: deployed.deploymentBlock,
      workerId: "client-agent",
      rangeSize: 50,
    });
    const sync = async () => {
      for (let steps = 0; steps < 100; steps++) {
        const { advancedTo, reorgedTo } = await indexer.syncOnce();
        if (advancedTo === null && reorgedTo === null) return;
      }
    };
    await sync();
    const trackerPool = poolAs(t, "blink_indexer");
    const tracker = createTxTracker({
      store: postgresTxTrackingStore(trackerPool),
      reader: txReceiptReader(anvil.publicClient),
      manifest: (deploymentId) => txTrackingManifest(trackerPool, deploymentId),
    });
    let syncing = false;
    const syncTimer = setInterval(() => {
      if (syncing) return;
      syncing = true;
      sync()
        .then(() => tracker.trackOnce(50))
        .catch(() => undefined)
        .finally(() => {
          syncing = false;
        });
    }, 150);
    cleanup.push(async () => {
      clearInterval(syncTimer);
      while (syncing) await delay(20);
    });

    // --- data the platform provides: forecasts for pricing, evidence and an open window ---
    const forecasters = {
      a: await inviteAgent(t, { name: "fa", scopes: ["forecast:write"] }),
      b: await inviteAgent(t, { name: "fb", scopes: ["forecast:write"] }),
    };
    await t.db.exec("RESET ROLE");
    await seedSnapshotRows(t.db, forecasters);
    const source = randomUUID();
    await t.db.query(
      "INSERT INTO evidence.sources(id,entity_id,source_url) VALUES($1,'fixture','https://fixture.invalid/evidence')",
      [source],
    );
    await t.db.query(
      "INSERT INTO evidence.records(id,source_id,operator_id,content_hash,object_uri,access_policy) VALUES($1,$2,$3,decode(repeat('55',32),'hex'),'fixture','PUBLIC')",
      [evidenceId, source, forecasters.a.operatorId],
    );
    await t.db.query(
      `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
      SELECT $1,$2,1,'DAILY',d,d-interval '30 minutes',d FROM (SELECT blink.now()+interval '20 minutes' AS d) stamp`,
      [randomUUID(), DEPLOYMENT],
    );
    const agent = await inviteAgent(t, {
      name: "example-agent",
      scopes: ["forecast:write", "trade:quote", "faucet:claim"],
    });

    // --- the signer: the maker signs quotes, the faucet key mints ---
    const signerService = createSignerService({
      store: postgresSignerStore(poolAs(t, "blink_signer")),
      keys: { maker, faucet: minter, keeper },
      rpc: viemSignerRpc({ url: anvil.url }),
      deployment: manifest,
      callers: [
        {
          name: "quote-api",
          tokenSha256: sha256Hex(QUOTE_TOKEN),
          roles: ["maker"],
        },
        {
          name: "execution",
          tokenSha256: sha256Hex(EXECUTION_TOKEN),
          roles: ["faucet", "keeper"],
        },
      ],
      // Only this isolated Anvil lifts the gas caps; production caps are unchanged.
      policy: {
        l1FeeMode: "local-none",
        perTxCapWei: 10n ** 16n,
        dailyCapWei: 10n ** 17n,
      },
      encodeCall: encodeAllowedCall,
      quoteCheck: createReservationQuoteCheck(postgresReservationReader()),
    });
    const signerServer = buildSignerServer(signerService);
    signerServer.log.level = "silent";
    await signerServer.listen({ port: 0, host: "127.0.0.1" });
    cleanup.push(() => signerServer.close());
    const signerUrl =
      "http://127.0.0.1:" + (signerServer.server.address() as AddressInfo).port;

    // --- the API, composed as `apps/api` composes trading mode, on a real loopback port ---
    const apiPool = poolAs(t, "blink_api");
    const { rfq, readiness } = await tradingServices(apiPool as never, {
      deploymentId: DEPLOYMENT,
      signerUrl,
      signerToken: QUOTE_TOKEN,
      rpcUrl: anvil.url,
    });
    const identityStore = postgresIdentityStore(apiPool);
    const app = buildApi({
      stage: "m2-trading",
      config: readiness.config,
      identity: createIdentityService(
        identityStore,
        identityCrypto,
        "https://blink.example",
      ),
      services: [
        createFaucetService({
          store: postgresFaucetStore(apiPool),
          crypto: identityCrypto,
          deploymentId: DEPLOYMENT,
        }),
        createForecastService({
          store: postgresForecastStore(apiPool),
          crypto: identityCrypto,
        }),
        rfq,
        createMarketReadService({
          store: postgresMarketReadStore(apiPool),
          archive,
          hooks: { canTrade: readiness.canTrade },
          identity: {
            authenticate: (authorization) =>
              identityStore.run(async (tx) => {
                const principal = await authenticateIdentity(
                  tx,
                  identityCrypto,
                  authorization,
                );
                return {
                  ...principal,
                  wallet: await tx.wallet(principal.agentId),
                };
              }),
          },
        }),
      ],
    });
    app.log.level = "silent";
    await app.listen({ port: 0, host: "127.0.0.1" });
    cleanup.push(() => app.close());
    const apiUrl =
      "http://127.0.0.1:" + (app.server.address() as AddressInfo).port;

    // --- the worker: faucet mint and its dispatch, as `apps/worker` runs them ---
    const workerPool = poolAs(t, "blink_worker");
    const queue = postgresJobQueue(workerPool);
    const execution = await buildExecution({
      pool: workerPool,
      queue,
      config: {
        deploymentId: DEPLOYMENT,
        signerUrl,
        signerToken: EXECUTION_TOKEN,
        rpcUrl: anvil.url,
      },
    });
    const worker = startWorker({
      queue,
      handlers: execution.handlers,
      workerId: "client-agent",
      pollIntervalMs: 100,
    });
    cleanup.push(() => worker.stop());

    // --- blocks come from this loop, which a test can hold back to keep a transaction pending ---
    const setAutomine = (on: boolean) =>
      anvil.publicClient.request({
        method: "anvil_setAutomine" as never,
        params: [on] as never,
      });
    await setAutomine(false);
    const blocks = { held: false, producing: true };
    const producer = (async () => {
      while (blocks.producing) {
        if (!blocks.held) await anvil.mine(1);
        await delay(100);
      }
    })();
    const stopBlocks = async () => {
      blocks.producing = false;
      await producer;
      await setAutomine(true);
    };
    cleanup.push(async () => {
      blocks.producing = false;
      await producer;
    });

    return {
      anvil,
      t,
      market,
      token,
      apiUrl,
      apiKey: agent.apiKey,
      privateKey: privateKeyOf(taker),
      taker,
      blocks,
      stopBackground,
      /** The market closes, the proposer proposes YES, the challenge window passes, anyone finalizes. */
      async settle() {
        await stopBlocks();
        await anvil.setNextTimestamp(closeAt + 1n);
        await send(proposer, market, blinkMarketAbi, "proposeOutcome", [
          1n,
          0,
          keccak256(toBytes("example evidence")),
        ]);
        await anvil.setNextTimestamp(closeAt + 200n);
        await send(keeper, market, blinkMarketAbi, "finalizeUnchallenged", [
          1n,
        ]);
      },
      async read<T>(
        address: Address,
        abi: typeof blinkMarketAbi | typeof blinkTestUsdAbi,
        functionName: string,
        args: readonly unknown[],
      ) {
        return (await anvil.publicClient.readContract({
          address,
          abi,
          functionName,
          args,
        } as never)) as T;
      },
      async quotes() {
        await stopBackground();
        await t.db.exec("RESET ROLE");
        return (
          await t.db.query<{ digest: string; key: string }>(
            "SELECT envelope->>'quoteId' AS digest, idempotency_key AS key FROM trading.quotes ORDER BY created_at",
          )
        ).rows;
      },
    };
  } catch (error) {
    await stopBackground();
    await t.close();
    await anvil.stop();
    throw error;
  }
}
type Stack = Awaited<ReturnType<typeof stack>>;
async function withStack(work: (s: Stack) => Promise<void>) {
  const s = await stack();
  try {
    await work(s);
  } finally {
    await s.stopBackground();
    await s.t.close();
    await s.anvil.stop();
  }
}

/** Runs the example and keeps what it says; a failure of the run surfaces in the waits. */
function startAgent(
  s: Stack,
  options: { rpcUrl?: string; holdBlocksAtBalance?: boolean } = {},
) {
  const lines: string[] = [];
  const seen = (pattern: RegExp) => lines.filter((l) => pattern.test(l));
  let failure: unknown;
  const run = runAgent({
    apiUrl: s.apiUrl,
    apiKey: s.apiKey,
    privateKey: s.privateKey,
    rpcUrl: options.rpcUrl ?? s.anvil.url,
    pollMs: 100,
    log(line) {
      lines.push(line);
      // From here to the first quote the example sends nothing on chain: freeze the blocks so
      // its approval stays pending.
      if (line.startsWith("balance ") && options.holdBlocksAtBalance)
        s.blocks.held = true;
    },
  });
  run.catch((error) => {
    failure = error;
  });
  const until = async (what: string, ok: () => boolean) => {
    for (let i = 0; i < 1200 && !ok() && !failure; i++) await delay(100);
    if (failure) throw failure;
    assert.ok(ok(), `timed out waiting for ${what}\n${lines.join("\n")}`);
  };
  return { run, lines, seen, until };
}

// The example agent, unchanged, against the full local stack. Its first quote is made to expire
// while the approval is still waiting to be mined, so the run also shows the requote under a new
// Idempotency-Key.
test(
  "Anvil: the example external agent binds, forecasts, claims, buys with a verified quote, requotes after expiry, waits for FINAL and redeems",
  { timeout: 240_000 },
  async () => {
    await withStack(async (s) => {
      const agent = startAgent(s, { holdBlocksAtBalance: true });
      await agent.until(
        "the first quote",
        () => agent.seen(/^quote 0x/).length === 1,
      );
      const first = /^quote (0x[0-9a-f]{64}) .* expires (\d+)/.exec(
        agent.seen(/^quote 0x/)[0]!,
      )!;
      // The approval is pending; the block that includes it is five seconds past the quote's expiry.
      for (let i = 0; i < 100; i++) {
        const status = (await s.anvil.publicClient.request({
          method: "txpool_status" as never,
        })) as { pending: Hex };
        if (BigInt(status.pending) > 0n) break;
        await delay(50);
      }
      await s.anvil.setNextTimestamp(BigInt(first[2]!) + 5n);
      await s.anvil.mine(1);
      s.blocks.held = false;

      await agent.until(
        "the requote",
        () => agent.seen(/^quote 0x/).length === 2,
      );
      assert.equal(
        agent.seen(/asking for a new one under a new key/).length,
        1,
      );
      await agent.until(
        "the indexed position",
        () => agent.seen(/^position:/).length === 1,
      );
      await s.settle();

      const result = await agent.run;
      assert.equal(result.marketId, "1");
      assert.equal(result.finalOutcome, "YES");
      assert.equal(result.payoutMicros, "10000000");
      assert.match(result.fillTxHash, /^0x[0-9a-f]{64}$/);
      assert.match(result.redeemTxHash, /^0x[0-9a-f]{64}$/);

      // The first quote was never sent; the second was approved exactly, filled once and redeemed.
      const quotes = await s.quotes();
      assert.equal(quotes.length, 2);
      assert.notEqual(quotes[0]!.key, quotes[1]!.key);
      assert.equal(quotes[0]!.digest, first[1]);
      assert.equal(quotes[1]!.digest, result.quoteId);
      assert.equal(
        await s.read<boolean>(s.market, blinkMarketAbi, "consumed", [first[1]]),
        false,
      );
      assert.equal(
        await s.read<boolean>(s.market, blinkMarketAbi, "consumed", [
          result.quoteId,
        ]),
        true,
      );
      assert.equal(
        await s.read<bigint>(s.token, blinkTestUsdAbi, "allowance", [
          s.taker.address,
          s.market,
        ]),
        0n,
      );
      const paid = BigInt(
        /for (\d+) micro-bUSD/.exec(agent.seen(/^quote 0x/)[1]!)![1]!,
      );
      assert.equal(
        await s.read<bigint>(s.token, blinkTestUsdAbi, "balanceOf", [
          s.taker.address,
        ]),
        1_000_000_000n - paid + 10_000_000n,
      );
    });
  },
);

/** A JSON-RPC proxy to `target` that loses the answer of one raw transaction (the Nth) after forwarding it. */
async function lossyRpc(target: string, loseSendNumber: number) {
  const sent: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const body = Buffer.concat(chunks);
      const call = JSON.parse(body.toString("utf8")) as { method: string };
      const answer = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const payload = Buffer.from(await answer.arrayBuffer());
      if (call.method === "eth_sendRawTransaction") {
        sent.push(call.method);
        if (sent.length === loseSendNumber) {
          response.writeHead(502);
          return void response.end("answer lost");
        }
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(payload);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return {
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    sent,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test(
  "Anvil: when the answer to the fill is lost the example reads consumed(digest) and never sends the fill again",
  { timeout: 240_000 },
  async () => {
    await withStack(async (s) => {
      // The approval is the agent's first transaction; the fill is its second and loses its answer.
      const rpc = await lossyRpc(s.anvil.url, 2);
      try {
        const agent = startAgent(s, { rpcUrl: rpc.url });
        await agent.until(
          "the lost answer",
          () => agent.seen(/fill outcome unknown/).length === 1,
        );
        await agent.until(
          "the indexed position",
          () => agent.seen(/^position:/).length === 1,
        );
        await s.settle();

        const result = await agent.run;
        // The fill landed once, and this process never learned its hash.
        assert.equal(result.fillTxHash, "");
        assert.equal(result.finalOutcome, "YES");
        assert.equal(result.payoutMicros, "10000000");
        // approve, fill, redeem: no second fill was ever sent.
        assert.equal(rpc.sent.length, 3);
        assert.equal(
          await s.read<boolean>(s.market, blinkMarketAbi, "consumed", [
            result.quoteId,
          ]),
          true,
        );
        assert.equal(agent.seen(/^quote 0x/).length, 1);
      } finally {
        await rpc.close();
      }
    });
  },
);
