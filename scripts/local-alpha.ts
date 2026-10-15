import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import {
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as adapters from "../packages/adapters/src/index.js";
import * as application from "../packages/application/src/index.js";
import { deployContracts } from "../packages/adapters/src/contract-deployer.js";
import {
  blinkMarketAbi,
  blinkTestUsdAbi,
} from "../packages/adapters/src/blink-abi.js";
import { parseQuoteMessage } from "../packages/domain/src/signing-policy.js";
import {
  FORECAST_PROMPTS,
  signingLimits,
  type PlatformRole,
  type JobType,
} from "../packages/domain/src/index.js";
import { createBlinkClient } from "../packages/client/src/index.js";
import {
  type ApiScope,
  SignedQuoteResponse,
} from "../packages/schemas/src/index.js";
import { buildApi } from "../apps/api/src/server.js";
import { tradingServices } from "../apps/api/src/trading.js";
import { buildSignerServer } from "../apps/signer/src/server.js";
import { startAnvil, type Anvil } from "../tests/helpers/anvil.js";

const exec = promisify(execFile);
const DEPLOYMENT = "local-alpha";
const TOKEN = "local-alpha-public-fixture-token";
const hash = (text: string) => keccak256(new TextEncoder().encode(text));
const job = (payload: Record<string, unknown> = {}) => ({
  job: { id: randomUUID(), payload, attempt: 1, maxAttempts: 3 } as never,
  signal: new AbortController().signal,
});
export interface AlphaReport {
  scenarios: {
    scenario: string;
    outcome: string;
    takerPayoutMicros: string;
    makerPayoutMicros: string;
  }[];
  rebuildVerified: boolean;
  reindexIdentical: boolean;
  liveRows: number;
  wallTimeMs: number;
}

// Deliberate seam: the controller replaces this implementation with Task 15's example agent.
async function runExternalAgent(ctx: {
  api: ReturnType<typeof buildApi>;
  url: string;
  apiKey: string;
  anvil: Anvil;
  market: Address;
  token: Address;
  marketId: string;
  bindWallet: boolean;
  manifest: Awaited<ReturnType<typeof deployContracts>>;
  mint(claimId: string, intentId: string): Promise<void>;
  sync(): Promise<void>;
  track(): Promise<void>;
}) {
  const { anvil, api, marketId, market, token } = ctx;
  const client = createBlinkClient(ctx.url, ctx.apiKey);
  if (ctx.bindWallet) {
    const challenge = await client.createWalletChallenge(
      { address: anvil.accounts.taker.address },
      randomUUID(),
    );
    await client.verifyWallet(
      {
        challengeId: challenge.challengeId,
        signature: await anvil.accounts.taker.signMessage({
          message: challenge.message,
        }),
      },
      randomUUID(),
    );
  }
  const post = async (path: string, body: unknown, expected = 200) => {
    const result = await api.inject({
      method: "POST",
      url: path,
      headers: {
        authorization: "Bearer " + ctx.apiKey,
        "idempotency-key": randomUUID(),
      },
      payload: body as object,
    });
    assert.equal(result.statusCode, expected, result.body);
    return result.json();
  };
  const claim = await post(
    "/v1/faucet/claims",
    { deploymentId: DEPLOYMENT },
    202,
  );
  await ctx.mint(claim.claimId, claim.intentId);
  await ctx.sync();
  const quote = SignedQuoteResponse.parse(
    await client.requestQuote(
      {
        deploymentId: DEPLOYMENT,
        marketId,
        side: "YES",
        quantity: "10",
        maxCostMicros: "10000000",
      },
      randomUUID(),
    ),
  );
  const message = parseQuoteMessage(quote.message)!;
  assert.equal(
    (
      await recoverTypedDataAddress({
        ...application.quoteTypedData(ctx.manifest, message),
        signature: quote.signature as Hex,
      })
    ).toLowerCase(),
    anvil.accounts.maker.address.toLowerCase(),
  );
  assert.equal(
    await anvil.publicClient.readContract({
      address: market,
      abi: blinkMarketAbi,
      functionName: "hashQuote",
      args: [{ ...message, priceBps: Number(message.priceBps) }],
    } as never),
    quote.quoteId,
  );
  assert.equal(
    BigInt(quote.takerCostMicros) + BigInt(quote.makerCostMicros),
    10_000_000n,
  );
  const approveHash = await anvil.wallet(anvil.accounts.taker).writeContract({
    address: token,
    abi: blinkTestUsdAbi,
    functionName: "approve",
    args: [market, BigInt(quote.takerCostMicros)],
  } as never);
  assert.equal(
    (await anvil.publicClient.waitForTransactionReceipt({ hash: approveHash }))
      .status,
    "success",
  );
  const fillHash = await anvil
    .wallet(anvil.accounts.taker)
    .sendTransaction({ to: market, data: quote.calldata as Hex });
  assert.equal(
    (await anvil.publicClient.waitForTransactionReceipt({ hash: fillHash }))
      .status,
    "success",
  );
  await post(
    "/v1/transactions",
    {
      deploymentId: DEPLOYMENT,
      action: "FILL",
      txHash: fillHash,
      quoteId: quote.quoteId,
    },
    202,
  );
  await ctx.track();
  const status = await api.inject({
    url: "/v1/transactions/" + fillHash + "?deploymentId=" + DEPLOYMENT,
    headers: { authorization: "Bearer " + ctx.apiKey },
  });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().status, "INCLUDED");
  await ctx.sync();
}

