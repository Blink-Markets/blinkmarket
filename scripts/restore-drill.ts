import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import pg from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { Abi, Address } from "viem";
import * as adapters from "../packages/adapters/src/index.js";
import * as application from "../packages/application/src/index.js";
import { blinkMarketAbi } from "../packages/adapters/src/blink-abi.js";
import {
  ALPHA_DEADLINE_MS,
  runLocalAlpha,
  type AlphaDrillContext,
} from "./local-alpha.js";
import { attemptAll, runChild, settle } from "../tests/helpers/lifecycle.js";

// The backup and restore drill (spec 17.3, "backup restore succeeds"). It dumps the finished
// local Alpha's database with the PostgreSQL 17 client tools from the pinned image, restores the
// dump into a fresh database, and brings that database back the way a real recovery must:
//   1. the pool's quote gate is closed before anything else looks at the restored data;
//   2. the restored projections are compared with the pre-dump ones, with the contract's views at
//      the dump's block, and replayed from the canonical events (`chain:rebuild --verify`);
//   3. the indexer catches up with the chain (the chain moved on while the "disaster" lasted);
//   4. only then does the reservation reconciler run, and it alone opens the gate.
// A step that finds a difference, or finds quoting open before step 4, fails the drill.
export const POSTGRES_IMAGE = "postgres:17.6";
const TOOL_TIMEOUT_MS = 60_000;
const CHILD_TIMEOUT_MS = 60_000;
// Control-plane statements (CREATE DATABASE and the like) get the same room withDatabase gives.
const CONNECT_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 30_000;
// Blocks mined while the database is "lost": more than the RFQ lag rule tolerates (3).
const GAP_BLOCKS = 6;

export interface RestoreDrillInterference {
  // Run on the restored database (as its owner) right after pg_restore: a faulty restore.
  afterRestore?: (db: pg.Pool) => Promise<unknown>;
  // Run after replay and before the reconciler: a faulty procedure that reopens quoting.
  beforeReconcile?: (db: pg.Pool) => Promise<unknown>;
}

export interface RestoreDrillReport {
  pgDumpVersion: string;
  archiveBytes: number;
  eventCount: number;
  // Canonical events the indexer replayed from the chain after the restore.
  replayedAfterRestore: number;
  restoredEqualsDump: boolean;
  rebuildDifferences: number;
  matchesContractAtDump: boolean;
  matchesContractAtHead: boolean;
  // Why quoting was closed at each checkpoint; the last one is the first with quoting open.
  gates: { checkpoint: string; reasons: string[] }[];
  reconciled: { accounted: number; released: number; reopened: number };
  openReservations: number;
}

interface Tool {
  network: string[];
  host: string;
  port: string;
  user: string;
  password: string;
}

// Containers reach the host's PostgreSQL through the host network on Linux (CI) and through
// Docker Desktop's host alias elsewhere.
function toolFor(adminUrl: URL): Tool {
  const linux = process.platform === "linux";
  return {
    network: linux
      ? ["--network", "host"]
      : ["--add-host", "host.docker.internal:host-gateway"],
    host: linux ? adminUrl.hostname : "host.docker.internal",
    port: adminUrl.port || "5432",
    user: decodeURIComponent(adminUrl.username),
    password: decodeURIComponent(adminUrl.password),
  };
}

// Runs one PostgreSQL client tool inside the pinned image; the password travels in the
// container's environment, never in an argument.
function runTool(
  tool: Tool,
  label: string,
  args: string[],
  options: { input?: Buffer; signal: AbortSignal },
): Promise<Buffer> {
  const name = "blink-drill-" + randomUUID().slice(0, 8);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--name",
        name,
        ...tool.network,
        "-e",
        "PGPASSWORD",
        POSTGRES_IMAGE,
        ...args,
      ],
      {
        env: { ...process.env, PGPASSWORD: tool.password },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    const stop = (reason: string) => {
      child.kill("SIGKILL");
      // Killing the client leaves the container running until its tool ends.
      spawn("docker", ["rm", "-f", name], { stdio: "ignore" }).on(
        "error",
        () => {},
      );
      reject(new Error(`RESTORE_DRILL_TOOL_FAILED: ${label} ${reason}`));
    };
    const timer = setTimeout(
      () => stop(`timed out after ${TOOL_TIMEOUT_MS} ms`),
      TOOL_TIMEOUT_MS,
    );
    const abort = () => stop("cancelled");
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) =>
      reject(
        new Error(`RESTORE_DRILL_TOOL_FAILED: ${label}: ${error.message}`),
      ),
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      if (code === 0) resolvePromise(Buffer.concat(out));
      else
        reject(
          new Error(
            `RESTORE_DRILL_TOOL_FAILED: ${label} exited ${code}: ${err.trim().slice(0, 500)}`,
          ),
        );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

