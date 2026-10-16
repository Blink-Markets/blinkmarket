import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { migratePostgres } from "../packages/adapters/src/migrations.js";
import { deployContracts } from "../packages/adapters/src/contract-deployer.js";
import { registerVerifiedDeployment } from "../packages/adapters/src/deployment-registry.js";
import { identityAdmin } from "../packages/adapters/src/identity-admin.js";
import { createBlinkClient } from "../packages/client/src/index.js";
import {
  blinkMarketAbi,
  blinkTestUsdAbi,
} from "../packages/adapters/src/blink-abi.js";

// Opt-in container smoke (`pnpm images:smoke`): the four service images, configured as a deployment
// would configure them, against a PostgreSQL and an Anvil (chain ID 84532) started by
// infra/compose.alpha.yaml. Test keys only; nothing leaves this machine. It proves each container
// starts with real least-privilege logins, reads its key files, reaches its peers and reports ready.
// It does not run a market: the worker refuses a shifted business clock, so the settlement
// scenarios stay in `pnpm alpha:local` (see docs/M5_SERVICE_IMAGES.md).
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
  const result = spawnSync("docker", args, { env, encoding: "utf8" });
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

let chain!: Awaited<ReturnType<typeof deploy>>;
async function provision() {
  const admin = new pg.Pool({
    connectionString: `postgresql://blink:${passwords.postgres}@127.0.0.1:${ports.postgres}/blink`,
    max: 2,
  });
  try {
    await migratePostgres(
      `postgresql://blink:${passwords.postgres}@127.0.0.1:${ports.postgres}/blink`,
    );
    // One ordinary login per service, in exactly its own group; the registration login is not
    // handed to any container.
    for (const [role, group] of [
      ["api", "blink_api"],
      ["worker", "blink_worker"],
      ["indexer", "blink_indexer"],
      ["signer", "blink_signer"],
      ["deployment", "blink_deployment_admin"],
      ["identity", "blink_identity_admin"],
    ] as const)
      await admin.query(
        `CREATE ROLE "smoke_${role}" LOGIN PASSWORD '${passwords[role]}' IN ROLE ${group}`,
      );
    const registrar = new pg.Pool({
      connectionString: `postgresql://smoke_deployment:${passwords.deployment}@127.0.0.1:${ports.postgres}/blink`,
      max: 1,
    });
    try {
      chain = await deploy(registrar);
    } finally {
      await registrar.end();
    }
    // The harness turns trading on the same way for its scenarios: the manifest row is the switch.
    await admin.query(
      "UPDATE markets.deployments SET manifest = jsonb_set(manifest,'{tradingEnabled}','true') WHERE id=$1",
      [DEPLOYMENT],
    );
  } finally {
    await admin.end();
  }
}

// The same test mnemonic the harness uses; these accounts exist only on this Anvil.
const mnemonic = "test test test test test test test test test test test junk";
const account = (addressIndex: number) =>
  mnemonicToAccount(mnemonic, { addressIndex });
const keyOf = (index: number) =>
  "0x" + Buffer.from(account(index).getHdKey().privateKey!).toString("hex");

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
    pollingInterval: 50,
  });
  const wallet = (who: ReturnType<typeof account>) =>
    createWalletClient({ account: who, chain, transport: http(url) });
  const [admin, maker, proposer, challenger, arbiter, minter] = [
    0, 1, 2, 3, 4, 5,
  ].map(account);
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
      challenger: challenger!.address,
      arbiter: arbiter!.address,
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
  await registerVerifiedDeployment(
    registrar,
    manifest,
    DEPLOYMENT,
    client,
    abis,
    "Image smoke Anvil",
  );
  // Fund the maker pool like the harness does, so the signer's reservation check has a pool to read.
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
  await send(minter!, token, blinkTestUsdAbi, "mint", [
    maker!.address,
    1_000_000_000n,
  ]);
  await send(maker!, token, blinkTestUsdAbi, "approve", [
    market,
    1_000_000_000n,
  ]);
  await send(maker!, market, blinkMarketAbi, "depositMaker", [1_000_000_000n]);
  // The taker used for the faucet step must be allow-listed on the market contract.
  await send(admin!, market, blinkMarketAbi, "setTakerAllowed", [
    account(6).address,
    true,
  ]);
  return { client, token };
}

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
    "umask 177",
    ...files.map(([role]) => `printf %s "$KEY_${role}" > /keys/${role}.key`),
    "chown node:node /keys/*.key",
    "mkdir -p /data/specs /data/evidence",
    "chown -R node:node /data",
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

async function main() {
  try {
    compose("up", "-d", "--wait", "postgres", "anvil");
    await provision();
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

    // Readiness is its own answer, per service: every enabled service reports ready.
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
    // The public readiness decision is made inside the API container from the database, the
    // signer probe, the chain cursor and the deployment row.
    const health = await waitFor("api ready", async () => {
      const r = await fetch(`http://127.0.0.1:${ports.api}/v1/health`);
      return r.status === 200 ? r.json() : null;
    });
    assert.deepEqual(health, {
      status: "ready",
      tradingEnabled: true,
      reasons: [],
    });
    const config = (await (
      await fetch(`http://127.0.0.1:${ports.api}/v1/config`)
    ).json()) as { chainId: number };
    assert.equal(config.chainId, 84532);

    // The money path through the containers: an invited agent binds its wallet and claims the
    // faucet; the API queues it, the worker asks the signer, the signer signs (oracle fee mode)
    // and the dispatched mint lands on chain.
    const identity = new pg.Pool({
      connectionString: `postgresql://smoke_identity:${passwords.identity}@127.0.0.1:${ports.postgres}/blink`,
      max: 1,
    });
    let invited;
    try {
      invited = await identityAdmin(identity).invite({
        operatorName: "smoke",
        agentName: "smoke",
        scopes: ["faucet:claim"],
        reason: "image smoke fixture",
      });
    } finally {
      await identity.end();
    }
    const taker = account(6);
    const agent = createBlinkClient(
      `http://127.0.0.1:${ports.api}`,
      invited.apiKey,
    );
    const challenge = await agent.createWalletChallenge({
      address: taker.address.toLowerCase(),
    });
    await agent.verifyWallet({
      challengeId: challenge.challengeId,
      signature: await taker.signMessage({ message: challenge.message }),
    });
    const balance = () =>
      chain.client.readContract({
        address: chain.token,
        abi: blinkTestUsdAbi,
        functionName: "balanceOf",
        args: [taker.address],
      }) as Promise<bigint>;
    assert.equal(await balance(), 0n);
    // The claim is accepted once the indexer has ingested the allow-list event.
    await waitFor("faucet claim accepted", async () => {
      try {
        await agent.claimFaucet({ deploymentId: DEPLOYMENT });
        return true;
      } catch {
        return null;
      }
    });
    await waitFor("faucet credit on chain", async () =>
      (await balance()) > 0n ? true : null,
    );

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
      "IMAGES SMOKE ok: signer, api, indexer and worker healthy, non-root and ready, faucet mint signed and landed (chain index lag " +
        (chainIndex as { lagBlocks: string }).lagBlocks +
        ")",
    );
  } finally {
    compose("down", "-v", "--remove-orphans");
  }
}

await main();
