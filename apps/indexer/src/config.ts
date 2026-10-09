export interface IndexerConfig {
  enabled: boolean;
  port: number;
  host: string;
  databaseUrl: string | null;
  rpcUrl: string | null;
  pollIntervalMs: number;
  leaseMs: number;
  reconciliationDeadlineMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  pendingPollMs: number;
  confirmedPollMs: number;
  revertedPollMs: number;
  rpcTimeoutMs: number;
}

export function creationObservationReady(
  process: { running: boolean },
  backlog: { due: number; failing: number },
) {
  return process.running && backlog.due === 0 && backlog.failing === 0;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error("INVALID_INDEXER_" + key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("INVALID_INDEXER_" + key);
  return value;
}

export function indexerConfig(env: NodeJS.ProcessEnv): IndexerConfig {
  const enabled = env.INDEXER_CREATION_POLLING_ENABLED === "true";
  if (
    env.INDEXER_CREATION_POLLING_ENABLED !== undefined &&
    env.INDEXER_CREATION_POLLING_ENABLED !== "true" &&
    env.INDEXER_CREATION_POLLING_ENABLED !== "false"
  )
    throw new Error("INVALID_INDEXER_CREATION_POLLING_ENABLED");
  const databaseUrl = env.INDEXER_DATABASE_URL?.trim() || null;
  const rpcUrl = env.BASE_SEPOLIA_RPC_URL?.trim() || null;
  if (enabled && (!databaseUrl || !rpcUrl))
    throw new Error("INDEXER_TRACKER_CONFIGURATION_REQUIRED");
  if (rpcUrl) {
    let parsed: URL;
    try {
      parsed = new URL(rpcUrl);
    } catch {
      throw new Error("INVALID_INDEXER_BASE_SEPOLIA_RPC_URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error("INVALID_INDEXER_BASE_SEPOLIA_RPC_URL");
  }
  const config: IndexerConfig = {
    enabled,
    port: integer(env, "INDEXER_PORT", 3003),
    host: env.INDEXER_HOST?.trim() || "127.0.0.1",
    databaseUrl,
    rpcUrl,
    pollIntervalMs: integer(env, "INDEXER_POLL_INTERVAL_MS", 1000),
    leaseMs: integer(env, "INDEXER_LEASE_MS", 90_000),
    reconciliationDeadlineMs: integer(
      env,
      "INDEXER_RECONCILIATION_DEADLINE_MS",
      60_000,
    ),
    retryBaseMs: integer(env, "INDEXER_RETRY_BASE_MS", 5000),
    retryMaxMs: integer(env, "INDEXER_RETRY_MAX_MS", 300_000),
    pendingPollMs: integer(env, "INDEXER_PENDING_POLL_MS", 15_000),
    confirmedPollMs: integer(env, "INDEXER_CONFIRMED_POLL_MS", 300_000),
    revertedPollMs: integer(env, "INDEXER_REVERTED_POLL_MS", 300_000),
    rpcTimeoutMs: integer(env, "INDEXER_RPC_TIMEOUT_MS", 5000),
  };
  if (enabled && config.leaseMs <= config.reconciliationDeadlineMs + 15_000)
    throw new Error("INDEXER_LEASE_MUST_EXCEED_RECONCILIATION_DEADLINE");
  if (config.retryMaxMs < config.retryBaseMs)
    throw new Error("INDEXER_RETRY_MAX_MUST_EXCEED_RETRY_BASE");
  if (config.port > 65_535)
    throw new Error("INVALID_INDEXER_PORT");
  if (
    [
      config.pollIntervalMs,
      config.leaseMs,
      config.reconciliationDeadlineMs,
      config.retryBaseMs,
      config.retryMaxMs,
      config.pendingPollMs,
      config.confirmedPollMs,
      config.revertedPollMs,
      config.rpcTimeoutMs,
    ].some((value) => value > 86_400_000)
  )
    throw new Error("INDEXER_DURATION_TOO_LARGE");
  return config;
}

/** Preserve the poller's cancellation signal while imposing a per-request deadline. */
export function indexerFetchWithTimeout(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const parentSignal = init?.signal;
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("INDEXER_RPC_TIMEOUT")),
      timeoutMs,
    );
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.reason instanceof Error &&
          controller.signal.reason.message === "INDEXER_RPC_TIMEOUT")
        throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}