// Every table's row count and content digest, every table and column privilege, and the maker
// pool's gate (the one thing the restore procedure itself changes, so it is kept apart).
async function fingerprint(db: pg.Pool) {
  const tables = (
    await db.query<{ schema: string; name: string }>(
      `SELECT schemaname AS schema, tablename AS name FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2`,
    )
  ).rows.filter((t) => `${t.schema}.${t.name}` !== "trading.maker_pools");
  const rows: Record<string, string> = {};
  for (const { schema, name } of tables) {
    const { rows: result } = await db.query(
      `SELECT count(*)::text AS n,
        md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS digest
      FROM "${schema}"."${name}" x`,
    );
    rows[`${schema}.${name}`] = `${result[0].n}:${result[0].digest}`;
  }
  const privileges = (
    await db.query<{ line: string }>(
      `SELECT n.nspname || '.' || c.relname || ' ' || a.grantee::regrole::text || ' ' || a.privilege_type AS line
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
        LATERAL aclexplode(c.relacl) a
      WHERE c.relacl IS NOT NULL AND n.nspname NOT IN ('pg_catalog','information_schema')
      UNION ALL
      SELECT n.nspname || '.' || c.relname || '.' || t.attname || ' ' || a.grantee::regrole::text || ' ' || a.privilege_type
      FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace,
        LATERAL aclexplode(t.attacl) a
      WHERE t.attacl IS NOT NULL AND n.nspname NOT IN ('pg_catalog','information_schema')
      ORDER BY 1`,
    )
  ).rows.map((r) => r.line);
  return { rows, privileges };
}

const SECONDS = (ms: number) => Math.floor(ms / 1000);

