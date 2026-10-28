import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { type PublicClient } from "viem";
import { buildApi } from "../../apps/api/src/server.ts";
import {
  buildResearch,
  handlers as workerHandlers,
  outboxMapping,
  registerEvaluationHandler,
  scheduleEvaluation,
} from "../../apps/worker/src/handlers.ts";
import { startJobLoops } from "../../apps/worker/src/loops.ts";
import {
  dispatchOutbox,
  fileObjectStore,
  identityCrypto,
  loadProtocolDeployment,
  migratePostgres,
  postgresContentStore,
  postgresEvaluationStore,
  postgresForecastStore,
  postgresIdentityStore,
  postgresJobQueue,
  postgresMarketReadStore,
  postgresProtocolIndexStore,
  postgresProtocolReader,
  postgresRfqStore,
  postgresSuggestionStore,
  postgresTxTrackingStore,
  protocolLogReader,
  registerProtocolDeployment,
  txReceiptReader,
  txTrackingManifest,
  verifyProtocolDeployment,
  viemSignatureVerifier,
  deployProtocol,
  planProtocolDeployment,
} from "../../packages/adapters/src/index.ts";
import {
  createChainIndexer,
  createContentService,
  createForecastService,
  createIdentityService,
  createMarketReadService,
  createMetricsService,
  createRfqService,
  createSuggestionService,
  createTxTracker,
  createTxTrackingService,
  startChainIndexer,
} from "../../packages/application/src/index.ts";
import { assertNoRoleKeys } from "../../packages/runtime/src/index.ts";
import { presets, type ProtocolDeployment } from "../../packages/schemas/src/index.ts";
import { startAnvil, type Anvil } from "../../tests/helpers/anvil.ts";
import { createTestDatabase } from "../../tests/helpers/database.ts";

/**
 * The platform of the local alpha (P2 spec 2.1.3, P3 spec 2.1.2): what the platform consists of and
 * nothing else. Anvil (chain 84532), the alpha protocol generation registered in a database, and the
 * API, the indexer and the worker, none of them holding any key: `assertNoRoleKeys` is applied to the
 * environment of each one, whichever backend runs it. The agents that exercise the protocol are the
 * caller's: they hold Anvil's public test keys in their own processes and reach the platform only
 * through the public API, `@blink/client` and the contracts.
 *
 * Two backends. "postgres" is the real thing: a fresh PostgreSQL database with one ordinary login per
 * role, and the three services as separate processes with an explicit environment (never the
 * caller's). "pglite" runs the same services in this process over an in-memory PGlite database that
 * has every migration, as the Anvil suites do; it needs neither PostgreSQL nor a build, and it is the
 * backend the Anvil tests of the reference agents use.
 *
 * Time. The platform business clock is the database clock and the chain clock is Anvil's, and both
 * follow the wall clock: the alpha protocol periods (60 s windows) are short enough to wait out in
 * real time. A heartbeat mines one block per second so the chain head stays fresh for the indexer's
 * 30 second lag gate while Anvil would otherwise sit idle. Nothing sets the clock offset
 * (`blink.test_clock_offset_seconds`) or a chain timestamp: the offset is refused by the API and the
 * worker at startup, and shifting only one of the two clocks would make the index lag. A scenario
 * that must skip real time would have to move both by the same amount, and has no way to do that
 * against running services, so it waits with `waitForChainTime`.
 */

const repository = fileURLToPath(new URL("../..", import.meta.url));
const CHAIN_ID = 84532;
const DEPLOYMENT_ID = "local-alpha";
const HEARTBEAT_MS = 1000;
const READY_TIMEOUT_MS = 90_000;
const LOG_LINES = 120;
const INDEXER_POLL_MS = 500;
const OUTBOX_DISPATCH_MS = 1000;
const SCHEDULE_MS = 15_000;
const TX_TRACKING_MS = 2000;
// ponytail: fixed worker port, one stack at a time; switch to an ephemeral port if P3 needs concurrent stacks.
const WORKER_PORT = 3002; // fixed in apps/worker/src/main.ts

/**
 * Runs every cleanup step in order, even after one fails, then reports all failures together. A
 * cleanup that silently fails would leave a chain process, database or login behind for the next run.
 */
