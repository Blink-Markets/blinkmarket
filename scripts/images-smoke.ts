import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  type Abi,
  type Address,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { migratePostgres } from "../packages/adapters/src/migrations.js";
import { deployContracts } from "../packages/adapters/src/contract-deployer.js";
import { registerVerifiedDeployment } from "../packages/adapters/src/deployment-registry.js";
import * as adapters from "../packages/adapters/src/index.js";
import * as application from "../packages/application/src/index.js";
import {
  FORECAST_PROMPTS,
  type PlatformRole,
} from "../packages/domain/src/index.js";
import { createBlinkClient } from "../packages/client/src/index.js";
import { runAgent } from "../examples/agent/run.js";
import {
  blinkMarketAbi,
  blinkTestUsdAbi,
} from "../packages/adapters/src/blink-abi.js";

// Opt-in container smoke (`pnpm images:smoke`): the four service images, configured as a deployment
// would configure them, against a PostgreSQL and an Anvil (chain ID 84532) started by
// infra/compose.alpha.yaml. Test keys only; nothing leaves this machine. The business clock is never
// shifted (the production guard stays on), so everything runs in real time.
//   default: containers healthy, non-root, ready; a faucet mint is signed and lands; one REPLAY
//            market is created through the normal path (discovery candidate, approval, creation),
//            gets its forecast snapshot, and the example agent quotes and buys against the
//            containerized API; the indexer container ingests the fill.
//   --full (or IMAGES_SMOKE_FULL=1): the same run continues until the market closes, the proposer
//            proposes, the keeper in the worker container finalizes, and the agent redeems.
// A market can only trade after a forecast snapshot. The earliest forecast window ends at
// closeAt - 1 h and opens 30 minutes earlier (packages/domain/src/forecast-windows.ts), and a
// forecaster reads only evidence observed before its window opens (platform-run-store.ts
// `evidence`, cutoff = openAt). So the default run takes about 32 minutes from the evidence
// import to the first quote, and --full adds the remaining hour to closeAt.
const FULL =
  process.argv.includes("--full") || process.env.IMAGES_SMOKE_FULL === "1";
// The project name and the host ports can be overridden, so two runs (or another stack on a shared
// machine) never share containers, volumes or ports; the defaults avoid the test PostgreSQL ports.
const PROJECT = process.env.ALPHA_PROJECT ?? "blink-alpha";
const COMPOSE = ["compose", "-p", PROJECT, "-f", "infra/compose.alpha.yaml"];
const PROJECT_VOLUME = (name: string) => PROJECT + "_" + name;
const DEPLOYMENT = "image-smoke";
const port = (name: string, fallback: number) =>
  Number(process.env[name] ?? fallback);
const ports = {
  postgres: port("ALPHA_POSTGRES_PORT", 55420),
  anvil: port("ALPHA_ANVIL_PORT", 58545),
  api: port("ALPHA_API_PORT", 3001),
  indexer: port("ALPHA_INDEXER_PORT", 3003),
};

const secret = () => randomBytes(18).toString("hex");
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const passwords = {
  postgres: secret(),
  api: secret(),
  worker: secret(),
  indexer: secret(),
  signer: secret(),
  deployment: secret(),
  identity: secret(),
  evidence: secret(),
};
const tokens = { api: secret(), worker: secret() };
const login = (role: keyof typeof passwords) =>
  `postgresql://smoke_${role}:${passwords[role]}@postgres:5432/blink`;
