import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { erc20Abi, type Abi, type Hex, type LocalAccount, type PublicClient } from "viem";
import { createBlinkClient } from "../packages/client/src/index.ts";
import { protocolAbi as typedAbi, type ProtocolContractName } from "../packages/adapters/src/protocol-abi.ts";
import { registerProtocolDeployment } from "../packages/adapters/src/deployment-registry.ts";
import { verifyProtocolDeployment } from "../packages/adapters/src/deployment-verifier.ts";
import { migratePostgres } from "../packages/adapters/src/migrations.ts";
import { protocolLogReader } from "../packages/adapters/src/protocol-log-reader.ts";
import { deployProtocol, planProtocolDeployment } from "../packages/adapters/src/protocol-deployer.ts";
import { assertNoRoleKeys } from "../packages/runtime/src/index.ts";
import { presets, type ProtocolDeployment } from "../packages/schemas/src/index.ts";
import { startAnvil, type Anvil } from "../tests/helpers/anvil.ts";

/**
 * The infrastructure-only local alpha (P2 spec 2.1.3). It starts what the platform consists of and
 * nothing else: Anvil (chain 84532), the alpha protocol generation registered in a fresh PostgreSQL
 * database, and the real API, indexer and worker as separate processes. Those three get an explicit
 * environment (never the caller's), without any key, and `assertNoRoleKeys` is applied to each one
 * before it starts. The agents that exercise the protocol are the caller's: they hold Anvil's public
 * test keys inside their own process and reach the platform only through the public API,
 * `@blink/client` and the contracts. P3's `pnpm alpha:autonomous` is built on this module.
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

const repository = fileURLToPath(new URL("..", import.meta.url));
const CHAIN_ID = 84532;
const DEPLOYMENT_ID = "local-alpha";
const HEARTBEAT_MS = 1000;
const READY_TIMEOUT_MS = 90_000;
const LOG_LINES = 120;
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

export const protocolAbi = typedAbi as unknown as Record<ProtocolContractName, Abi>;
export const ROLE = {
  CREATOR: 0,
  MAKER: 1,
  TAKER: 2,
  FORECASTER: 3,
  PROPOSER: 4,
  CHALLENGER: 5,
  JUROR: 6,
} as const;

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

export async function startLocalAlpha(
  options: { adminUrl?: string; forecastSchedule?: typeof ALPHA_FORECAST_SCHEDULE } = {},
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
    const anvil: Anvil = await startAnvil({ chainId: CHAIN_ID });
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
    const common = { PATH: process.env.PATH ?? "", BASE_SEPOLIA_RPC_URL: anvil.url };
    const envs: Record<PlatformName, Record<string, string>> = {
      api: {
        ...common,
        BLINK_API_MODE: "markets",
        API_HOST: "127.0.0.1",
        API_PORT: String(apiPort),
        API_DATABASE_URL: databaseUrl("api"),
        WALLET_BINDING_ORIGIN: apiUrl,
        SPEC_OBJECT_DIRECTORY: specDirectory,
        SPEC_PUBLIC_ORIGIN: apiUrl,
        BLINK_DEPLOYMENT_ID: DEPLOYMENT_ID,
      },
      indexer: {
        ...common,
        CHAIN_INDEXER_ENABLED: "true",
        INDEXER_TX_TRACKING_ENABLED: "true",
        INDEXER_HOST: "127.0.0.1",
        INDEXER_PORT: String(indexerPort),
        INDEXER_DATABASE_URL: databaseUrl("indexer"),
        INDEXER_DEPLOYMENT_ID: DEPLOYMENT_ID,
        INDEXER_CHAIN_POLL_MS: "500",
      },
      worker: {
        ...common,
        WORKER_ENABLED: "true",
        WORKER_DATABASE_URL: databaseUrl("worker"),
        BLINK_DEPLOYMENT_ID: DEPLOYMENT_ID,
        FORECAST_PRE_CLOSE_LEAD_SECONDS: String(schedule.preCloseLeadSeconds),
        FORECAST_WINDOW_OPEN_SECONDS: String(schedule.openSeconds),
      },
    };
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

    const write = async (
      who: LocalAccount,
      address: string,
      abi: Abi,
      functionName: string,
      args: readonly unknown[] = [],
    ) => {
      const receipt = await anvil.publicClient.waitForTransactionReceipt({
        hash: await anvil.wallet(who).writeContract({
          address: address as Hex,
          abi,
          functionName,
          args,
          gas: 5_000_000n,
        }),
      });
      if (receipt.status !== "success") throw new Error(functionName + " reverted");
      return receipt;
    };
    const markets = deployment.generation.markets as Hex;
    /**
     * The calls an account makes to join the protocol as `role`: faucet claim, approvals, register
     * and the role stake. Sent by the account itself.
     */
    const onboardingCalls = (role: number | null) => {
      const { generation, shared, params } = deployment;
      const calls: [string, Abi, string, readonly unknown[]][] = [
        [shared.faucet, protocolAbi.faucet, "claim", []],
        ...[generation.registry, markets, generation.resolution].map(
          (spender): [string, Abi, string, readonly unknown[]] => [
            shared.busd,
            erc20Abi as Abi,
            "approve",
            [spender, 2n ** 256n - 1n],
          ],
        ),
        [generation.registry, protocolAbi.registry, "register", []],
      ];
      if (role !== null)
        calls.push([generation.registry, protocolAbi.registry, "joinRole", [role, BigInt(params.minRoleStake)]]);
      return calls;
    };

    return {
      anvil,
      deployment,
      accounts,
      apiUrl,
      indexerUrl: `http://127.0.0.1:${indexerPort}`,
      workerUrl: `http://127.0.0.1:${WORKER_PORT}`,
      platform,
      markets,
      /** A login of the indexer role, for verifying the index against the journal. */
      indexerPool: pool("indexer"),
      logReader: protocolLogReader(anvil.publicClient as PublicClient, deployment),
      failureLogs,
      write,
      read: <T = unknown>(address: string, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
        anvil.publicClient.readContract({ address: address as Hex, abi, functionName, args } as never) as Promise<T>,
      /** Latest block timestamp. */
      chainNow: async () => (await anvil.publicClient.getBlock()).timestamp,
      /** Blocks keep coming (heartbeat), so this is a condition wait, not a sleep of a guessed length. */
      async waitForChainTime(seconds: bigint, timeoutMs = 300_000) {
        await waitFor(
          "chain time " + seconds,
          async () => (await anvil.publicClient.getBlock()).timestamp >= seconds,
          timeoutMs,
          250,
        );
      },
      onboardingCalls,
      /** An EOA joins the protocol; further roles need `joinRole` only. */
      async onboard(who: LocalAccount, role: number | null) {
        for (const [address, abi, fn, args] of onboardingCalls(role))
          await write(who, address, abi, fn, args);
      },
      /**
       * An API key by wallet proof, the way an agent gets one. It first waits until the index shows the
       * account registered (a challenge is rate limited per address, so it is requested once).
       */
      async apiKeyFor(signer: LocalAccount, address: string = signer.address) {
        const client = createBlinkClient(apiUrl);
        await waitFor("indexed registration of " + address, async () => {
          const account = await client.getAccount({ address: address.toLowerCase() });
          return account.registered && !account.index.stale;
        });
        const challenge = await client.createWalletChallenge({
          address: address.toLowerCase(),
          action: "issue",
        });
        const issued = await client.verifyWallet({
          challengeId: challenge.challengeId,
          signature: await signer.signMessage({ message: challenge.message }),
        });
        if (!("apiKey" in issued)) throw new Error("NO_API_KEY");
        return issued.apiKey;
      },
      /** The real environments of the running processes (Linux only), to prove no key got in. */
      async liveEnvironment(name: PlatformName): Promise<Record<string, string> | null> {
        const raw = await readFile(`/proc/${platform[name].pid}/environ`, "utf8").catch(() => null);
        if (raw === null) return null;
        return Object.fromEntries(
          raw
            .split("\0")
            .filter(Boolean)
            .map((entry) => {
              const at = entry.indexOf("=");
              return [entry.slice(0, at), entry.slice(at + 1)];
            }),
        );
      },
      stop,
    };
  } catch (error) {
    // The startup failure is the primary error; a cleanup failure on top of it is only reported.
    await stop().catch((cleanupError) => console.error(String(cleanupError)));
    throw error;
  }
}
export type LocalAlpha = Awaited<ReturnType<typeof startLocalAlpha>>;

// `node --import tsx scripts/local-alpha.ts` keeps the stack up for manual use until interrupted.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const alpha = await startLocalAlpha();
  console.log(
    JSON.stringify({ api: alpha.apiUrl, indexer: alpha.indexerUrl, worker: alpha.workerUrl, rpc: alpha.anvil.url }),
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await alpha.stop();
}
