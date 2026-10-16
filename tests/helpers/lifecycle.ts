import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const STEP_TIMEOUT_MS = 10_000;

export interface Step {
  name: string;
  run: () => unknown;
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Attempts every step in order; one that rejects, throws or hangs never skips the rest.
export async function attemptAll(
  steps: Step[],
  stepTimeoutMs = STEP_TIMEOUT_MS,
): Promise<Error[]> {
  const failures: Error[] = [];
  for (const step of steps) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(step.run),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${stepTimeoutMs} ms`)),
            stepTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      failures.push(
        new Error(`${step.name}: ${describe(error)}`, { cause: error }),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return failures;
}

// Throws the original failure alone when cleanup was clean; otherwise an AggregateError
// that lists the original failure first and every cleanup failure after it.
export function settle(
  outcome: { error: unknown } | undefined,
  failures: Error[],
): void {
  if (failures.length === 0) {
    if (outcome) throw outcome.error;
    return;
  }
  throw new AggregateError(
    outcome ? [outcome.error, ...failures] : failures,
    (outcome ? describe(outcome.error) + "; " : "") +
      "LIFECYCLE_CLEANUP_FAILED: " +
      failures.map((failure) => failure.message).join("; "),
  );
}

// Awaits `work`, then attempts to stop what ran beside it. A stopper that fails never replaces
// the work's own failure: both are reported, the work's first.
export async function stopAfter<T>(
  work: Promise<T>,
  name: string,
  stop: () => unknown,
): Promise<T> {
  let outcome: { error: unknown } | undefined;
  let value: T | undefined;
  try {
    value = await work;
  } catch (error) {
    outcome = { error };
  }
  settle(outcome, await attemptAll([{ name, run: stop }]));
  return value as T;
}

export interface Lifecycle {
  // Aborts when the caller's signal does and when `fail` is called.
  readonly signal: AbortSignal;
  // Registers a shutdown for something that already exists. Shutdowns run in reverse
  // registration order. Throws once teardown has begun: an abandoned body starts nothing new.
  add(name: string, stop: () => unknown): void;
  // Creates a resource and registers its shutdown before the creation finishes, so an abort
  // that lands mid-creation still waits for the resource and releases it.
  acquire<R>(
    name: string,
    create: () => Promise<R>,
    stop: (resource: R) => unknown,
  ): Promise<R>;
  // Names what the run is doing, for the abort message.
  stage(name: string): void;
  // Ends the run now with `error`, as an abort does: the body is abandoned, the shutdowns run
  // and the run rejects with LIFECYCLE_ABORTED during <stage>: <error>. For failures of work
  // that runs beside the body, which the body would otherwise learn of only when stopping it.
  fail(error: unknown): void;
  // Repeats `step` every `intervalMs`, first at once, until the returned stop is called or the
  // run ends (stopping early is optional; the shutdown is registered). A step that fails while
  // it should be running ends the run through `fail`. One that fails while `stop` waits for
  // it is thrown by that `stop`. Each failure is reported once.
  every(
    name: string,
    intervalMs: number,
    step: () => Promise<unknown>,
  ): () => Promise<void>;
}

// Runs `body`, then every registered shutdown, whatever happened. When `signal` aborts the
// body is abandoned (it may be stalled on an await no one can cancel), the shutdowns run, and
// the run rejects with the stage it was in. `onStage` hears each stage as the body names it.
export async function runWithCleanup<T>(
  options: {
    signal?: AbortSignal;
    stepTimeoutMs?: number;
    onStage?: ((stage: string) => void) | undefined;
  },
  body: (life: Lifecycle) => Promise<T>,
): Promise<T> {
  const failure = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, failure.signal])
    : failure.signal;
  const stepTimeoutMs = options.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  let stage = "start";
  const abortError = () =>
    new Error(`LIFECYCLE_ABORTED during ${stage}: ${describe(signal.reason)}`, {
      cause: signal.reason,
    });
  if (signal.aborted) throw abortError();
  const steps: Step[] = [];
  let closed = false;
  const life: Lifecycle = {
    signal,
    add(name, run) {
      if (closed) throw new Error("LIFECYCLE_CLOSED: " + name);
      steps.push({ name, run });
    },
    async acquire(name, create, stop) {
      if (closed) throw new Error("LIFECYCLE_CLOSED: " + name);
      const pending = create();
      steps.push({
        name,
        run: async () => {
          // A failed creation is the body's error, not a cleanup failure.
          const created = await pending.then(
            (resource) => ({ resource }),
            () => undefined,
          );
          if (created) await stop(created.resource);
        },
      });
      return pending;
    },
    stage(name) {
      stage = name;
      options.onStage?.(name);
    },
    fail(error) {
      failure.abort(error);
    },
    every(name, intervalMs, step) {
      if (closed) throw new Error("LIFECYCLE_CLOSED: " + name);
      let running = true;
      let late: { error: unknown } | undefined;
      const loop = (async () => {
        try {
          while (running && !signal.aborted) {
            await step();
            await delay(intervalMs);
          }
        } catch (error) {
          // A step that fails because the run was aborted is not a failure of its own.
          if (signal.aborted) return;
          if (running && !closed)
            life.fail(
              new Error(`${name}: ${describe(error)}`, { cause: error }),
            );
          else late = { error };
        }
      })();
      const stop = async () => {
        running = false;
        await loop;
        const reported = late;
        late = undefined;
        if (reported) throw reported.error;
      };
      steps.push({ name, run: stop });
      return stop;
    },
  };
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const work = body(life);
  let outcome: { error: unknown } | undefined;
  let value: T | undefined;
  try {
    value = await Promise.race([work, aborted]);
  } catch (error) {
    outcome = { error };
  }
  signal.removeEventListener("abort", onAbort);
  // An abandoned body rejects once its resources are gone; that is expected.
  work.catch(() => {});
  closed = true;
  settle(outcome, await attemptAll(steps.reverse(), stepTimeoutMs));
  return value as T;
}

// Runs this Node binary with `args`; a stalled child is killed (SIGKILL, which it cannot
// ignore) at the timeout or as soon as `signal` aborts.
export async function runChild(
  label: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  const pending = exec(process.execPath, args, {
    ...(options.env ? { env: options.env } : {}),
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  });
  const kill = () => void pending.child.kill("SIGKILL");
  if (options.signal?.aborted) kill();
  else options.signal?.addEventListener("abort", kill, { once: true });
  try {
    return (await pending).stdout;
  } catch (error) {
    if (options.signal?.aborted)
      throw new Error(`LIFECYCLE_CHILD_ABORTED: ${label} cancelled`, {
        cause: error,
      });
    if ((error as { killed?: boolean }).killed)
      throw new Error(
        `LIFECYCLE_CHILD_TIMEOUT: ${label} timed out after ${options.timeoutMs} ms`,
        { cause: error },
      );
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", kill);
  }
}

// A shutdown, not a drain: close() alone waits for connections that a request left open, and
// Fastify keeps those for 72 s. Dropping them also ends requests an aborted run left in flight.
export function shutDownServer(server: {
  close(): Promise<unknown>;
  server: { closeAllConnections(): void };
}): Promise<unknown> {
  const closing = server.close();
  server.server.closeAllConnections();
  return closing;
}