export async function runCleanup(steps: readonly (readonly [string, () => Promise<unknown>])[]) {
  const failures: { step: string; error: unknown }[] = [];
  for (const [step, run] of steps)
    try {
      await run();
    } catch (error) {
      failures.push({ step, error });
    }
  if (failures.length)
    throw new AggregateError(
      failures.map((failure) => failure.error),
      "LOCAL_ALPHA_CLEANUP_FAILED: " + failures.map((failure) => failure.step).join(", "),
    );
}

export type PlatformName = "api" | "indexer" | "worker";
export interface PlatformProcess {
  /** The exact environment the process was started with. */
  readonly env: Readonly<Record<string, string>>;
  readonly pid: number;
  /** The last lines the process printed (codes, never secrets), for diagnosing a failed run. */
  logs(): string[];
  exited(): boolean;
}

/**
 * The window schedule that fits a PRE_CLOSE forecast window inside an alpha market: the window is
 * open for 80 s and closes 80 s before the market does. The worker plans windows per 30 s bucket, so
 * a long window leaves the submitting actor time even when the plan lands late.
 */
export const ALPHA_FORECAST_SCHEDULE = { preCloseLeadSeconds: 80, openSeconds: 80 } as const;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve, reject) => probe.close((e) => (e ? reject(e) : resolve())));
  return port;
}

async function assertPortFree(port: number, code: string) {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
  } catch {
    throw new Error(code + ": 127.0.0.1:" + port + " is taken");
  }
  await new Promise<void>((resolve) => probe.close(() => resolve()));
}

/** Polls `read` until it returns a value; the failure names what was awaited. */
export async function waitFor<T>(
  what: string,
  read: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 60_000,
  everyMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await read();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(
        "ALPHA_TIMEOUT: " + what + (last instanceof Error ? " (last error: " + last.message + ")" : ""),
      );
    await delay(everyMs);
  }
}

