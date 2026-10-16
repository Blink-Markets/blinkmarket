import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, Agent, request } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  attemptAll,
  runChild,
  runWithCleanup,
  shutDownServer,
} from "./helpers/lifecycle.js";

const never = () => new Promise<never>(() => {});
const aggregateFailure = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof AggregateError, String(error));
    return error;
  }
  return assert.fail("expected the run to reject");
};

test("every cleanup step is attempted even when earlier ones reject, throw or hang", async () => {
  const ran: string[] = [];
  const failures = await attemptAll(
    [
      {
        name: "worker",
        run: async () => {
          ran.push("worker");
          throw new Error("worker stuck");
        },
      },
      {
        name: "api",
        run: () => {
          ran.push("api");
          return never();
        },
      },
      {
        name: "signer",
        run: () => {
          ran.push("signer");
          throw new Error("sync failure");
        },
      },
      { name: "anvil", run: async () => void ran.push("anvil") },
    ],
    50,
  );
  assert.deepEqual(ran, ["worker", "api", "signer", "anvil"]);
  assert.deepEqual(
    failures.map((failure) => failure.message),
    [
      "worker: worker stuck",
      "api: timed out after 50 ms",
      "signer: sync failure",
    ],
  );
});

test("a rejecting stopper does not skip the others and the scenario error stays first", async () => {
  const stopped: string[] = [];
  const stopper =
    (name: string, fail = false) =>
    async () => {
      stopped.push(name);
      if (fail) throw new Error(name + " close failed");
    };
  const error = await aggregateFailure(
    runWithCleanup({}, async (life) => {
      life.add("directory", stopper("directory"));
      life.add("anvil", stopper("anvil"));
      life.add("signer", stopper("signer"));
      life.add("api", stopper("api", true));
      life.add("worker", stopper("worker", true));
      throw new Error("scenario failed");
    }),
  );
  assert.deepEqual(stopped, ["worker", "api", "signer", "anvil", "directory"]);
  assert.deepEqual(
    error.errors.map((e: Error) => e.message),
    ["scenario failed", "worker: worker close failed", "api: api close failed"],
  );
  assert.match(error.message, /^scenario failed; LIFECYCLE_CLEANUP_FAILED: /);
});

test("cleanup failures after a successful body are reported, not swallowed", async () => {
  const stopped: string[] = [];
  const error = await aggregateFailure(
    runWithCleanup({}, async (life) => {
      life.add("first", async () => void stopped.push("first"));
      life.add("second", async () => {
        throw new Error("second failed");
      });
      return "done";
    }),
  );
  assert.deepEqual(stopped, ["first"]);
  assert.deepEqual(
    error.errors.map((e: Error) => e.message),
    ["second: second failed"],
  );
});

