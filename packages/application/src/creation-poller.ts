import type {
  CreationTrackingLease,
  CreationTrackingSchedule,
} from "@blink/ports";

export interface CreationPollerTracker {
  reconcile(
    intentId: string,
    txHash: string,
    lease: CreationTrackingLease,
    signal: AbortSignal,
  ): Promise<{ state: string }>;
}

export interface CreationPollerOptions {
  tracker: CreationPollerTracker;
  schedule: CreationTrackingSchedule;
  workerId: string;
  pollIntervalMs: number;
  leaseMs: number;
  reconciliationDeadlineMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  pendingPollMs: number;
  confirmedPollMs: number;
  revertedPollMs: number;
  onError?: (errorCode: string) => void;
}

export interface CreationPollerHealth {
  enabled: true;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(message)
    ? message
    : "CREATION_POLL_FAILED";
}

function positive(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("INVALID_CREATION_POLLER_" + name.toUpperCase());
}

export function startCreationPoller(options: CreationPollerOptions) {
  for (const name of [
    "pollIntervalMs",
    "leaseMs",
    "reconciliationDeadlineMs",
    "retryBaseMs",
    "retryMaxMs",
    "pendingPollMs",
    "confirmedPollMs",
    "revertedPollMs",
  ] as const)
    positive(name, options[name]);
  if (options.retryMaxMs < options.retryBaseMs)
    throw new Error("INVALID_CREATION_POLLER_RETRY_MAX_MS");
  if (options.leaseMs <= options.reconciliationDeadlineMs + 15_000)
    throw new Error("INVALID_CREATION_POLLER_LEASE_MARGIN");

  let stopping = false;
  let activeAbort: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  let loop: Promise<void>;
  let lastErrorIntentId: string | null = null;
  const state: CreationPollerHealth = {
    enabled: true,
    running: true,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
  };

  const pause = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(() => {
        timer = null;
        wake = null;
        resolve();
      }, options.pollIntervalMs);
    });

  const retryDelay = (attempt: number) =>
    Math.min(
      options.retryMaxMs,
      options.retryBaseMs * 2 ** Math.min(attempt, 30),
    );

  const poll = async (lease: CreationTrackingLease) => {
    const controller = new AbortController();
    activeAbort = controller;
    const deadline = setTimeout(
      () => controller.abort(new Error("CREATION_RECONCILIATION_DEADLINE")),
      options.reconciliationDeadlineMs,
    );
    try {
      const reconciliation = Promise.resolve().then(() =>
        options.tracker.reconcile(
          lease.intentId,
          lease.txHash,
          lease,
          controller.signal,
        ),
      );
      // Attach a rejection handler before racing so an aborting reader cannot leak a rejection.
      void reconciliation.catch(() => undefined);
      let rejectAborted!: (reason: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAborted = reject;
      });
      const onAbort = () => rejectAborted(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      let result: { state: string };
      try {
        result = await Promise.race([reconciliation, aborted]);
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }
      const delay =
        result.state === "CONFIRMED"
          ? options.confirmedPollMs
          : result.state === "REVERTED"
            ? options.revertedPollMs
            : options.pendingPollMs;
      const completed = await options.schedule.complete(lease, delay);
      if (!completed) {
        state.lastErrorCode = "CREATION_POLL_LEASE_LOST";
        state.consecutiveFailures += 1;
        lastErrorIntentId = lease.intentId;
        options.onError?.(state.lastErrorCode);
      } else {
        state.lastSuccessAt = new Date().toISOString();
        if (lastErrorIntentId === lease.intentId) {
          state.lastErrorCode = null;
          state.consecutiveFailures = 0;
          lastErrorIntentId = null;
        }
      }
    } catch (error) {
      const code = controller.signal.aborted
        ? errorCode(controller.signal.reason)
        : errorCode(error);
      state.lastErrorCode = code;
      state.consecutiveFailures += 1;
      lastErrorIntentId = lease.intentId;
      try {
        const failed = await options.schedule.fail(
          lease,
          code,
          retryDelay(lease.attempt),
        );
        if (!failed) {
          state.lastErrorCode = "CREATION_POLL_LEASE_LOST";
          state.consecutiveFailures += 1;
          lastErrorIntentId = lease.intentId;
          options.onError?.(state.lastErrorCode);
        }
      } catch {
        state.lastErrorCode = "CREATION_SCHEDULE_WRITE_FAILED";
        state.consecutiveFailures += 1;
        lastErrorIntentId = lease.intentId;
        options.onError?.(state.lastErrorCode);
      }
      options.onError?.(state.lastErrorCode);
    } finally {
      clearTimeout(deadline);
      if (activeAbort === controller) activeAbort = null;
    }
  };

  loop = (async () => {
    try {
      while (!stopping) {
        state.lastAttemptAt = new Date().toISOString();
        try {
          const lease = await options.schedule.claim(
            options.workerId,
            options.leaseMs,
          );
          // A successful claim read recovers claim-level DB errors. Per-intent
          // errors clear only after that same intent completes successfully.
          if (state.lastErrorCode !== null && lastErrorIntentId === null) {
            state.lastErrorCode = null;
            state.consecutiveFailures = 0;
          }
          if (lease) {
            if (!stopping) await poll(lease);
            else {
              try {
                await options.schedule.fail(
                  lease,
                  "CREATION_POLLER_STOPPING",
                  options.retryBaseMs,
                );
              } catch {
                state.lastErrorCode = "CREATION_SCHEDULE_WRITE_FAILED";
                state.consecutiveFailures += 1;
                options.onError?.(state.lastErrorCode);
              }
            }
          }
        } catch (error) {
          state.lastErrorCode = errorCode(error);
          state.consecutiveFailures += 1;
          lastErrorIntentId = null;
          options.onError?.(state.lastErrorCode);
        }
        if (!stopping) await pause();
      }
    } finally {
      state.running = false;
    }
  })();

  return {
    health: (): CreationPollerHealth => ({ ...state }),
    stop: async () => {
      stopping = true;
      activeAbort?.abort(new Error("CREATION_POLLER_STOPPING"));
      if (timer) clearTimeout(timer);
      timer = null;
      wake?.();
      wake = null;
      await loop;
    },
  };
}