function startProcess(name: PlatformName, entry: string, env: Record<string, string>) {
  assertNoRoleKeys(env);
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: repository,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const keep = (chunk: Buffer) => {
    // Fastify logs every request twice; only refusals and everything else are worth keeping.
    lines.push(
      ...String(chunk)
        .split("\n")
        .filter(
          (line) =>
            line &&
            !line.includes('"msg":"incoming request"') &&
            !/"statusCode":[23]\d\d,.*"msg":"request completed"/.test(line),
        ),
    );
    lines.splice(0, Math.max(0, lines.length - LOG_LINES));
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let done = false;
  // A harness that dies without stop() must not leave a platform process behind.
  const killOnExit = () => child.kill("SIGKILL");
  process.once("exit", killOnExit);
  child.once("exit", () => {
    done = true;
    process.off("exit", killOnExit);
  });
  const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return {
    name,
    process: {
      env: Object.freeze({ ...env }),
      pid: child.pid!,
      logs: () => [...lines],
      exited: () => done,
    } satisfies PlatformProcess,
    async stop() {
      if (done) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await stopped;
      clearTimeout(timer);
    },
    kill: () => child.kill("SIGKILL"),
  };
}

const json = async (url: string) => {
  const response = await fetch(url);
  return { status: response.status, body: await response.json().catch(() => null) };
};

/**
 * The environment of each platform service, without any key. The postgres backend starts the
 * processes with exactly these; the pglite backend runs the services in process and only checks
 * them, so both are held to the same rule.
 */
function platformEnvs(input: {
  rpcUrl: string;
  apiUrl: string;
  apiPort: number;
  indexerPort: number;
  specDirectory: string;
  schedule: typeof ALPHA_FORECAST_SCHEDULE;
  publicReadLimit?: { capacity: number; refillPerSecond: number };
  databaseUrl: (login: "api" | "indexer" | "worker") => string;
}): Record<PlatformName, Record<string, string>> {
  const common = { PATH: process.env.PATH ?? "", BASE_SEPOLIA_RPC_URL: input.rpcUrl };
  return {
    api: {
      ...common,
      BLINK_API_MODE: "markets",
      API_HOST: "127.0.0.1",
      API_PORT: String(input.apiPort),
      API_DATABASE_URL: input.databaseUrl("api"),
      WALLET_BINDING_ORIGIN: input.apiUrl,
      SPEC_OBJECT_DIRECTORY: input.specDirectory,
      SPEC_PUBLIC_ORIGIN: input.apiUrl,
      BLINK_DEPLOYMENT_ID: DEPLOYMENT_ID,
      ...(input.publicReadLimit
        ? { API_PUBLIC_READ_LIMIT: `${input.publicReadLimit.capacity},${input.publicReadLimit.refillPerSecond}` }
        : {}),
    },
    indexer: {
      ...common,
      CHAIN_INDEXER_ENABLED: "true",
      INDEXER_TX_TRACKING_ENABLED: "true",
      INDEXER_HOST: "127.0.0.1",
      INDEXER_PORT: String(input.indexerPort),
      INDEXER_DATABASE_URL: input.databaseUrl("indexer"),
      INDEXER_DEPLOYMENT_ID: DEPLOYMENT_ID,
      INDEXER_CHAIN_POLL_MS: String(INDEXER_POLL_MS),
    },
    worker: {
      ...common,
      WORKER_ENABLED: "true",
      WORKER_DATABASE_URL: input.databaseUrl("worker"),
      BLINK_DEPLOYMENT_ID: DEPLOYMENT_ID,
      FORECAST_PRE_CLOSE_LEAD_SECONDS: String(input.schedule.preCloseLeadSeconds),
      FORECAST_WINDOW_OPEN_SECONDS: String(input.schedule.openSeconds),
    },
  };
}

async function startPostgresPlatform(
  options: {
    adminUrl?: string;
    forecastSchedule?: typeof ALPHA_FORECAST_SCHEDULE;
    publicReadLimit?: { capacity: number; refillPerSecond: number };
    accountCount?: number;
  } = {},
) {
  const adminUrl = options.adminUrl ?? process.env.TEST_POSTGRES_ADMIN_URL;
  if (!adminUrl) throw new Error("TEST_POSTGRES_ADMIN_URL_REQUIRED");
  const schedule = options.forecastSchedule ?? ALPHA_FORECAST_SCHEDULE;
  await assertPortFree(WORKER_PORT, "ALPHA_WORKER_PORT_IN_USE");

  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const databaseName = "blink_alpha_" + suffix;
  const logins = {
    api: { user: "alpha_api_" + suffix, group: "blink_api" },
    indexer: { user: "alpha_indexer_" + suffix, group: "blink_indexer" },
    worker: { user: "alpha_worker_" + suffix, group: "blink_worker" },
    deployment: { user: "alpha_deploy_" + suffix, group: "blink_deployment_admin" },
  } as const;
  const passwords = Object.fromEntries(
    Object.keys(logins).map((role) => [role, randomBytes(18).toString("hex")]),
  ) as Record<keyof typeof logins, string>;
  const databaseUrl = (login?: keyof typeof logins) => {
    const url = new URL(adminUrl);
    url.pathname = "/" + databaseName;
    if (login) {
      url.username = logins[login].user;
      url.password = passwords[login];
    }
    return url.toString();
  };

  const control = new pg.Client({ connectionString: adminUrl });
  await control.connect();
  const cleanups: (() => Promise<unknown>)[] = [];
  const pools: pg.Pool[] = [];
  const pool = (login?: keyof typeof logins) => {
    const created = new pg.Pool({ connectionString: databaseUrl(login), max: 3 });
    pools.push(created);
    return created;
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const processes: ReturnType<typeof startProcess>[] = [];
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      clearInterval(heartbeat);
      await runCleanup([
        ...processes.map((p) => ["process " + p.name, () => p.stop()] as const),
        ...pools.map((p, index) => ["pool " + index, () => p.end()] as const),
        ...[...cleanups].reverse().map((cleanup, index) => ["cleanup " + index, cleanup] as const),
        ["drop database", () => control.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)],
        ...Object.values(logins).map(
          (login) => ["drop role " + login.user, () => control.query(`DROP ROLE IF EXISTS "${login.user}"`)] as const,
        ),
        ["close control connection", () => control.end()],
      ]);
    })());

  try {
    // Database: schema, one ordinary login per platform process, one for registration.
    await control.query(`CREATE DATABASE "${databaseName}"`);
    await migratePostgres(databaseUrl());
    for (const [role, login] of Object.entries(logins))
      await control.query(
        `CREATE ROLE "${login.user}" LOGIN PASSWORD '${passwords[role as keyof typeof logins]}' IN ROLE ${login.group}`,
      );

    // Chain: the alpha generation, deployed by a key that is not one of the actors.
    const anvil: Anvil = await startAnvil({ chainId: CHAIN_ID, ...(options.accountCount === undefined ? {} : { accountCount: options.accountCount }) });
    cleanups.push(() => anvil.stop());
    heartbeat = setInterval(() => void anvil.mine(1).catch(() => undefined), HEARTBEAT_MS);
    const { accounts } = anvil;
    const plan = await planProtocolDeployment({
      deployer: accounts.trader.address,
      nonce: await anvil.publicClient.getTransactionCount({ address: accounts.trader.address }),
      params: presets.alpha,
      treasury: accounts.keeper.address,
    });
    const deployment: ProtocolDeployment = await deployProtocol(
      anvil.wallet(accounts.trader),
      anvil.publicClient,
      plan,
      { deploymentId: DEPLOYMENT_ID, releaseCommit: "0".repeat(40) },
    );
    const registrar = pool("deployment");
    await registerProtocolDeployment(
      registrar,
      deployment,
      await verifyProtocolDeployment(anvil.publicClient, deployment),
    );

    // The platform: three processes, each with an explicit environment and no key.
    const apiPort = await freePort();
    const indexerPort = await freePort();
    const apiUrl = "http://127.0.0.1:" + apiPort;
    const specDirectory = await mkdtemp(join(tmpdir(), "blink-alpha-specs-"));
    cleanups.push(() => rm(specDirectory, { recursive: true, force: true }));
    const envs = platformEnvs({
      rpcUrl: anvil.url,
      apiUrl,
      apiPort,
      indexerPort,
      specDirectory,
      schedule,
      ...(options.publicReadLimit === undefined ? {} : { publicReadLimit: options.publicReadLimit }),
      databaseUrl,
    });
    const entries: Record<PlatformName, string> = {
      api: "apps/api/src/main.ts",
      indexer: "apps/indexer/src/main.ts",
      worker: "apps/worker/src/main.ts",
    };
    for (const name of ["api", "indexer", "worker"] as const)
      processes.push(startProcess(name, entries[name], envs[name]));
    const platform = Object.fromEntries(processes.map((p) => [p.name, p.process])) as Record<
      PlatformName,
      PlatformProcess
    >;
    const failureLogs = () =>
      processes.map((p) => `--- ${p.name} ---\n${p.process.logs().join("\n")}`).join("\n");
    const ready = async (what: string, url: string, owner: PlatformName) =>
      waitFor(
        what,
        async () => {
          if (platform[owner].exited()) throw new Error(owner + " exited\n" + failureLogs());
          return (await json(url).catch(() => null))?.status === 200 ? true : null;
        },
        READY_TIMEOUT_MS,
      );
    await Promise.all([
      ready("API ready", apiUrl + "/health/ready", "api"),
      ready("chain index health", `http://127.0.0.1:${indexerPort}/health/chain-index`, "indexer"),
      ready("worker ready", `http://127.0.0.1:${WORKER_PORT}/health/ready`, "worker"),
    ]);

    return {
      anvil,
      deployment,
      accounts,
      apiUrl,
      rpcUrl: anvil.url,
      deploymentId: DEPLOYMENT_ID,
      indexerUrl: `http://127.0.0.1:${indexerPort}`,
      workerUrl: `http://127.0.0.1:${WORKER_PORT}`,
      processes: platform,
      /** A login of the indexer role, for verifying the index against the journal. */
      indexerPool: pool("indexer"),
      logReader: protocolLogReader(anvil.publicClient as PublicClient, deployment),
      failureLogs,
      stop,
    };
  } catch (error) {
    // The startup failure is the primary error; a cleanup failure on top of it is only reported.
    await stop().catch((cleanupError) => console.error(String(cleanupError)));
    throw error;
  }
}

