import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withDatabase } from "../helpers/postgres-database.js";
import {
  privateKeyOf,
  seedChain,
  seedDeployment,
  sha256Hex,
  testAccounts,
  testManifest,
} from "../helpers/signer-fixture.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const TOKEN = "process-token";

// A JSON-RPC stub that only knows the chain id, with a switch to make it unreachable.
async function rpcStub() {
  const state = { up: true };
  const server: Server = createServer((request, response) => {
    if (!state.up) return void request.socket.destroy();
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          method === "eth_chainId"
            ? { jsonrpc: "2.0", id, result: "0x14a34" }
            : { jsonrpc: "2.0", id, error: { code: -32601, message: "no" } },
        ),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    state,
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function freePort() {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

function startSigner(env: Record<string, string>) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/signer/src/main.ts"],
    { cwd: root, env: { PATH: process.env.PATH!, ...env } },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  return { child, exited, stderr: () => stderr };
}

async function waitLive(port: number, exited: Promise<number | null>) {
  let done = false;
  void exited.then(() => (done = true));
  for (let i = 0; i < 300 && !done; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health/live`)).ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test(
  "real PostgreSQL: the signer process refuses a shifted business clock and reports truthful readiness",
  { timeout: 120000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "blink-signer-process-"));
    const rpc = await rpcStub();
    try {
      await withDatabase(async ({ name, owner, login }) => {
        const manifest = testManifest();
        await seedDeployment(owner, manifest);
        await seedChain(owner, { deploymentId: manifest.deploymentId });
        const keyFile = join(directory, "maker.key");
        await writeFile(keyFile, privateKeyOf(testAccounts.maker));
        await chmod(keyFile, 0o600);
        const signerPool = await login({ max: 1 });
        const base = (port: number) => ({
          SIGNER_ENABLED: "true",
          SIGNER_PORT: String(port),
          SIGNER_DATABASE_URL: signerPool.options.connectionString!,
          BASE_SEPOLIA_RPC_URL: rpc.url,
          SIGNER_L1_FEE_MODE: "local-none",
          SIGNER_DEPLOYMENT_ID: manifest.deploymentId,
          SIGNER_CALLERS: JSON.stringify([
            { name: "api", tokenSha256: sha256Hex(TOKEN), roles: ["maker"] },
          ]),
          SIGNER_MAKER_KEY_FILE: keyFile,
        });

        // A database whose business clock is shifted is refused unless local test mode says so.
        await owner.query(
          `ALTER DATABASE "${name}" SET blink.test_clock_offset_seconds = '3600'`,
        );
        const shifted = startSigner(base(await freePort()));
        assert.equal(await shifted.exited, 1);
        assert.equal(shifted.stderr(), "TEST_CLOCK_FORBIDDEN\n");
        const allowedPort = await freePort();
        const allowed = startSigner({
          ...base(allowedPort),
          BLINK_ALLOW_TEST_CLOCK: "1",
        });
        try {
          assert.equal(await waitLive(allowedPort, allowed.exited), true);
        } finally {
          allowed.child.kill("SIGTERM");
          await allowed.exited;
        }
        await owner.query(
          `ALTER DATABASE "${name}" RESET blink.test_clock_offset_seconds`,
        );

        // Ready means the dependencies answer right now, not merely that startup once passed.
        const port = await freePort();
        const signer = startSigner(base(port));
        try {
          assert.equal(
            await waitLive(port, signer.exited),
            true,
            signer.stderr(),
          );
          const ready = async () =>
            (await fetch(`http://127.0.0.1:${port}/health/ready`)).status;
          assert.equal(await ready(), 200);
          await owner.query("UPDATE markets.deployments SET enabled = false");
          assert.equal(
            await ready(),
            503,
            "a disabled deployment is not ready",
          );
          await owner.query("UPDATE markets.deployments SET enabled = true");
          assert.equal(await ready(), 200);
          rpc.state.up = false;
          assert.equal(await ready(), 503, "an unreachable RPC is not ready");
          rpc.state.up = true;
          assert.equal(await ready(), 200);
          const user = new URL(signerPool.options.connectionString!).username;
          await owner.query(
            `ALTER ROLE "${user}" SET blink.test_clock_offset_seconds = '3600'`,
          );
          await owner.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND pid<>pg_backend_pid()",
            [name, user],
          );
          assert.equal(
            await ready(),
            503,
            "a replacement session with a shifted clock is not ready",
          );
          assert.equal(
            signer.stderr().includes("at "),
            false,
            "no stack on stderr",
          );
        } finally {
          signer.child.kill("SIGTERM");
          await signer.exited;
        }
      });
    } finally {
      await rpc.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
