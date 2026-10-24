import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  type Abi,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { migratePostgres } from "../packages/adapters/src/migrations.js";
import { deployContracts } from "../packages/adapters/src/contract-deployer.js";
import { registerVerifiedDeployment } from "../packages/adapters/src/deployment-registry.js";
import * as adapters from "../packages/adapters/src/index.js";
import {
  FORECAST_PROMPTS,
  type PlatformRole,
} from "../packages/domain/src/index.js";
// Opt-in smoke for the three infrastructure images against local PostgreSQL and Anvil.
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
const passwords = {
  postgres: secret(),
  api: secret(),
  worker: secret(),
  indexer: secret(),
  deployment: secret(),
  identity: secret(),
  evidence: secret(),
};
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
  ALPHA_PLATFORM_OPERATOR_ID: "set-after-provisioning",
  ALPHA_FORECASTER_A_KEY: "set-after-provisioning",
  ALPHA_FORECASTER_B_KEY: "set-after-provisioning",
  ALPHA_BASELINE_KEY: "set-after-provisioning",
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
  const manifest = await deployContracts({
    client,
    wallet: wallet(account(9)),
    roles: {
      admin: account(0).address,
      maker: account(1).address,
      resultProposer: account(2).address,
      challenger: account(3).address,
      arbiter: account(4).address,
      faucetMinter: account(5).address,
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
  return { client, manifest };
}

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
    external: await invite("external", ["forecast:write", "trade:quote"]),
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

// Only evidence/spec directories are mounted into the service containers.
function seedVolumes() {
  docker([
    "run",
    "--rm",
    "-u",
    "root",
    "--entrypoint",
    "sh",
    "-v",
    PROJECT_VOLUME("data") + ":/data",
    "blink-api:local",
    "-c",
    "mkdir -p /data/specs /data/evidence && chown -R node:node /data",
  ]);
}

async function main() {
  const owner = new pg.Pool({ connectionString: hostUrl("postgres"), max: 2 });
  try {
    compose("up", "-d", "--wait", "postgres", "anvil");
    await provision(owner);
    // Always rebuild from the working tree: an existing blink-<service>:local tag may come from an
    // older commit, and Compose would otherwise reuse it. Docker's layer cache keeps this cheap.
    compose("build");
    // Creating (not starting) the services creates the volumes.
    compose("up", "--no-start");
    seedVolumes();
    compose("up", "-d", "--wait", "api", "indexer", "worker");

    for (const service of ["api", "indexer", "worker"]) {
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

    // Each enabled infrastructure service reports its own readiness.
    for (const [service, port] of [["worker", 3002]] as const)
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

    await waitFor("API infrastructure ready", async () => {
      const response = await fetch(apiUrl() + "/health/ready");
      return response.status === 200 ? true : null;
    });
    const publicConfig = (await (
      await fetch(apiUrl() + "/v1/config")
    ).json()) as { tradingEnabled: boolean };
    assert.equal(publicConfig.tradingEnabled, false);
    for (const path of ["/v1/rfqs", "/v1/faucet/claims"]) {
      const response = await fetch(apiUrl() + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 404);
    }

    // No container log may carry a credential or a key.
    const logs = compose("logs", "--no-color").stdout;
    for (const value of Object.values(passwords))
      assert.ok(
        !logs.includes(value),
        "a secret appears in the container logs",
      );

    console.log(
      `IMAGES SMOKE ok: api, indexer and worker healthy, non-root and ready; chain index lag ${(chainIndex as { lagBlocks: string }).lagBlocks}`,
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