/** Anvil and the alpha generation, deployed by a key that is not one of the actors. */
async function deployAlphaGeneration(anvil: Anvil) {
  const { accounts } = anvil;
  const plan = await planProtocolDeployment({
    deployer: accounts.trader.address,
    nonce: await anvil.publicClient.getTransactionCount({ address: accounts.trader.address }),
    params: presets.alpha,
    treasury: accounts.keeper.address,
  });
  return deployProtocol(anvil.wallet(accounts.trader), anvil.publicClient, plan, {
    deploymentId: DEPLOYMENT_ID,
    releaseCommit: "0".repeat(40),
  });
}

/**
 * The API, the chain indexer, transaction tracking and the worker in this process, over a PGlite
 * database that has every migration. The services are wired as the `main.ts` of each app wires them
 * (the same stores, services and job handlers); the processes' own startup checks that need
 * database roles and a production clock are not applicable here.
 */
async function startPglitePlatform(
  options: {
    forecastSchedule?: typeof ALPHA_FORECAST_SCHEDULE;
    /** The API's public read bucket per client IP; every agent of a test shares one loopback IP. */
    publicReadLimit?: { capacity: number; refillPerSecond: number };
    accountCount?: number;
  } = {},
) {
  const schedule = options.forecastSchedule ?? ALPHA_FORECAST_SCHEDULE;
  const cleanups: (readonly [string, () => Promise<unknown>])[] = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      clearInterval(heartbeat);
      await runCleanup([...cleanups].reverse());
    })());
  try {
    const anvil = await startAnvil({ chainId: CHAIN_ID, ...(options.accountCount === undefined ? {} : { accountCount: options.accountCount }) });
    cleanups.push(["anvil", () => anvil.stop()]);
    heartbeat = setInterval(() => void anvil.mine(1).catch(() => undefined), HEARTBEAT_MS);
    const database = await createTestDatabase();
    cleanups.push(["database", () => database.close()]);
    const { pool } = database;
    const deployment: ProtocolDeployment = await deployAlphaGeneration(anvil);
    await registerProtocolDeployment(pool, deployment, await verifyProtocolDeployment(anvil.publicClient, deployment));

    const apiPort = await freePort();
    const apiUrl = "http://127.0.0.1:" + apiPort;
    const specDirectory = await mkdtemp(join(tmpdir(), "blink-alpha-specs-"));
    cleanups.push(["spec directory", () => rm(specDirectory, { recursive: true, force: true })]);
    // The same key-free environments the postgres backend starts its processes with.
    for (const env of Object.values(
      platformEnvs({
        rpcUrl: anvil.url,
        apiUrl,
        apiPort,
        indexerPort: 0,
        specDirectory,
        schedule,
        ...(options.publicReadLimit === undefined ? {} : { publicReadLimit: options.publicReadLimit }),
        databaseUrl: () => "pglite://in-process",
      }),
    ))
      assertNoRoleKeys(env);

    const logs = protocolLogReader(anvil.publicClient as PublicClient, deployment);
    const reader = postgresProtocolReader(pool, DEPLOYMENT_ID);
    const chainIndexer = startChainIndexer({
      indexer: createChainIndexer({
        store: postgresProtocolIndexStore(pool),
        reader: logs,
        deploymentId: DEPLOYMENT_ID,
        marketAddress: deployment.generation.markets,
        deploymentBlock: BigInt(deployment.startBlock),
        workerId: "pglite-platform",
      }),
      pollIntervalMs: INDEXER_POLL_MS,
      onError: (code) => console.error("INDEXER_CHAIN_SYNC_ERROR:" + code),
    });
    cleanups.push(["chain indexer", () => chainIndexer.stop()]);
    const tracker = createTxTracker({
      store: postgresTxTrackingStore(pool),
      reader: txReceiptReader(anvil.publicClient),
      manifest: (id) => txTrackingManifest(pool, id),
    });
    let tracking = Promise.resolve();
    const trackTimer = setInterval(() => {
      tracking = tracking.then(() => tracker.trackOnce(50).then(() => undefined)).catch(() => undefined);
    }, TX_TRACKING_MS);
    cleanups.push(["transaction tracking", async () => (clearInterval(trackTimer), tracking)]);

    // The worker: forecast windows, scoring and the outbox, in the jobs the real worker runs.
    registerEvaluationHandler(pool as never, reader, DEPLOYMENT_ID);
    const queue = postgresJobQueue(pool);
    const research = buildResearch({
      pool: pool as never,
      queue,
      reader,
      deploymentId: DEPLOYMENT_ID,
      schedule,
    });
    const jobs = startJobLoops({
      queue,
      alertHandler: async () => undefined,
      handlers: { ...workerHandlers, ...research.handlers },
      workerId: "pglite-platform",
      onError: (code) => console.error("WORKER_JOB_ERROR:" + code),
    });
    cleanups.push(["job loops", () => jobs.stop()]);
    let background = Promise.resolve();
    const run = (work: () => Promise<unknown>, code: string) =>
      (background = background.then(work).then(
        () => undefined,
        () => console.error(code),
      ));
    const outboxTimer = setInterval(
      () => void run(() => dispatchOutbox(pool, outboxMapping), "WORKER_OUTBOX_DISPATCH_FAILED"),
      OUTBOX_DISPATCH_MS,
    );
    const scheduleTimer = setInterval(
      () =>
        void run(
          () => Promise.all([research.tick(), scheduleEvaluation(pool as never)]),
          "WORKER_SCHEDULE_FAILED",
        ),
      SCHEDULE_MS,
    );
    cleanups.push(["worker timers", async () => (clearInterval(outboxTimer), clearInterval(scheduleTimer), background)]);
    void run(() => research.tick(), "WORKER_SCHEDULE_FAILED");

    const verifier = viemSignatureVerifier(anvil.publicClient);
    const identity = createIdentityService(postgresIdentityStore(pool), identityCrypto, apiUrl, {
      verifier,
      reader,
    });
    const content = postgresContentStore(pool, fileObjectStore(specDirectory));
    const api = buildApi({
      identity,
      stage: "m2-markets",
      publicReadLimit: options.publicReadLimit ?? { capacity: 60, refillPerSecond: 1 },
      services: [
        createMetricsService({ store: postgresEvaluationStore(pool, DEPLOYMENT_ID) }),
        createContentService({ store: content, identity, reader, publicOrigin: apiUrl }),
        createSuggestionService({ store: postgresSuggestionStore(pool), identity, reader }),
        createRfqService({
          store: postgresRfqStore(pool, DEPLOYMENT_ID),
          identity,
          reader,
          verifier,
          deployment: { markets: deployment.generation.markets, maxFillShares: deployment.params.maxFillShares },
        }),
        createTxTrackingService({
          store: postgresTxTrackingStore(pool),
          identity,
          reader,
          deploymentId: DEPLOYMENT_ID,
        }),
        createForecastService({
          store: postgresForecastStore(pool, DEPLOYMENT_ID),
          identity,
          reader,
          verifier,
          deployment: { markets: deployment.generation.markets, anchor: deployment.shared.anchor },
        }),
        createMarketReadService({
          store: postgresMarketReadStore(pool),
          reader,
          content,
          deployment: () => loadProtocolDeployment(pool, DEPLOYMENT_ID).catch(() => null),
        }),
      ],
    });
    api.log.level = "silent";
    cleanups.push(["api", () => api.close()]);
    await api.listen({ port: apiPort, host: "127.0.0.1" });
    await waitFor("chain index health", async () => (await chainIndexer.health()).ready, READY_TIMEOUT_MS);

    return {
      anvil,
      deployment,
      accounts: anvil.accounts,
      apiUrl,
      rpcUrl: anvil.url,
      deploymentId: DEPLOYMENT_ID,
      indexerPool: pool,
      logReader: logs,
      stop,
    };
  } catch (error) {
    await stop().catch((cleanupError) => console.error(String(cleanupError)));
    throw error;
  }
}