const env = {
  ...process.env,
  ALPHA_POSTGRES_PASSWORD: passwords.postgres,
  ALPHA_POSTGRES_PORT: String(ports.postgres),
  ALPHA_ANVIL_PORT: String(ports.anvil),
  ALPHA_API_PORT: String(ports.api),
  ALPHA_INDEXER_PORT: String(ports.indexer),
  ALPHA_DEPLOYMENT_ID: DEPLOYMENT,
  ALPHA_API_DATABASE_URL: login("api"),
  ALPHA_WORKER_DATABASE_URL: login("worker"),
  ALPHA_INDEXER_DATABASE_URL: login("indexer"),
  ALPHA_SIGNER_DATABASE_URL: login("signer"),
  ALPHA_PLATFORM_OPERATOR_ID: "set-after-provisioning",
  ALPHA_FORECASTER_A_KEY: "set-after-provisioning",
  ALPHA_FORECASTER_B_KEY: "set-after-provisioning",
  ALPHA_BASELINE_KEY: "set-after-provisioning",
  ALPHA_API_SIGNER_TOKEN: tokens.api,
  ALPHA_WORKER_SIGNER_TOKEN: tokens.worker,
  ALPHA_SIGNER_CALLERS: JSON.stringify([
    { name: "api", tokenSha256: sha256(tokens.api), roles: ["maker"] },
    {
      name: "worker",
      tokenSha256: sha256(tokens.worker),
      roles: ["keeper", "faucet"],
    },
  ]),
};

function docker(args: string[], options: { allowFailure?: boolean } = {}) {
  // An hour of container logs is far more than spawnSync's default 1 MiB.
  const result = spawnSync("docker", args, {
    env,
    encoding: "utf8",
    maxBuffer: 1 << 29,
  });
  if (result.status !== 0 && !options.allowFailure)
    throw new Error(
      "docker " + args.slice(0, 3).join(" ") + " failed:\n" + result.stderr,
    );
  return result;
}
const compose = (...args: string[]) => docker([...COMPOSE, ...args]);

// Ask a container's own /health endpoint: the worker and the stubs bind to loopback.
function inside(service: string, port: number, path: string) {
  const result = docker(
    [
      ...COMPOSE,
      "exec",
      "-T",
      service,
      "node",
      "-e",
      `fetch('http://127.0.0.1:${port}${path}').then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})))`,
    ],
    { allowFailure: true },
  );
  assert.equal(result.status, 0, service + " " + path + ": " + result.stderr);
  return JSON.parse(result.stdout) as { status: number; body: unknown };
}

async function waitFor<T>(
  what: string,
  read: () => Promise<T | null> | T | null,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("SMOKE_TIMEOUT: " + what);
    await delay(500);
  }
}

const hostUrl = (role: keyof typeof passwords) =>
  role === "postgres"
    ? `postgresql://blink:${passwords.postgres}@127.0.0.1:${ports.postgres}/blink`
    : `postgresql://smoke_${role}:${passwords[role]}@127.0.0.1:${ports.postgres}/blink`;
const hostPools: pg.Pool[] = [];
const hostPool = (role: keyof typeof passwords) => {
  const pool = new pg.Pool({ connectionString: hostUrl(role), max: 2 });
  hostPools.push(pool);
  return pool;
};
const apiUrl = () => `http://127.0.0.1:${ports.api}`;
const hash = (text: string) => keccak256(new TextEncoder().encode(text));

// The same test mnemonic the harness uses; these accounts exist only on this Anvil.
const mnemonic = "test test test test test test test test test test test junk";
const account = (addressIndex: number) =>
  mnemonicToAccount(mnemonic, { addressIndex });
const keyOf = (index: number) =>
  "0x" + Buffer.from(account(index).getHdKey().privateKey!).toString("hex");
const [admin, maker, proposer, , , minter, taker, , keeper] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8,
].map(account) as ReturnType<typeof account>[];