test("a clean run returns its value and a lone body error is rethrown unchanged", async () => {
  assert.equal(await runWithCleanup({}, async () => 42), 42);
  const failure = new Error("only the body");
  await assert.rejects(
    runWithCleanup({}, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});

test("an aborted run stops waiting, tears every resource down and says where it stalled", async () => {
  const controller = new AbortController();
  const stopped: string[] = [];
  const started = Date.now();
  const run = runWithCleanup(
    { signal: controller.signal, stepTimeoutMs: 100 },
    async (life) => {
      life.add("server", () => void stopped.push("server"));
      life.add("worker", async () => void stopped.push("worker"));
      life.stage("scenario dispute");
      await never(); // a stalled database query
    },
  );
  setTimeout(() => controller.abort(new Error("deadline reached")), 20);
  await assert.rejects(
    run,
    /^Error: LIFECYCLE_ABORTED during scenario dispute: deadline reached$/,
  );
  assert.deepEqual(stopped, ["worker", "server"]);
  assert.ok(Date.now() - started < 2000);
});

test("a resource still being created when the run is aborted is released once it exists", async () => {
  const controller = new AbortController();
  let created!: (resource: string) => void;
  const creation = new Promise<string>((resolve) => (created = resolve));
  let released: string | undefined;
  const run = runWithCleanup({ signal: controller.signal }, async (life) => {
    await life.acquire(
      "anvil",
      () => creation,
      (resource) => void (released = resource),
    );
  });
  setTimeout(() => controller.abort(new Error("deadline reached")), 10);
  setTimeout(() => created("anvil process"), 60);
  await assert.rejects(run, /LIFECYCLE_ABORTED/);
  // The run does not settle before the late resource is released.
  assert.equal(released, "anvil process");
});

test("a failed creation is the body's error, not a cleanup failure", async () => {
  await assert.rejects(
    runWithCleanup({}, async (life) => {
      await life.acquire(
        "anvil",
        async () => {
          throw new Error("anvil did not start");
        },
        () => assert.fail("nothing to stop"),
      );
    }),
    (error) =>
      error instanceof Error && error.message === "anvil did not start",
  );
});

test("an abandoned body can start nothing once teardown has begun", async () => {
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const late: unknown[] = [];
  let created = false;
  const run = runWithCleanup({ signal: controller.signal }, async (life) => {
    await gate;
    for (const attempt of [
      async () => life.add("late shutdown", () => {}),
      () =>
        life.acquire(
          "late resource",
          async () => void (created = true),
          () => {},
        ),
    ])
      await attempt().catch((error) => late.push(error));
  });
  controller.abort(new Error("deadline reached"));
  await assert.rejects(run, /LIFECYCLE_ABORTED/);
  release();
  await delay(20);
  assert.deepEqual(
    late.map((error) => (error as Error).message),
    ["LIFECYCLE_CLOSED: late shutdown", "LIFECYCLE_CLOSED: late resource"],
  );
  assert.equal(created, false);
});

test("an already aborted signal never starts the body", async () => {
  let started = false;
  await assert.rejects(
    runWithCleanup(
      { signal: AbortSignal.abort(new Error("too late")) },
      async () => {
        started = true;
      },
    ),
    /LIFECYCLE_ABORTED during start: too late/,
  );
  assert.equal(started, false);
});

const stalledChild = async (pidFile: string, ignoreTerm = false) => [
  "-e",
  (ignoreTerm ? "process.on('SIGTERM', () => {});" : "") +
    "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
  pidFile,
];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a stalled child process is killed at its timeout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blink-lifecycle-"));
  try {
    const pidFile = join(directory, "pid");
    await assert.rejects(
      runChild("evidence import", await stalledChild(pidFile), {
        timeoutMs: 1000,
      }),
      /LIFECYCLE_CHILD_TIMEOUT: evidence import timed out after 1000 ms/,
    );
    assert.equal(alive(Number(await readFile(pidFile, "utf8"))), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stalled child process is killed when the run is aborted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blink-lifecycle-"));
  try {
    const pidFile = join(directory, "pid");
    const controller = new AbortController();
    const child = runChild("evidence import", await stalledChild(pidFile), {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    const rejected = assert.rejects(
      child,
      /LIFECYCLE_CHILD_ABORTED: evidence import cancelled/,
    );
    let pid = "";
    for (let n = 0; n < 200 && !pid; n++) {
      pid = await readFile(pidFile, "utf8").catch(() => "");
      if (!pid) await delay(25);
    }
    assert.ok(pid, "child started");
    controller.abort(new Error("deadline reached"));
    await rejected;
    assert.equal(alive(Number(pid)), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a child that ignores SIGTERM is still killed at its timeout and on abort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blink-lifecycle-"));
  try {
    const timedOut = join(directory, "timeout.pid");
    await assert.rejects(
      runChild("stubborn import", await stalledChild(timedOut, true), {
        timeoutMs: 1000,
      }),
      /LIFECYCLE_CHILD_TIMEOUT/,
    );
    assert.equal(alive(Number(await readFile(timedOut, "utf8"))), false);

    const abortedPid = join(directory, "abort.pid");
    const controller = new AbortController();
    const child = runChild(
      "stubborn import",
      await stalledChild(abortedPid, true),
      { timeoutMs: 30_000, signal: controller.signal },
    );
    const rejected = assert.rejects(child, /LIFECYCLE_CHILD_ABORTED/);
    let pid = "";
    for (let n = 0; n < 200 && !pid; n++) {
      pid = await readFile(abortedPid, "utf8").catch(() => "");
      if (!pid) await delay(25);
    }
    assert.ok(pid, "child started");
    controller.abort(new Error("deadline reached"));
    const aborted = Date.now();
    await rejected;
    assert.ok(Date.now() - aborted < 5000, "abort does not wait for SIGTERM");
    assert.equal(alive(Number(pid)), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shutting a server down does not wait for open connections or requests in flight", async () => {
  const keepAlive = new Agent({ keepAlive: true });
  const server = createServer((req, res) => {
    // /hang never answers, as a request an aborted run left in flight.
    if (req.url !== "/hang") res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const get = (path: string) =>
    new Promise<string>((resolve, reject) => {
      request({ port, host: "127.0.0.1", path, agent: keepAlive }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      })
        .on("error", reject)
        .end();
    });
  try {
    assert.equal(await get("/"), "ok"); // leaves a keep-alive connection open
    const hanging = get("/hang");
    const rejected = assert.rejects(hanging);
    await delay(50);
    const started = Date.now();
    await shutDownServer({
      close: () => new Promise((resolve) => server.close(resolve)),
      server,
    });
    assert.ok(Date.now() - started < 2000);
    await rejected;
  } finally {
    keepAlive.destroy();
    server.closeAllConnections();
  }
});