export type AlphaPlatform = {
  apiUrl: string;
  rpcUrl: string;
  /** The web app is optional for a drill and neither backend starts it. */
  webUrl?: string | undefined;
  deploymentId: string;
  stop(): Promise<void>;
  /** The local node, its funded public test accounts and the deployed generation, for the harness. */
  anvil: Anvil;
  deployment: ProtocolDeployment;
  accounts: Anvil["accounts"];
};
export type PostgresPlatform = Awaited<ReturnType<typeof startPostgresPlatform>>;

export function startAlphaPlatform(options: {
  backend: "postgres";
  adminUrl?: string;
  forecastSchedule?: typeof ALPHA_FORECAST_SCHEDULE;
  publicReadLimit?: { capacity: number; refillPerSecond: number };
  accountCount?: number;
}): Promise<PostgresPlatform>;
export function startAlphaPlatform(options: {
  backend: "pglite";
  forecastSchedule?: typeof ALPHA_FORECAST_SCHEDULE;
  publicReadLimit?: { capacity: number; refillPerSecond: number };
  accountCount?: number;
}): Promise<AlphaPlatform>;
/**
 * Starts the platform (see the top of this file). The postgres backend answers with the processes,
 * their logs and the index login as well, which the local alpha harness uses.
 */
export function startAlphaPlatform(
  options:
    | { backend: "postgres"; adminUrl?: string; forecastSchedule?: typeof ALPHA_FORECAST_SCHEDULE; publicReadLimit?: { capacity: number; refillPerSecond: number }; accountCount?: number }
    | {
        backend: "pglite";
        forecastSchedule?: typeof ALPHA_FORECAST_SCHEDULE;
        publicReadLimit?: { capacity: number; refillPerSecond: number };
        accountCount?: number;
      },
): Promise<AlphaPlatform> {
  return options.backend === "postgres" ? startPostgresPlatform(options) : startPglitePlatform(options);
}