export async function runLocalAlpha(): Promise<AlphaReport> {
  if (!process.env.TEST_POSTGRES_ADMIN_URL)
    throw new Error("TEST_POSTGRES_ADMIN_URL_REQUIRED");
  const adminUrl = new URL(process.env.TEST_POSTGRES_ADMIN_URL);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(adminUrl.hostname))
    throw new Error("LOCAL_POSTGRES_REQUIRED");
  const started = performance.now();
  const report: AlphaReport = {
    scenarios: [],
    rebuildVerified: false,
    reindexIdentical: false,
    liveRows: 0,
    wallTimeMs: 0,
  };
  // Imported after the guard: absent configuration must fail before starting Anvil or touching a DB.
  const { withDatabase } =
    await import("../tests/helpers/postgres-database.js");
  await withDatabase(async ({ owner, login }) => {
    const directory = await mkdtemp(join(tmpdir(), "blink-local-alpha-"));
    const anvil = await startAnvil({ baseFee: 1n });
    const close: (() => Promise<unknown>)[] = [];
    try {
      const pools = {
        api: await login({ memberOf: ["blink_api"], max: 1 }),
        indexer: await login({ memberOf: ["blink_indexer"], max: 1 }),
        worker: await login({ memberOf: ["blink_worker"], max: 1 }),
        signer: await login({ memberOf: ["blink_signer"], max: 1 }),
        identity: await login({ memberOf: ["blink_identity_admin"], max: 1 }),
        evidence: await login({ memberOf: ["blink_evidence_admin"], max: 1 }),
        deployment: await login({
          memberOf: ["blink_deployment_admin"],
          max: 1,
        }),
      };
      const clockPools = [owner, ...Object.values(pools)];
      const setClock = async () => {
        const timestamp = (await anvil.publicClient.getBlock()).timestamp;
        const offset = timestamp - BigInt(Math.floor(Date.now() / 1000));
        for (const pool of clockPools) {
          const role = (await pool.query("SELECT current_user AS name")).rows[0]
            .name as string;
          assert.match(role, /^[a-zA-Z0-9_]+$/);
          await owner.query(
            `ALTER ROLE "${role}" IN DATABASE "${(await owner.query("SELECT current_database() AS name")).rows[0].name}" SET blink.test_clock_offset_seconds = '${offset}'`,
          );
          await pool.query(
            "SELECT set_config('blink.test_clock_offset_seconds',$1,false)",
            [String(offset)],
          );
          await adapters.assertProductionClock(pool, true);
        }
      };
      const jump = async (timestamp: bigint) => {
        await anvil.setNextTimestamp(timestamp);
        await anvil.mine();
        await setClock();
      };
      const {
        admin,
        maker,
        proposer,
        challenger,
        arbiter,
        minter,
        taker,
        keeper,
        trader: deployer,
      } = anvil.accounts;
      const manifest = await deployContracts({
        client: anvil.publicClient,
        wallet: anvil.wallet(deployer),
        roles: {
          admin: admin.address,
          maker: maker.address,
          resultProposer: proposer.address,
          challenger: challenger.address,
          arbiter: arbiter.address,
          faucetMinter: minter.address,
        },
        deploymentId: DEPLOYMENT,
        artifactsDir: new URL("../contracts/artifacts/", import.meta.url),
        gitCommit: "0".repeat(40),
        dependencies: {
          "@openzeppelin/contracts": "5.6.1",
          solc: "0.8.30",
          viem: "2.56.8",
        },
      });
      const abis = {
        BlinkMarket: JSON.parse(
          await readFile("contracts/artifacts/BlinkMarket.json", "utf8"),
        ).abi as Abi,
        BlinkTestUSD: JSON.parse(
          await readFile("contracts/artifacts/BlinkTestUSD.json", "utf8"),
        ).abi as Abi,
      };
      await adapters.registerVerifiedDeployment(
        pools.deployment,
        manifest,
        DEPLOYMENT,
        anvil.publicClient,
        abis,
        "Isolated Anvil Alpha",
      );
      const market = manifest.contracts.BlinkMarket as Address,
        token = manifest.contracts.BlinkTestUSD as Address;
      const send = async (
        account: typeof admin,
        address: Address,
        abi: Abi,
        functionName: string,
        args: readonly unknown[],
      ) => {
        const receipt = await anvil.publicClient.waitForTransactionReceipt({
          hash: await anvil
            .wallet(account)
            .writeContract({ address, abi, functionName, args } as never),
        });
        assert.equal(receipt.status, "success", functionName);
        return receipt;
      };
      const read = (functionName: string, args: readonly unknown[] = []) =>
        anvil.publicClient.readContract({
          address: market,
          abi: blinkMarketAbi,
          functionName,
          args,
        } as never) as Promise<any>;
      await send(minter, token, blinkTestUsdAbi, "mint", [
        maker.address,
        1_000_000_000n,
      ]);
      await send(maker, token, blinkTestUsdAbi, "approve", [
        market,
        1_000_000_000n,
      ]);
      await send(maker, market, blinkMarketAbi, "depositMaker", [
        1_000_000_000n,
      ]);
      await setClock();
      await adapters.assertIdentityRuntimeRole(pools.api);
      await adapters.assertWorkerRuntimeRole(pools.worker);
      await adapters.assertCreationTrackingRuntimeRole(pools.indexer);
      await adapters.assertSignerRuntimeRole(pools.signer);
      const keys = {} as Partial<
        Record<
          "maker" | "keeper" | "faucet",
          ReturnType<typeof privateKeyToAccount>
        >
      >;
      for (const [role, account] of [
        ["maker", maker],
        ["keeper", keeper],
        ["faucet", minter],
      ] as const) {
        const path = join(directory, role + ".key");
        await writeFile(
          path,
          account.getHdKey().privateKey
            ? "0x" + Buffer.from(account.getHdKey().privateKey!).toString("hex")
            : "",
          { mode: 0o600 },
        );
        keys[role] = privateKeyToAccount(await adapters.readKeyFile(path));
      }
      const signerService = application.createSignerService({
        store: adapters.postgresSignerStore(pools.signer),
        keys,
        rpc: adapters.viemSignerRpc({ url: anvil.url }),
        deployment: manifest,
        callers: [
          {
            name: "local-alpha",
            tokenSha256: createHash("sha256").update(TOKEN).digest("hex"),
            roles: ["maker", "keeper", "faucet"],
          },
        ],
        policy: {
          l1FeeMode: "local-none",
          perTxCapWei: signingLimits.perTxCapWei,
          dailyCapWei: signingLimits.dailyCapWei,
        },
        encodeCall: adapters.encodeAllowedCall,
        quoteCheck: application.createReservationQuoteCheck(
          adapters.postgresReservationReader(),
        ),
      });
      const signerServer = buildSignerServer(signerService);
      signerServer.log.level = "silent";
      close.push(() => signerServer.close());
      await signerServer.listen({ port: 0, host: "127.0.0.1" });
      const signerUrl =
        "http://127.0.0.1:" +
        (signerServer.server.address() as AddressInfo).port;
      const signer = adapters.signerClient({ url: signerUrl, token: TOKEN });
      const objects = adapters.fileObjectStore(directory);
      const archive = adapters.createSpecArchive(objects);
      const identityStore = adapters.postgresIdentityStore(pools.api);
      const trading = await tradingServices(pools.api, {
        deploymentId: DEPLOYMENT,
        signerUrl,
        signerToken: TOKEN,
        rpcUrl: anvil.url,
      });
      const app = buildApi({
        stage: "m2-trading",
        config: trading.readiness.config,
        identity: application.createIdentityService(
          identityStore,
          adapters.identityCrypto,
          "http://127.0.0.1",
        ),
        preparation: application.createPreparationService(
          adapters.postgresPreparationStore(pools.api),
          adapters.identityCrypto,
        ),
        approval: application.createApprovalService({
          store: adapters.postgresApprovalStore(pools.api),
          crypto: adapters.identityCrypto,
          archive,
          publicOrigin: "http://127.0.0.1",
          verifyEvidence: adapters.evidenceIntegrity(objects),
          encodeCreation: adapters.encodeMarketCreation,
        }),
        services: [
          trading.rfq,
          application.createFaucetService({
            store: adapters.postgresFaucetStore(pools.api),
            crypto: adapters.identityCrypto,
            deploymentId: DEPLOYMENT,
          }),
          application.createForecastService({
            store: adapters.postgresForecastStore(pools.api),
            crypto: adapters.identityCrypto,
          }),
          application.createMetricsService({
            store: adapters.postgresEvaluationStore(pools.api),
            budgets: adapters.postgresBudgetLedger(pools.api),
          }),
          application.createMarketReadService({
            store: adapters.postgresMarketReadStore(pools.api),
            archive,
            hooks: { canTrade: trading.readiness.canTrade },
            identity: {
              authenticate: (authorization) =>
                identityStore.run(async (tx) => {
                  const p = await application.authenticateIdentity(
                    tx,
                    adapters.identityCrypto,
                    authorization,
                  );
                  return { ...p, wallet: await tx.wallet(p.agentId) };
                }),
            },
          }),
        ],
      });
      app.log.level = "silent";
      close.push(() => app.close());
      await app.listen({ port: 0, host: "127.0.0.1" });
      const url =
        "http://127.0.0.1:" + (app.server.address() as AddressInfo).port;
      const invite = (name: string, scopes: ApiScope[]) =>
        adapters.identityAdmin(pools.identity).invite({
          operatorName: name,
          agentName: name,
          scopes,
          reason: "local Alpha fixture",
        });
      const discovery = await invite("discovery", ["candidate:write"]),
        administrator = await invite("admin", ["admin"]);
      const agents = {} as Record<
        PlatformRole,
        Awaited<ReturnType<typeof invite>>
      >;
      for (const role of [
        "FORECASTER_A",
        "FORECASTER_B",
        "BASELINE",
      ] as const) {
        agents[role] = await invite(role, ["forecast:write"]);
        await owner.query(
          "INSERT INTO forecasts.platform_agents(agent_id,role,model,prompt_hash,policy_version) VALUES($1,$2,'fixture',decode($3,'hex'),'v1')",
          [agents[role].agentId, role, hash(FORECAST_PROMPTS[role]).slice(2)],
        );
      }
      const chainStore = adapters.postgresChainIndexStore(pools.indexer);
      const makeIndexer = () =>
        application.createChainIndexer({
          store: chainStore,
          reader: adapters.chainLogReader(anvil.publicClient),
          deploymentId: DEPLOYMENT,
          marketAddress: market.toLowerCase(),
          deploymentBlock: BigInt(manifest.deploymentBlock),
          workerId: "local-alpha",
          rangeSize: 100,
        });
      let indexer = makeIndexer();
      const sync = async () => {
        for (let n = 0; n < 100; n++) {
          const r = await indexer.syncOnce();
          if (r.advancedTo === null && r.reorgedTo === null) return;
        }
        throw new Error("ALPHA_INDEXER_DID_NOT_CONVERGE");
      };
      const tracker = application.createTxTracker({
        store: adapters.postgresTxTrackingStore(pools.indexer),
        reader: adapters.txReceiptReader(anvil.publicClient),
        manifest: (id) => adapters.txTrackingManifest(pools.indexer, id),
      });
      const executionReader = adapters.executionChainReader({
        url: anvil.url,
        marketAddress: market,
      });
      const dispatchStore = adapters.postgresDispatchStore(pools.worker);
      const dispatcher = application.createExecutionDispatcher({
        dispatcher: application.createTxDispatcher({
          store: dispatchStore,
          rpc: executionReader.guardDispatch(
            adapters.viemDispatchRpc({ url: anvil.url }),
          ),
          signer,
        }),
        store: dispatchStore,
        faucet: adapters.postgresFaucetStore(pools.worker),
        reader: executionReader,
      });
      const dispatchIncluded = async (intentId: string) => {
        for (let n = 0; n < 10; n++) {
          const state = await dispatcher.dispatch(intentId);
          if (state === "INCLUDED") return;
          assert.notEqual(state, "REVERTED");
        }
        throw new Error("ALPHA_TX_NOT_INCLUDED");
      };
      const mint = application.createFaucetMintHandler({
        store: adapters.postgresFaucetStore(pools.worker),
        signer,
      });
      const finalize = application.createKeeperHandler({
        store: adapters.postgresKeeperStore(pools.worker),
        deploymentId: DEPLOYMENT,
        reader: executionReader,
        signer,
      });
      const reconcile = application.createQuoteReconciler(
        adapters.postgresTradingStore(pools.worker),
      );
      const forecastStore = adapters.postgresForecastStore(pools.worker);
      const scheduler = application.createWindowScheduler(forecastStore);
      const model = application.createBudgetedModelCaller({
        ledger: adapters.postgresBudgetLedger(pools.worker),
        gateway: adapters.fixtureModelGateway({
          rates: {
            fixture: {
              inputUsdMicrosPerMillionTokens: 3_000_000n,
              outputUsdMicrosPerMillionTokens: 15_000_000n,
              perRequestUsdMicros: 1000n,
            },
          },
          respond: () =>
            JSON.stringify({
              probability: 0.6,
              rationale: "Deterministic Alpha fixture",
              evidenceIds: [currentEvidence],
            }),
        }),
      });
      let currentEvidence = "";
      const forecaster = application.createForecastRunHandler({
        roles: ["FORECASTER_A", "FORECASTER_B", "BASELINE"],
        store: adapters.postgresPlatformRunStore(pools.worker),
        objects,
        model,
        apis: Object.fromEntries(
          Object.entries(agents).map(([role, agent]) => [
            role,
            createBlinkClient(url, agent.apiKey),
          ]),
        ),
        hash: keccak256,
        newId: randomUUID,
      });
      const queue = adapters.postgresJobQueue(pools.worker);
      const workerErrors: string[] = [];
      const worker = application.startWorker({
        queue,
        workerId: "local-alpha",
        pollIntervalMs: 10,
        handlers: {
          "forecast.run": forecaster,
          "baseline.run": forecaster,
          "evaluation.score": application.createEvaluationHandler(
            adapters.postgresEvaluationStore(pools.worker),
          ),
        },
        onError: (code) => workerErrors.push(code),
      });
      close.push(() => worker.stop());
      const runJob = async (
        type: JobType,
        payload: Record<string, unknown> = {},
      ) => {
        const { jobId } = await queue.enqueue({
          type,
          payload,
          dedupeKey: randomUUID(),
          maxAttempts: 1,
        });
        for (let n = 0; n < 500; n++) {
          const row = (
            await owner.query(
              "SELECT state,last_error_code FROM operations.jobs WHERE id=$1",
              [jobId],
            )
          ).rows[0];
          assert.notEqual(row.state, "DEAD", JSON.stringify(row));
          if (row.state === "SUCCEEDED") {
            assert.deepEqual(workerErrors, []);
            return;
          }
          await delay(10);
        }
        throw new Error("ALPHA_WORKER_TIMEOUT");
      };
      const discoveryClient = createBlinkClient(url, discovery.apiKey),
        adminClient = createBlinkClient(url, administrator.apiKey);
      const externalAgent = await invite("external", [
        "trade:quote",
        "faucet:claim",
      ]);
      for (const [i, scenario] of ["normal", "dispute", "timeout"].entries()) {
        console.log("ALPHA scenario " + scenario);
        const now = (await anvil.publicClient.getBlock()).timestamp;
        const closeAt = now + 7200n,
          proposalDeadline = closeAt + 1000n,
          hardDeadline = closeAt + 4000n;
        const entityId = "alpha-" + scenario;
        const sourceUrl = "https://fixture.example.test/" + scenario;
        const source = await adapters
          .evidenceAdmin(pools.evidence, objects)
          .allowSource(entityId, sourceUrl, "Offline fixture");
        const metadataPath = join(directory, scenario + ".json"),
          evidencePath = join(directory, scenario + ".txt");
        await writeFile(
          metadataPath,
          JSON.stringify({
            sourceId: source.sourceId,
            operatorId: discovery.operatorId,
            publishedAt: null,
            accessPolicy: "PUBLIC",
            excerpt: null,
            reason: "Offline REPLAY fixture",
          }),
        );
        await writeFile(
          evidencePath,
          "Fixture gross margin is 60 percent. No real company or fetch.",
        );
        const imported = await exec(
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/evidence-admin.ts",
            "import",
            "--metadata",
            metadataPath,
            "--file",
            evidencePath,
          ],
          {
            env: {
              ...process.env,
              EVIDENCE_ADMIN_DATABASE_URL:
                pools.evidence.options.connectionString!,
              EVIDENCE_OBJECT_DIRECTORY: directory,
              BLINK_ALLOW_TEST_CLOCK: "1",
            },
          },
        );
        currentEvidence = JSON.parse(imported.stdout).evidenceId;
        const candidate = (await discoveryClient.createCandidate(
          {
            templateId: "GM_LT_V1",
            entityId,
            fiscalPeriod: "FY2025Q1",
            thresholdBps: 7000,
            evidenceIds: [currentEvidence],
            thesis: "Local REPLAY " + scenario,
          },
          randomUUID(),
        )) as { candidateId: string };
        manifest.tradingEnabled = false;
        await owner.query(
          "UPDATE markets.deployments SET manifest=$2 WHERE id=$1",
          [DEPLOYMENT, manifest],
        );
        // A previous scenario advanced time; approval requires a fresh deployment verification.
        await adapters.registerVerifiedDeployment(
          pools.deployment,
          manifest,
          DEPLOYMENT,
          anvil.publicClient,
          abis,
          "Refresh local verification",
        );
        const spec = {
          ...JSON.parse(
            await readFile("fixtures/replay/market-spec.json", "utf8"),
          ),
          schemaVersion: "blink.market.v0.1.1",
          entityId,
          sourceEvidenceIds: [currentEvidence],
          sourceAllowlist: [sourceUrl],
          closeAt: String(closeAt),
          proposalDeadline: String(proposalDeadline),
          hardDeadline: String(hardDeadline),
          resolutionPolicy: {
            hardDeadlineOutcome: "INVALID",
            unfinalizedProposalAtHardDeadline: "INVALID",
            invalidPayoutRule: "HALF_PER_SIDE_NOT_PURCHASE_REFUND",
            authorityModel: "TEAM_OPERATED_WHITELISTED_ROLES",
          },
        };
        const approval = (await adminClient.approveCandidate(
          candidate.candidateId,
          {
            deploymentId: DEPLOYMENT,
            expectedRevision: 1,
            budgetMicros: "2000000",
            reason: "Reviewed offline fixture",
            spec,
          },
          randomUUID(),
        )) as { creationIntentId: string };
        const intent = (await adminClient.getCreationIntent(
          approval.creationIntentId,
        )) as { to: Address; calldata: Hex };
        const created = await anvil.publicClient.waitForTransactionReceipt({
          hash: await anvil
            .wallet(admin)
            .sendTransaction({ to: intent.to, data: intent.calldata }),
        });
        assert.equal(created.status, "success");
        const creation = await application
          .createCreationTracker(
            adapters.postgresCreationTrackerStore(pools.indexer),
            adapters.creationReceiptReader(anvil.publicClient),
          )
          .reconcile(approval.creationIntentId, created.transactionHash);
        assert.equal(creation.state, "INCLUDED");
        await sync();
        const marketId = String(i + 1);
        await scheduler.scheduleOnce();
        const window = (
          await owner.query(
            "SELECT id,open_at,deadline FROM forecasts.windows WHERE market_id=$1 ORDER BY deadline DESC LIMIT 1",
            [marketId],
          )
        ).rows[0];
        assert.ok(window, "scheduler created a window");
        await jump(
          BigInt(Math.floor(new Date(window.open_at).getTime() / 1000)) + 1n,
        );
        for (const role of [
          "FORECASTER_A",
          "FORECASTER_B",
          "BASELINE",
        ] as const)
          await runJob(role === "BASELINE" ? "baseline.run" : "forecast.run", {
            windowId: window.id,
            role,
          });
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int AS n FROM forecasts.submissions WHERE window_id=$1",
              [window.id],
            )
          ).rows[0].n,
          3,
        );
        await jump(
          BigInt(Math.floor(new Date(window.deadline).getTime() / 1000)) + 1n,
        );
        await sync();
        assert.ok(
          await application
            .createSnapshotReader(adapters.postgresForecastStore(pools.api))
            .latest(DEPLOYMENT, marketId),
        );
        await send(admin, market, blinkMarketAbi, "setTakerAllowed", [
          taker.address,
          true,
        ]);
        await sync();
        // The same verified wallet claims again only after the 24h advance below.

        manifest.tradingEnabled = true;
        await owner.query(
          "UPDATE markets.deployments SET manifest=$2 WHERE id=$1",
          [DEPLOYMENT, manifest],
        );
        await runExternalAgent({
          api: app,
          url,
          apiKey: externalAgent.apiKey,
          bindWallet: i === 0,
          anvil,
          market,
          token,
          marketId,
          manifest,
          mint: async (claimId, intentId) => {
            await mint(job({ claimId }));
            await dispatchIncluded(intentId);
          },
          sync,
          track: async () => {
            await tracker.trackOnce(50);
          },
        });
        await reconcile.reconcileOnce(DEPLOYMENT);
        const position = (
          await owner.query(
            "SELECT yes_shares::text,no_shares::text FROM chain.positions WHERE market_id=$1 AND account=decode($2,'hex')",
            [marketId, taker.address.slice(2)],
          )
        ).rows[0];
        const chainPosition = await read("getPosition", [
          BigInt(marketId),
          taker.address,
        ]);
        assert.deepEqual(position, {
          yes_shares: String(chainPosition[0]),
          no_shares: String(chainPosition[1]),
        });
        assert.equal(chainPosition[0], 10n);
        await jump(scenario === "timeout" ? hardDeadline : closeAt + 1n);
        if (scenario !== "timeout") {
          await send(proposer, market, blinkMarketAbi, "proposeOutcome", [
            BigInt(marketId),
            0,
            hash("proposal " + scenario),
          ]);
          if (scenario === "dispute") {
            await send(challenger, market, blinkMarketAbi, "challengeOutcome", [
              BigInt(marketId),
              hash("challenge"),
            ]);
            await send(arbiter, market, blinkMarketAbi, "arbitrate", [
              BigInt(marketId),
              1,
              hash("decision"),
            ]);
          } else {
            const m = await read("getMarket", [BigInt(marketId)]);
            await jump(m.proposedAt + BigInt(m.challengeSeconds));
          }
        }
        await sync();
        if (scenario !== "dispute") {
          await finalize(job());
          const rows = await owner.query(
            "SELECT id FROM signing.economic_intents WHERE kind IN ('FINALIZE_UNCHALLENGED','FINALIZE_TIMEOUT') AND payload->>'marketId'=$1",
            [marketId],
          );
          assert.equal(rows.rowCount, 1);
          await dispatchIncluded(rows.rows[0].id);
          await sync();
        }
        const balance = (account: Address) =>
          anvil.publicClient.readContract({
            address: token,
            abi: blinkTestUsdAbi,
            functionName: "balanceOf",
            args: [account],
          }) as Promise<bigint>;
        const beforeT = await balance(taker.address),
          beforeM = await balance(maker.address);
        await send(taker, market, blinkMarketAbi, "redeem", [BigInt(marketId)]);
        await send(maker, market, blinkMarketAbi, "redeem", [BigInt(marketId)]);
        const paidT = (await balance(taker.address)) - beforeT,
          paidM = (await balance(maker.address)) - beforeM;
        const expected =
          scenario === "normal"
            ? 10_000_000n
            : scenario === "dispute"
              ? 0n
              : 5_000_000n;
        assert.equal(paidT, expected);
        assert.equal(paidM, 10_000_000n - expected);
        await sync();
        await reconcile.reconcileOnce(DEPLOYMENT);
        const settled = await read("getMarket", [BigInt(marketId)]);
        assert.equal(settled.escrowMicros, 0n);
        const projected = (
          await owner.query(
            "SELECT state,final_outcome,escrow_micros::text FROM chain.markets WHERE market_id=$1",
            [marketId],
          )
        ).rows[0];
        const outcome = ["YES", "NO", "INVALID"][settled.finalOutcome]!;
        assert.deepEqual(projected, {
          state: "FINAL",
          final_outcome: outcome,
          escrow_micros: "0",
        });
        for (const account of [taker, maker]) {
          const p = await read("getPosition", [
            BigInt(marketId),
            account.address,
          ]);
          assert.equal(p[0] + p[1], 0n);
          const row = (
            await owner.query(
              "SELECT yes_shares::text,no_shares::text FROM chain.positions WHERE market_id=$1 AND account=decode($2,'hex')",
              [marketId, account.address.slice(2)],
            )
          ).rows[0];
          assert.deepEqual(row, { yes_shares: "0", no_shares: "0" });
        }
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int AS n FROM trading.collateral_reservations WHERE state IN ('HELD','RECONCILE_REQUIRED')",
            )
          ).rows[0].n,
          0,
        );
        const projection = await chainStore.loadProjection(DEPLOYMENT);
        assert.deepEqual(projection.maker, {
          freeMicros: await read("makerFreeBalance"),
          epoch: await read("currentMakerEpoch"),
          globalPaused: await read("globalTradingPaused"),
        });
        const indexed = projection.markets.get(marketId)!;
        for (const field of [
          "closeAt",
          "proposalDeadline",
          "hardDeadline",
          "challengeSeconds",
          "maxPairs",
          "maxTakerShares",
          "paused",
          "escrowMicros",
        ] as const)
          assert.equal(indexed[field], settled[field], field);
        assert.equal(indexed.specHash, settled.specHash.toLowerCase());
        assert.equal(indexed.specUri, settled.specURI);
        assert.equal(indexed.totalPairs, settled.totalMintedPairs);
        assert.equal(indexed.mode, "REPLAY");
        assert.equal(
          indexed.finalReason,
          scenario === "normal"
            ? "UNCHALLENGED"
            : scenario === "dispute"
              ? "ARBITRATED"
              : "TIMEOUT",
        );
        for (const [account, allowed] of projection.takers)
          assert.equal(allowed, await read("takerAllowed", [account]));
        for (const digest of projection.digests.values())
          assert.equal(await read("consumed", [digest.digest]), true);
        await runJob("evaluation.score");
        const metrics = await app.inject("/v1/metrics?mode=REPLAY");
        assert.equal(metrics.statusCode, 200, metrics.body);
        assert.equal(
          metrics.json().eventCount,
          String(i + 1 - (scenario === "timeout" ? 1 : 0)),
        );
        assert.equal(
          metrics.json().invalidCount,
          scenario === "timeout" ? "1" : "0",
        );
        report.scenarios.push({
          scenario,
          outcome,
          takerPayoutMicros: String(paidT),
          makerPayoutMicros: String(paidM),
        });
        console.log(
          "PASS ALPHA " +
            scenario +
            " " +
            outcome +
            " payouts=" +
            paidT +
            "/" +
            paidM,
        );
        if (i < 2)
          await jump((await anvil.publicClient.getBlock()).timestamp + 86401n);
      }
      report.liveRows = (
        await owner.query(
          "SELECT count(*)::int AS n FROM chain.markets WHERE mode='LIVE'",
        )
      ).rows[0].n;
      assert.equal(report.liveRows, 0);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM analytics.score_entries WHERE mode='LIVE'",
          )
        ).rows[0].n,
        0,
      );
      const live = await app.inject("/v1/metrics?mode=LIVE");
      assert.equal(live.json().eventCount, "0");
      const snapshot = async () =>
        (await chainStore.loadSnapshot(DEPLOYMENT)).projection;
      const before = await snapshot();
      const rebuilt = await exec(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/rebuild-chain-index.ts",
          DEPLOYMENT,
          "--verify",
        ],
        {
          timeout: 60_000,
          env: {
            ...process.env,
            INDEXER_DATABASE_URL: pools.indexer.options.connectionString!,
            BLINK_ALLOW_TEST_CLOCK: "1",
          },
        },
      );
      assert.deepEqual(JSON.parse(rebuilt.stdout).differences, []);
      assert.deepEqual(await snapshot(), before);
      report.rebuildVerified = true;
      await worker.stop();
      const notificationsBefore = (
        await owner.query(
          "SELECT max(event_version)::text AS version,count(*)::int AS count FROM operations.outbox WHERE aggregate_id=$1 AND event_type IN ('chain.synced','chain.reorged')",
          [DEPLOYMENT],
        )
      ).rows[0];
      // Lose the index tables, then recreate their exact checked-in DDL and grants.
      // The evaluation view is the only dependent object; retain every application record.
      await owner.query("DROP VIEW analytics.final_forecasts");
      await owner.query(
        "DROP TABLE chain.markets,chain.positions,chain.quote_digests,chain.takers,chain.maker_state,chain.events,chain.blocks,chain.cursors",
      );
      const chainMigration = await readFile(
        "packages/adapters/migrations/0007_chain_index.sql",
        "utf8",
      );
      await owner.query(
        chainMigration.slice(
          chainMigration.indexOf("CREATE TABLE chain.cursors"),
        ),
      );
      const evaluationMigration = await readFile(
        "packages/adapters/migrations/0015_evaluation.sql",
        "utf8",
      );
      await owner.query(
        evaluationMigration.slice(
          evaluationMigration.indexOf("CREATE VIEW analytics.final_forecasts"),
          evaluationMigration.indexOf("REVOKE ALL"),
        ),
      );
      await owner.query(
        "GRANT SELECT ON analytics.final_forecasts TO blink_worker",
      );
      indexer = makeIndexer();
      await sync();
      assert.deepEqual(await snapshot(), before);
      const notificationsAfter = (
        await owner.query(
          "SELECT max(event_version)::text AS version,count(*)::int AS count FROM operations.outbox WHERE aggregate_id=$1 AND event_type IN ('chain.synced','chain.reorged')",
          [DEPLOYMENT],
        )
      ).rows[0];
      assert.ok(
        BigInt(notificationsAfter.version) >
          BigInt(notificationsBefore.version),
      );
      assert.ok(notificationsAfter.count > notificationsBefore.count);
      report.reindexIdentical = true;
    } finally {
      try {
        for (const stop of close.reverse()) await stop();
      } finally {
        await anvil.stop();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  report.wallTimeMs = Math.round(performance.now() - started);
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(JSON.stringify(await runLocalAlpha(), null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