async function deploy(registrar: pg.Pool) {
  const url = `http://127.0.0.1:${ports.anvil}`;
  const chain = defineChain({
    id: 84532,
    name: "Blink image smoke Anvil",
    nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const client = createPublicClient({
    chain,
    transport: http(url, { retryCount: 0 }),
    pollingInterval: 100,
    cacheTime: 0,
  });
  const wallet = (who: ReturnType<typeof account>) =>
    createWalletClient({ account: who, chain, transport: http(url) });
  // Anvil has no OP-stack GasPriceOracle predeploy. The smoke installs a stub that answers every
  // call with an L1 fee of 1 wei, so the signer runs in its real oracle fee mode and really signs.
  await client.request({
    method: "anvil_setCode" as never,
    params: [
      "0x420000000000000000000000000000000000000F",
      "0x600160005260206000f3",
    ] as never,
  });
  const manifest = await deployContracts({
    client,
    wallet: wallet(account(9)),
    roles: {
      admin: admin!.address,
      maker: maker!.address,
      resultProposer: proposer!.address,
      challenger: account(3).address,
      arbiter: account(4).address,
      faucetMinter: minter!.address,
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
  const register = (reason: string) =>
    registerVerifiedDeployment(
      registrar,
      manifest,
      DEPLOYMENT,
      client,
      abis,
      reason,
    );
  await register("Image smoke Anvil");
  const market = manifest.contracts.BlinkMarket as Address,
    token = manifest.contracts.BlinkTestUSD as Address;
  const send = async (
    from: ReturnType<typeof account>,
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
  ) =>
    assert.equal(
      (
        await client.waitForTransactionReceipt({
          hash: await wallet(from).writeContract({
            address,
            abi,
            functionName,
            args,
          } as never),
        })
      ).status,
      "success",
      functionName,
    );
  // Fund the maker pool like the harness does, so the signer's reservation check has a pool to read.
  await send(minter!, token, blinkTestUsdAbi, "mint", [
    maker!.address,
    1_000_000_000n,
  ]);
  await send(maker!, token, blinkTestUsdAbi, "approve", [
    market,
    1_000_000_000n,
  ]);
  await send(maker!, market, blinkMarketAbi, "depositMaker", [1_000_000_000n]);
  // The taker must be allow-listed on the market contract and needs gas for its own transactions.
  await send(admin!, market, blinkMarketAbi, "setTakerAllowed", [
    taker!.address,
    true,
  ]);
  await client.waitForTransactionReceipt({
    hash: await wallet(admin!).sendTransaction({
      to: taker!.address,
      value: 10n ** 18n,
    }),
  });
  return { client, wallet, send, token, market, manifest, register };
}

type Chain = Awaited<ReturnType<typeof deploy>>;
type Invite = { apiKey: string; operatorId: string; agentId: string };

// Everything the containers need before they start: schema, one ordinary login per service, the
// deployment on Anvil, invited API keys for the platform agents and the external agent.
async function provision(owner: pg.Pool) {
  await migratePostgres(hostUrl("postgres"));
  // The registration, identity and evidence logins are used by this driver only, never by a container.
  for (const [role, group] of [
    ["api", "blink_api"],
    ["worker", "blink_worker"],
    ["indexer", "blink_indexer"],
    ["signer", "blink_signer"],
    ["deployment", "blink_deployment_admin"],
    ["identity", "blink_identity_admin"],
    ["evidence", "blink_evidence_admin"],
  ] as const)
    await owner.query(
      `CREATE ROLE "smoke_${role}" LOGIN PASSWORD '${passwords[role]}' IN ROLE ${group}`,
    );
  const chain = await deploy(hostPool("deployment"));
  const identity = adminOf(hostPool("identity"));
  const invite = (name: string, scopes: string[]): Promise<Invite> =>
    identity.invite({
      operatorName: name,
      agentName: name,
      scopes,
      reason: "image smoke fixture",
    });
  const keys = {
    discovery: await invite("discovery", ["candidate:write"]),
    administrator: await invite("admin", ["admin"]),
    external: await invite("external", [
      "forecast:write",
      "trade:quote",
      "faucet:claim",
    ]),
  };
  const platform = {} as Record<PlatformRole, Invite>;
  for (const [role, model] of [
    ["FORECASTER_A", "gm-replay-forecaster-a"],
    ["FORECASTER_B", "gm-replay-forecaster-b"],
    ["BASELINE", "gm-replay-baseline"],
  ] as const) {
    platform[role] = await invite(role, ["forecast:write"]);
    await owner.query(
      "INSERT INTO forecasts.platform_agents(agent_id,role,model,prompt_hash,policy_version) VALUES($1,$2,$3,decode($4,'hex'),'v1')",
      [
        platform[role].agentId,
        role,
        model,
        hash(FORECAST_PROMPTS[role]).slice(2),
      ],
    );
  }
  // The worker container reads these at start-up.
  env.ALPHA_PLATFORM_OPERATOR_ID = keys.discovery.operatorId;
  env.ALPHA_FORECASTER_A_KEY = platform.FORECASTER_A.apiKey;
  env.ALPHA_FORECASTER_B_KEY = platform.FORECASTER_B.apiKey;
  env.ALPHA_BASELINE_KEY = platform.BASELINE.apiKey;
  return { chain, keys, platform };
}
const adminOf = adapters.identityAdmin;

// Key files and object directories live in named volumes owned by the container's user, mode 0600:
// no key is ever baked into an image or bind-mounted from the host.
function seedVolumes() {
  const files = [
    ["maker", keyOf(1)],
    ["keeper", keyOf(8)],
    ["faucet", keyOf(5)],
  ] as const;
  const script = [
    "set -e",
    "mkdir -p /data/specs /data/evidence",
    "chown -R node:node /data",
    // Key files are owner-only (mode 0600), as the signer requires.
    "umask 177",
    ...files.map(([role]) => `printf %s "$KEY_${role}" > /keys/${role}.key`),
    "chown node:node /keys/*.key",
  ].join("\n");
  docker([
    "run",
    "--rm",
    "-u",
    "root",
    "--entrypoint",
    "sh",
    "-v",
    PROJECT_VOLUME("keys") + ":/keys",
    "-v",
    PROJECT_VOLUME("data") + ":/data",
    ...files.flatMap(([role, key]) => ["-e", `KEY_${role}=${key}`]),
    "blink-signer:local",
    "-c",
    script,
  ]);
}

// Evidence is imported on the host (the admin tool is not in any image) and copied into the data
// volume the API and the worker read.
function copyEvidenceToVolume(directory: string) {
  const archive = spawnSync("tar", ["-C", directory, "-cf", "-", "."], {
    maxBuffer: 1 << 26,
    // macOS tar would add AppleDouble "._" entries without this.
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  assert.equal(archive.status, 0, String(archive.stderr));
  const unpack = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "-u",
      "root",
      "--entrypoint",
      "sh",
      "-v",
      PROJECT_VOLUME("data") + ":/data",
      "blink-signer:local",
      "-c",
      "tar -x -C /data/evidence && chown -R node:node /data",
    ],
    { input: archive.stdout },
  );
  assert.equal(unpack.status, 0, String(unpack.stderr));
}

const sql = async <T = Record<string, unknown>>(
  pool: pg.Pool,
  text: string,
  values: unknown[] = [],
) => (await pool.query(text, values)).rows as T[];

function startAgent(config: Parameters<typeof runAgent>[0]) {
  const lines: string[] = [];
  let reached!: () => void;
  let failed!: (error: unknown) => void;
  const bought = new Promise<void>((resolve, reject) => {
    reached = resolve;
    failed = reject;
  });
  const result = runAgent({
    ...config,
    log(line) {
      lines.push(line);
      console.log("  agent: " + line);
      if (line.startsWith("position:")) reached();
    },
  });
  result.catch((error) =>
    failed(
      new Error(
        "SMOKE_AGENT_FAILED: " +
          (error instanceof Error ? error.message : String(error)) +
          " " +
          JSON.stringify((error as { body?: unknown }).body ?? "") +
          "\n" +
          lines.join("\n"),
        { cause: error },
      ),
    ),
  );
  return { bought, result };
}

// One REPLAY market through the normal path (the harness's flow, real time): evidence, discovery
// candidate, approval, creation transaction, indexing, forecast window, forecast runs and snapshot.
async function createMarket(
  owner: pg.Pool,
  chain: Chain,
  provisioned: Awaited<ReturnType<typeof provision>>,
) {
  const { keys } = provisioned;
  const entityId = "fixture-company-not-real";
  const sourceUrl = "https://fixture.example.test/image-smoke";
  const directory = await mkdtemp(join(tmpdir(), "blink-image-smoke-"));
  try {
    const source = await adapters
      .evidenceAdmin(hostPool("evidence"), adapters.fileObjectStore(directory))
      .allowSource(entityId, sourceUrl, "Offline fixture");
    await writeFile(
      join(directory, "metadata.json.in"),
      JSON.stringify({
        sourceId: source.sourceId,
        operatorId: keys.discovery.operatorId,
        publishedAt: null,
        accessPolicy: "PUBLIC",
        excerpt: null,
        reason: "Offline REPLAY fixture",
      }),
    );
    await writeFile(
      join(directory, "evidence.txt.in"),
      "Fixture gross margin is 60 percent. No real company or fetch.",
    );
    const imported = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/evidence-admin.ts",
        "import",
        "--metadata",
        join(directory, "metadata.json.in"),
        "--file",
        join(directory, "evidence.txt.in"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          EVIDENCE_ADMIN_DATABASE_URL: hostUrl("evidence"),
          EVIDENCE_OBJECT_DIRECTORY: directory,
        },
      },
    );
    assert.equal(imported.status, 0, imported.stderr);
    const evidenceId = JSON.parse(imported.stdout).evidenceId as string;
    await rm(join(directory, "metadata.json.in"));
    await rm(join(directory, "evidence.txt.in"));
    copyEvidenceToVolume(directory);

    const discovery = createBlinkClient(apiUrl(), keys.discovery.apiKey);
    const administrator = createBlinkClient(
      apiUrl(),
      keys.administrator.apiKey,
    );
    const candidate = (await discovery.createCandidate(
      {
        templateId: "GM_LT_V1",
        entityId,
        fiscalPeriod: "FY2025Q1",
        thresholdBps: 7000,
        evidenceIds: [evidenceId],
        thesis: "Image smoke REPLAY market",
      },
      randomUUID(),
    )) as { candidateId: string };

    // Approval wants a fresh verification of a deployment with trading still off. A forecaster
    // may only read evidence observed before its window opens (closeAt - 1.5 h, see the header),
    // so the shortest valid closeAt puts the window's opening just after the evidence import.
    await chain.register("Image smoke approval");
    const observedAt = BigInt(
      (
        await sql<{ at: string }>(
          owner,
          "SELECT floor(extract(epoch FROM observed_at))::bigint::text AS at FROM evidence.records WHERE id=$1",
          [evidenceId],
        )
      )[0]!.at,
    );
    const closeAt = observedAt + 5400n + 150n;
    const spec = {
      ...JSON.parse(await readFile("fixtures/replay/market-spec.json", "utf8")),
      schemaVersion: "blink.market.v0.1.1",
      entityId,
      sourceEvidenceIds: [evidenceId],
      sourceAllowlist: [sourceUrl],
      closeAt: String(closeAt),
      proposalDeadline: String(closeAt + 1000n),
      hardDeadline: String(closeAt + 4000n),
      resolutionPolicy: {
        hardDeadlineOutcome: "INVALID",
        unfinalizedProposalAtHardDeadline: "INVALID",
        invalidPayoutRule: "HALF_PER_SIDE_NOT_PURCHASE_REFUND",
        authorityModel: "TEAM_OPERATED_WHITELISTED_ROLES",
      },
    };
    const approval = (await administrator.approveCandidate(
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
    const intent = (await administrator.getCreationIntent(
      approval.creationIntentId,
    )) as { to: Address; calldata: `0x${string}` };
    const created = await chain.client.waitForTransactionReceipt({
      hash: await chain
        .wallet(admin!)
        .sendTransaction({ to: intent.to, data: intent.calldata }),
    });
    assert.equal(created.status, "success");
    const creation = await application
      .createCreationTracker(
        adapters.postgresCreationTrackerStore(hostPool("indexer")),
        adapters.creationReceiptReader(chain.client),
      )
      .reconcile(approval.creationIntentId, created.transactionHash);
    assert.equal(creation.state, "INCLUDED");
    const marketId = "1";

    // The indexer container ingests MarketCreated; trading goes on only after approval is done.
    const external = createBlinkClient(apiUrl(), keys.external.apiKey);
    await waitFor("market indexed by the indexer container", async () => {
      const list = await external.listMarkets({
        deploymentId: DEPLOYMENT,
        status: "OPEN",
      });
      return list.items.some((m) => m.marketId === marketId) ? true : null;
    });
    await owner.query(
      "UPDATE markets.deployments SET manifest = jsonb_set(manifest,'{tradingEnabled}','true') WHERE id=$1",
      [DEPLOYMENT],
    );
    chain.manifest.tradingEnabled = true;
    // The signer reads the deployment row once at start-up and refuses quotes (TRADING_DISABLED)
    // while its copy says trading is off, so turning trading on means restarting it.
    compose("restart", "signer");
    await waitFor("signer ready after restart", () => {
      const result = docker(
        [
          ...COMPOSE,
          "exec",
          "-T",
          "signer",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3004/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        { allowFailure: true },
      );
      return result.status === 0 ? true : null;
    });

    // Forecast window, then the three platform forecasts run by the worker container. The jobs
    // carry the key the worker's own forecast.dispatch would give them.
    await application
      .createWindowScheduler(adapters.postgresForecastStore(hostPool("worker")))
      .scheduleOnce();
    const window = (
      await sql<{ id: string; deadline: Date; open_at: Date }>(
        owner,
        "SELECT id,deadline,open_at FROM forecasts.windows WHERE market_id=$1 ORDER BY deadline DESC LIMIT 1",
        [marketId],
      )
    )[0];
    assert.ok(window, "the window scheduler planned a forecast window");
    const pastDatabaseTime = (at: Date, timeoutMs: number, what: string) =>
      waitFor(
        what,
        async () =>
          (
            await sql<{ past: boolean }>(
              owner,
              "SELECT blink.now() > $1 AS past",
              [at],
            )
          )[0]!.past
            ? true
            : null,
        timeoutMs,
      );
    await pastDatabaseTime(
      window.open_at,
      600_000,
      "the forecast window opening",
    );
    const queue = adapters.postgresJobQueue(hostPool("worker"));
    for (const role of ["FORECASTER_A", "FORECASTER_B", "BASELINE"] as const)
      await queue.enqueue({
        type: role === "BASELINE" ? "baseline.run" : "forecast.run",
        dedupeKey: `forecast.run:${window.id}:${role}`,
        payload: { windowId: window.id, role },
        maxAttempts: 2,
      });
    await waitFor(
      "three forecasts from the worker container",
      async () =>
        (
          await sql<{ n: number }>(
            owner,
            "SELECT count(*)::int AS n FROM forecasts.submissions WHERE window_id=$1",
            [window.id],
          )
        )[0]!.n === 3
          ? true
          : null,
      120_000,
    );
    // The snapshot exists once the window has closed: about 30 minutes after the evidence import.
    await pastDatabaseTime(
      window.deadline,
      2_400_000,
      "the forecast window deadline",
    );
    return { marketId, closeAt };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const started = Date.now();
  const owner = new pg.Pool({ connectionString: hostUrl("postgres"), max: 2 });
  try {
    compose("up", "-d", "--wait", "postgres", "anvil");
    const provisioned = await provision(owner);
    const { chain } = provisioned;
    // Creating (not starting) the services creates the volumes and builds any missing image.
    compose("up", "--no-start");
    seedVolumes();
    compose("up", "-d", "--wait", "signer", "api", "indexer", "worker");

    for (const service of ["signer", "api", "indexer", "worker"]) {
      const id = compose("ps", "-q", service).stdout.trim();
      const state = JSON.parse(docker(["inspect", id]).stdout)[0].State as {
        Status: string;
        Health: { Status: string };
      };
      assert.equal(state.Status, "running", service);
      assert.equal(state.Health.Status, "healthy", service);
      const user = docker(["exec", id, "id", "-u"]).stdout.trim();
      assert.notEqual(user, "0", service + " runs as root");
    }

    // Readiness is its own answer, per service: every enabled service reports ready. The API
    // stays 503 while the deployment row has trading switched off.
    for (const [service, port] of [
      ["signer", 3004],
      ["worker", 3002],
    ] as const)
      await waitFor(service + " ready", () =>
        inside(service, port, "/health/ready").status === 200 ? true : null,
      );
    const chainIndex = await waitFor("chain index health", async () => {
      const r = await fetch(
        `http://127.0.0.1:${ports.indexer}/health/chain-index`,
      );
      return r.status === 200 ? r.json() : null;
    });
    const config = (await (await fetch(apiUrl() + "/v1/config")).json()) as {
      chainId: number;
    };
    assert.equal(config.chainId, 84532);

    // The money path through the containers: the external agent binds its wallet and claims the
    // faucet; the API queues it, the worker asks the signer, the signer signs (oracle fee mode)
    // and the dispatched mint lands on chain.
    const external = createBlinkClient(
      apiUrl(),
      provisioned.keys.external.apiKey,
    );
    const challenge = await external.createWalletChallenge({
      address: taker!.address.toLowerCase(),
    });
    await external.verifyWallet({
      challengeId: challenge.challengeId,
      signature: await taker!.signMessage({ message: challenge.message }),
    });
    const balance = (who: Address) =>
      chain.client.readContract({
        address: chain.token,
        abi: blinkTestUsdAbi,
        functionName: "balanceOf",
        args: [who],
      }) as Promise<bigint>;
    assert.equal(await balance(taker!.address), 0n);
    // The claim is accepted once the indexer has ingested the allow-list event.
    await waitFor("faucet claim accepted", async () => {
      try {
        await external.claimFaucet({ deploymentId: DEPLOYMENT });
        return true;
      } catch {
        return null;
      }
    });
    await waitFor("faucet credit on chain", async () =>
      (await balance(taker!.address)) > 0n ? true : null,
    );
    console.log("IMAGES SMOKE faucet mint signed and landed");

    const { marketId, closeAt } = await createMarket(owner, chain, provisioned);
    console.log(`IMAGES SMOKE market ${marketId} forecast snapshot ready`);
    // Now the API can say it is ready for trading: database, signer probe, chain cursor, deployment.
    const health = await waitFor("api ready", async () => {
      const r = await fetch(apiUrl() + "/v1/health");
      return r.status === 200 ? r.json() : null;
    });
    assert.deepEqual(health, {
      status: "ready",
      tradingEnabled: true,
      reasons: [],
    });

    // The example agent against the containerized API: quote (the signer signs it), approve, fill.
    const agent = startAgent({
      apiUrl: apiUrl(),
      apiKey: provisioned.keys.external.apiKey,
      privateKey: keyOf(6) as `0x${string}`,
      rpcUrl: `http://127.0.0.1:${ports.anvil}`,
      pollMs: 250,
      waitMs: {
        faucet: 30_000,
        indexing: 60_000,
        // The default run stops after the purchase; --full waits for the keeper.
        final: FULL ? 4 * 3_600_000 : 1000,
        receipt: 30_000,
      },
    });
    await agent.bought;
    const position = (
      await sql<{ yes_shares: string; no_shares: string }>(
        owner,
        "SELECT yes_shares::text,no_shares::text FROM chain.positions WHERE market_id=$1 AND account=decode($2,'hex')",
        [marketId, taker!.address.slice(2)],
      )
    )[0];
    const onChain = (await chain.client.readContract({
      address: chain.market,
      abi: blinkMarketAbi,
      functionName: "getPosition",
      args: [BigInt(marketId), taker!.address],
    })) as readonly [bigint, bigint];
    assert.deepEqual(position, {
      yes_shares: String(onChain[0]),
      no_shares: String(onChain[1]),
    });
    assert.equal(onChain[0], 10n);
    console.log(
      "IMAGES SMOKE quote signed, fill landed, indexer ingested position: 10 YES shares",
    );

    if (FULL) {
      const boughtBalance = await balance(taker!.address);
      const chainNow = async () => (await chain.client.getBlock()).timestamp;
      console.log(
        `IMAGES SMOKE full: waiting ${Number(closeAt - (await chainNow()))} s for the market to close`,
      );
      await waitFor(
        "market close",
        async () => ((await chainNow()) > closeAt ? true : null),
        4 * 3_600_000,
      );
      await chain.send(
        proposer!,
        chain.market,
        blinkMarketAbi,
        "proposeOutcome",
        [BigInt(marketId), 0, hash("proposal image smoke")],
      );
      // The keeper job in the worker container finalizes after the 120 s challenge window:
      // worker -> signer (bearer token, keeper key) -> keeper send.
      const state = async () =>
        ["OPEN", "PROPOSED", "DISPUTED", "FINAL"][
          Number(
            (
              (await chain.client.readContract({
                address: chain.market,
                abi: blinkMarketAbi,
                functionName: "getMarket",
                args: [BigInt(marketId)],
              })) as { state: number }
            ).state,
          )
        ];
      await waitFor(
        "keeper finalization",
        async () => ((await state()) === "FINAL" ? true : null),
        600_000,
      );
      const rows = await sql(
        owner,
        "SELECT id FROM signing.economic_intents WHERE kind IN ('FINALIZE_UNCHALLENGED','FINALIZE_TIMEOUT') AND payload->>'marketId'=$1",
        [marketId],
      );
      assert.equal(rows.length, 1);
      const result = await agent.result;
      const makerBefore = await balance(maker!.address);
      await chain.send(maker!, chain.market, blinkMarketAbi, "redeem", [
        BigInt(marketId),
      ]);
      const paidTaker = (await balance(taker!.address)) - boughtBalance,
        paidMaker = (await balance(maker!.address)) - makerBefore;
      assert.equal(paidTaker, 10_000_000n);
      assert.equal(paidMaker, 0n);
      assert.equal(result.payoutMicros, "10000000");
      assert.equal(result.finalOutcome.length > 0, true);
      console.log(
        `IMAGES SMOKE full: keeper finalized, agent redeemed ${paidTaker} micro-bUSD, maker ${paidMaker}`,
      );
    } else await agent.result.catch(() => undefined);

    // No container log may carry a credential or a key.
    const logs = compose("logs", "--no-color").stdout;
    for (const value of [
      ...Object.values(passwords),
      ...Object.values(tokens),
      keyOf(1),
      keyOf(8),
      keyOf(5),
    ])
      assert.ok(
        !logs.includes(value),
        "a secret appears in the container logs",
      );

    console.log(
      `IMAGES SMOKE ok${FULL ? " (full)" : ""}: signer, api, indexer and worker healthy, non-root and ready; faucet and quote signed; market traded in the containers (chain index lag ${(chainIndex as { lagBlocks: string }).lagBlocks}, ${Math.round((Date.now() - started) / 1000)} s)`,
    );
  } catch (error) {
    // Keep the evidence of a failed run: the services' last lines, codes only by design.
    console.error(
      compose("logs", "--no-color", "--tail", "25", "api", "worker").stdout,
    );
    throw error;
  } finally {
    await Promise.allSettled([owner.end(), ...hostPools.map((p) => p.end())]);
    // SMOKE_KEEP=1 leaves the stack up for inspection after a failure.
    if (process.env.SMOKE_KEEP !== "1")
      compose("down", "-v", "--remove-orphans");
  }
}

await main();