export async function runRestoreDrill(
  context: AlphaDrillContext,
  options: { interfere?: RestoreDrillInterference } = {},
): Promise<RestoreDrillReport> {
  const { deploymentId, owner, anvil, manifest, life, chainStore } = context;
  const adminUrl = new URL(process.env.TEST_POSTGRES_ADMIN_URL ?? "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(adminUrl.hostname))
    throw new Error("LOCAL_POSTGRES_REQUIRED");
  const tool = toolFor(adminUrl);
  const sourceName = (await owner.query("SELECT current_database() AS name"))
    .rows[0].name as string;
  const dbArgs = (name: string) => [
    "-h",
    tool.host,
    "-p",
    tool.port,
    "-U",
    tool.user,
    "-d",
    name,
  ];
  const gates: RestoreDrillReport["gates"] = [];

  // What the database and the chain say before the disaster.
  life.stage("restore drill: capture");
  const before = await chainStore.loadSnapshot(deploymentId);
  const sourcePrint = await fingerprint(owner);
  const dumpBlock = before.cursor.blockNumber;

  life.stage("restore drill: pg_dump");
  const pgDumpVersion = (
    await runTool(tool, "pg_dump --version", ["pg_dump", "--version"], {
      signal: life.signal,
    })
  )
    .toString()
    .trim();
  const archive = await runTool(
    tool,
    "pg_dump",
    ["pg_dump", "--format=custom", "--no-owner", ...dbArgs(sourceName)],
    { signal: life.signal },
  );
  assert.ok(archive.length > 0, "RESTORE_DRILL_EMPTY_DUMP");

  // The chain moves on while the database is gone: one event the dump cannot hold, then blocks.
  life.stage("restore drill: chain moves on");
  const newcomer = privateKeyToAccount(generatePrivateKey()).address;
  await context.send(
    anvil.accounts.admin,
    context.market,
    blinkMarketAbi as Abi,
    "setTakerAllowed",
    [newcomer, true],
  );
  await anvil.mine(GAP_BLOCKS);

  life.stage("restore drill: pg_restore");
  const restoredName = "blink_t8_" + randomUUID().replaceAll("-", "");
  const roles = {
    indexer: "t8_" + randomUUID().replaceAll("-", "").slice(0, 24),
    worker: "t8_" + randomUUID().replaceAll("-", "").slice(0, 24),
  };
  const passwords = {
    indexer: randomUUID(),
    worker: randomUUID(),
  };
  const control = new pg.Client({
    connectionString: adminUrl.toString(),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS + 5000,
  });
  await control.connect();
  const urlFor = (user?: string, password?: string) => {
    const url = new URL(adminUrl.toString());
    url.pathname = "/" + restoredName;
    if (user) {
      url.username = user;
      url.password = password!;
    }
    return url.toString();
  };
  const pools: pg.Pool[] = [];
  const pool = (url: string, max = 2) => {
    const p = new pg.Pool({
      connectionString: url,
      max,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    });
    pools.push(p);
    return p;
  };
  let created = false;
  let roleNames: string[] = [];
  let stopped = false;
  // Drops everything the drill created. It runs when the drill ends and again, harmlessly, if the
  // run's own teardown finds the drill abandoned mid-way.
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    settle(
      undefined,
      await attemptAll(
        [
          ...pools.map((p, i) => ({
            name: "restored pool " + i,
            run: () => p.end(),
          })),
          ...(created
            ? [
                {
                  name: "wait for sessions",
                  run: async () => {
                    for (let i = 0; i < 100; i += 1) {
                      const { rows } = await control.query(
                        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
                        [restoredName],
                      );
                      if (rows[0].n === 0) break;
                      await new Promise((r) => setTimeout(r, 50));
                    }
                  },
                },
                {
                  name: "drop restored database",
                  run: () =>
                    control.query(
                      `DROP DATABASE IF EXISTS "${restoredName}" WITH (FORCE)`,
                    ),
                },
              ]
            : []),
          ...roleNames.map((role) => ({
            name: "drop role " + role,
            run: () => control.query(`DROP ROLE IF EXISTS "${role}"`),
          })),
          { name: "control connection", run: () => control.end() },
        ],
        30_000,
      ),
    );
  };
  life.add("restore drill database", stop);
  let outcome: { error: unknown } | undefined;
  let report: RestoreDrillReport | undefined;
  try {
    roleNames = Object.values(roles);
    await control.query(`CREATE DATABASE "${restoredName}"`);
    created = true;
    await runTool(
      tool,
      "pg_restore",
      ["pg_restore", "--no-owner", "--exit-on-error", ...dbArgs(restoredName)],
      { input: archive, signal: life.signal },
    );
    for (const [kind, role] of Object.entries(roles))
      await control.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${passwords[kind as keyof typeof passwords]}' IN ROLE blink_${kind}`,
      );
    // The restored database follows the chain's clock like the source did. This is set before
    // any pool connects, because a session reads it when it starts.
    const offset =
      (await anvil.publicClient.getBlock()).timestamp -
      BigInt(SECONDS(Date.now()));
    for (const role of [tool.user, ...roleNames])
      await control.query(
        `ALTER ROLE "${role}" IN DATABASE "${restoredName}" SET blink.test_clock_offset_seconds = '${offset}'`,
      );
    const restored = pool(urlFor());
    const indexerPool = pool(urlFor(roles.indexer, passwords.indexer));
    const workerPool = pool(urlFor(roles.worker, passwords.worker));
    await options.interfere?.afterRestore?.(restored);

    // Rule 3: the first act on a restored database is to close quoting.
    life.stage("restore drill: close quoting");
    await restored.query(
      `INSERT INTO trading.maker_pools(deployment_id, gate_reason) VALUES($1,'OVERCOMMITTED')
      ON CONFLICT (deployment_id) DO UPDATE SET gate_reason='OVERCOMMITTED', version=trading.maker_pools.version+1`,
      [deploymentId],
    );
    const tradingStore = adapters.postgresTradingStore(workerPool);
    const reasons = () =>
      tradingStore.run(async (tx) => {
        const found: string[] = [];
        const gate = await tx.poolGate(deploymentId);
        if (gate) found.push(gate);
        if (await tx.needsReconcile(deploymentId))
          found.push("RECONCILE_REQUIRED");
        const head = await anvil.publicClient.getBlockNumber();
        const status = application.indexerStatus(
          await tx.cursor(deploymentId),
          head,
        );
        if (status !== "FRESH") found.push(status);
        return found;
      });
    const checkpoint = async (name: string, closed: boolean) => {
      const found = await reasons();
      gates.push({ checkpoint: name, reasons: found });
      if (closed && found.length === 0)
        throw new Error(
          `RESTORE_QUOTING_REOPENED_EARLY: quoting is open at "${name}", before the reconciler ran`,
        );
    };
    await checkpoint("restored", true);

    life.stage("restore drill: replay canonical events");
    const rebuilt = JSON.parse(
      await runChild(
        "chain rebuild",
        [
          "--import",
          "tsx",
          "scripts/rebuild-chain-index.ts",
          deploymentId,
          "--verify",
        ],
        {
          env: {
            ...process.env,
            INDEXER_DATABASE_URL: urlFor(roles.indexer, passwords.indexer),
            BLINK_ALLOW_TEST_CLOCK: "1",
          },
          timeoutMs: CHILD_TIMEOUT_MS,
          signal: life.signal,
        },
      ).catch((error: unknown) => {
        // The script exits 1 with the report on stdout when --verify finds a difference.
        const stdout = (error as { stdout?: string }).stdout;
        if (stdout) return stdout;
        throw error;
      }),
    ) as { eventCount: number; differences: string[] };
    if (rebuilt.differences.length)
      throw new Error(
        "RESTORE_REPLAY_DIFFERS: " + rebuilt.differences.join(", "),
      );
    await checkpoint("rebuild verified", true);

    // Rule 2: what was restored is what was dumped, and what the contract showed at that block.
    life.stage("restore drill: compare with the dump");
    const restoredChain = adapters.postgresChainIndexStore(indexerPool);
    const afterRestore = await restoredChain.loadSnapshot(deploymentId);
    const restoredPrint = await fingerprint(restored);
    try {
      assert.deepEqual(afterRestore.projection, before.projection);
      assert.deepEqual(afterRestore.cursor, before.cursor);
      assert.deepEqual(restoredPrint.rows, sourcePrint.rows);
      assert.deepEqual(restoredPrint.privileges, sourcePrint.privileges);
    } catch (error) {
      throw new Error(
        "RESTORE_NOT_EQUAL_TO_DUMP: " +
          (error instanceof Error ? error.message.split("\n")[0] : error),
        { cause: error },
      );
    }
    await compareWithContract(context, afterRestore.projection, dumpBlock);

    // The indexer that held the cursor's lease died with the old database; its lease is only a
    // lapse of up to 30 s, and no indexer runs against the restored copy yet.
    await restored.query(
      "UPDATE chain.cursors SET lease_owner=NULL, lease_until=NULL WHERE deployment_id=$1",
      [deploymentId],
    );
    life.stage("restore drill: catch up with the chain");
    const indexer = application.createChainIndexer({
      store: restoredChain,
      reader: adapters.chainLogReader(anvil.publicClient),
      deploymentId,
      marketAddress: context.market.toLowerCase(),
      deploymentBlock: BigInt(manifest.deploymentBlock),
      workerId: "restore-drill",
      rangeSize: 100,
    });
    for (let n = 0; ; n++) {
      life.signal.throwIfAborted();
      if (n >= 100) throw new Error("RESTORE_DRILL_INDEXER_DID_NOT_CONVERGE");
      const r = await indexer.syncOnce();
      if (r.advancedTo === null && r.reorgedTo === null) break;
    }
    const replayed = await restoredChain.loadSnapshot(deploymentId);
    const replayedAfterRestore =
      replayed.events.length - afterRestore.events.length;
    assert.ok(replayedAfterRestore >= 1, "RESTORE_DRILL_NOTHING_REPLAYED");
    assert.equal(replayed.projection.takers.get(newcomer.toLowerCase()), true);
    await compareWithContract(
      context,
      replayed.projection,
      replayed.cursor.blockNumber,
    );
    await checkpoint("replayed to head", true);

    // Rule 3: nothing but the reconciler opens quoting.
    await options.interfere?.beforeReconcile?.(restored);
    life.stage("restore drill: reconcile reservations");
    if ((await reasons()).length === 0)
      throw new Error(
        "RESTORE_QUOTING_REOPENED_EARLY: quoting is open before the reconciler ran",
      );
    const reconciled = await application
      .createQuoteReconciler(tradingStore)
      .reconcileOnce(deploymentId);
    await checkpoint("reconciled", false);
    assert.deepEqual(
      gates.at(-1)!.reasons,
      [],
      "RESTORE_QUOTING_STILL_CLOSED_AFTER_RECONCILE",
    );
    const openReservations = (
      await restored.query(
        "SELECT count(*)::int AS n FROM trading.collateral_reservations WHERE state IN ('HELD','RECONCILE_REQUIRED')",
      )
    ).rows[0].n as number;
    report = {
      pgDumpVersion,
      archiveBytes: archive.length,
      eventCount: rebuilt.eventCount,
      replayedAfterRestore,
      restoredEqualsDump: true,
      rebuildDifferences: rebuilt.differences.length,
      matchesContractAtDump: true,
      matchesContractAtHead: true,
      gates,
      reconciled,
      openReservations,
    };
  } catch (error) {
    outcome = { error };
  }
  try {
    await stop();
  } catch (error) {
    outcome ??= { error };
  }
  settle(outcome, []);
  return report!;
}

