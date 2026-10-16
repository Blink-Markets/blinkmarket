import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// Opt-in: builds the four service images, so it needs a Docker daemon (and the network for
// `pnpm install` inside the build). Run it with `pnpm test:images`; the default checks never do.
const docker = (args, options = {}) =>
  spawnSync("docker", args, { encoding: "utf8", ...options });
const hasDocker =
  docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const skip = hasDocker ? false : "Docker daemon not available";

const services = {
  // The entry's refusal when a service is switched on without its configuration.
  api: {
    env: { BLINK_API_MODE: "identity" },
    code: "IDENTITY_CONFIGURATION_REQUIRED",
  },
  worker: {
    env: { WORKER_ENABLED: "true" },
    code: "WORKER_CONFIGURATION_REQUIRED",
  },
  indexer: {
    env: { INDEXER_CREATION_POLLING_ENABLED: "true" },
    code: "INDEXER_TRACKER_CONFIGURATION_REQUIRED",
  },
  signer: {
    env: { SIGNER_ENABLED: "true" },
    code: "SIGNER_CONFIGURATION_REQUIRED",
  },
};
const image = (name) => "blink-" + name + ":test";
const run = (name, env = {}, extra = []) =>
  docker([
    "run",
    "--rm",
    ...Object.entries(env).flatMap(([k, v]) => ["-e", k + "=" + v]),
    ...extra,
    image(name),
  ]);
const inspect = (name) =>
  JSON.parse(docker(["image", "inspect", image(name)]).stdout)[0];

before(
  () => {
    if (!hasDocker) return;
    for (const name of Object.keys(services)) {
      const build = docker(
        ["build", "-f", "infra/Dockerfile." + name, "-t", image(name), "."],
        { maxBuffer: 1 << 28 },
      );
      assert.equal(
        build.status,
        0,
        name + " build failed:\n" + build.stderr.slice(-2000),
      );
    }
  },
  { timeout: 1_200_000 },
);

for (const name of Object.keys(services)) {
  test(name + " image runs as a non-root user", { skip }, () => {
    assert.equal(inspect(name).Config.User, "node");
    const id = docker(["run", "--rm", "--entrypoint", "id", image(name), "-u"]);
    assert.equal(id.status, 0, id.stderr);
    assert.notEqual(id.stdout.trim(), "0");
  });

  test(
    name + " image holds only its bundle and no secret or source",
    { skip },
    () => {
      const listing = docker([
        "run",
        "--rm",
        "--entrypoint",
        "find",
        image(name),
        "/app",
        "-mindepth",
        "1",
      ]);
      assert.equal(listing.status, 0, listing.stderr);
      // The runtime layer is exactly the service's own bundle.
      assert.deepEqual(listing.stdout.trim().split("\n"), [
        "/app/" + name + ".mjs",
      ]);
      const everywhere = docker([
        "run",
        "--rm",
        "--entrypoint",
        "find",
        image(name),
        "/",
        "-xdev",
        "(",
        "-name",
        ".env",
        "-o",
        "-name",
        ".env.*",
        "-o",
        "-name",
        "*.key",
        "-o",
        "-name",
        "*.pem",
        "-o",
        "-path",
        "*/contracts/artifacts*",
        "-o",
        "-path",
        "/repo*",
        "-o",
        "-path",
        "*/node_modules*",
        // No package manager at runtime: npm, corepack and yarn are removed from the filesystem.
        "-o",
        "-name",
        "npm",
        "-o",
        "-name",
        "npx",
        "-o",
        "-name",
        "corepack",
        "-o",
        "-name",
        "yarn*",
        ")",
      ]);
      // find exits 1 for the directories the node user cannot read; any other status is a failed scan.
      assert.ok(everywhere.status <= 1, everywhere.stderr);
      assert.equal(everywhere.stdout.trim(), "");
      // Nothing in the bundle or the image configuration looks like key material or a credential.
      const bundle = docker(
        [
          "run",
          "--rm",
          "--entrypoint",
          "cat",
          image(name),
          "/app/" + name + ".mjs",
        ],
        {
          maxBuffer: 1 << 28,
        },
      );
      assert.equal(bundle.status, 0, bundle.stderr);
      assert.doesNotMatch(bundle.stdout, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      assert.doesNotMatch(
        bundle.stdout,
        /ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80/i,
      );
      const config = inspect(name).Config;
      assert.doesNotMatch(
        JSON.stringify(config.Env),
        /(KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|RPC_URL)=/,
      );
      const history = docker([
        "history",
        "--no-trunc",
        "--format",
        "{{.CreatedBy}}",
        image(name),
      ]);
      assert.doesNotMatch(
        history.stdout,
        /--build-arg|\s\.env\b|\.key\b|COPY \.env/,
      );
    },
  );

  test(name + " entry fails closed without configuration", { skip }, () => {
    const { env, code } = services[name];
    const result = run(name, env);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(code));
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find package/);
  });

  test(
    name + " healthcheck uses /health/live and the stub reports healthy",
    { skip, timeout: 120_000 },
    async () => {
      const test = inspect(name).Config.Healthcheck.Test.join(" ");
      assert.match(test, /\/health\/live/);
      assert.doesNotMatch(test, /\/health\/ready/);
      const started = docker([
        "run",
        "-d",
        "--rm",
        "--health-interval=1s",
        image(name),
      ]);
      assert.equal(started.status, 0, started.stderr);
      const id = started.stdout.trim();
      try {
        let status = "";
        for (let n = 0; n < 60 && status !== "healthy"; n++) {
          await delay(1000);
          status = docker([
            "inspect",
            "--format",
            "{{.State.Health.Status}}",
            id,
          ]).stdout.trim();
        }
        assert.equal(status, "healthy", docker(["logs", id]).stdout);
        // Readiness stays a separate answer: an unconfigured service is alive but not ready.
        const ready = docker([
          "exec",
          id,
          "node",
          "-e",
          "fetch('http://127.0.0.1:'+(process.env.API_PORT||process.env.INDEXER_PORT||process.env.SIGNER_PORT||'3002')+'/health/ready').then(r=>console.log(r.status))",
        ]);
        assert.equal(ready.stdout.trim(), "503", ready.stderr);
      } finally {
        docker(["rm", "-f", id]);
      }
    },
  );
}