// The projection against the contract's own views at one block. The chain keeps history on
// Anvil, so the dump's block can be read after the chain has moved on.
async function compareWithContract(
  context: AlphaDrillContext,
  projection: Awaited<
    ReturnType<AlphaDrillContext["chainStore"]["loadProjection"]>
  >,
  blockNumber: bigint,
) {
  const read = (functionName: string, args: readonly unknown[] = []) =>
    context.anvil.publicClient.readContract({
      address: context.market,
      abi: blinkMarketAbi,
      functionName,
      args,
      blockNumber,
    } as never) as Promise<any>;
  const wrong = (what: string) => {
    throw new Error(
      "RESTORE_CONTRACT_MISMATCH: " + what + " at block " + blockNumber,
    );
  };
  if (projection.maker.freeMicros !== (await read("makerFreeBalance")))
    wrong("maker free balance");
  if (projection.maker.epoch !== (await read("currentMakerEpoch")))
    wrong("maker epoch");
  if (projection.maker.globalPaused !== (await read("globalTradingPaused")))
    wrong("global pause");
  for (const [id, market] of projection.markets) {
    const view = await read("getMarket", [BigInt(id)]);
    if (market.escrowMicros !== view.escrowMicros) wrong("escrow of " + id);
    if (market.totalPairs !== view.totalMintedPairs) wrong("pairs of " + id);
    if (market.paused !== view.paused) wrong("pause of " + id);
    if (
      market.state !==
      ["OPEN", "PROPOSED", "DISPUTED", "FINAL"][Number(view.state)]
    )
      wrong("state of " + id);
  }
  for (const position of projection.positions.values()) {
    const view = await read("getPosition", [
      BigInt(position.marketId),
      position.account as Address,
    ]);
    if (position.yesShares !== view[0] || position.noShares !== view[1])
      wrong(`position ${position.marketId}:${position.account}`);
  }
  for (const [account, allowed] of projection.takers)
    if (allowed !== (await read("takerAllowed", [account])))
      wrong("taker " + account);
  for (const digest of projection.digests.values())
    if (
      (await read("consumed", [digest.digest])) !==
      (digest.state === "FILLED" || digest.state === "CANCELLED")
    )
      wrong("digest " + digest.digest);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const interrupted = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"] as const)
    process.once(name, () => interrupted.abort(new Error(name + " received")));
  try {
    let report: RestoreDrillReport | undefined;
    await runLocalAlpha({
      signal: AbortSignal.any([
        interrupted.signal,
        AbortSignal.timeout(ALPHA_DEADLINE_MS * 2),
      ]),
      onStage: (stage) => console.log("DRILL stage: " + stage),
      afterScenarios: async (context) => {
        report = await runRestoreDrill(context);
      },
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
