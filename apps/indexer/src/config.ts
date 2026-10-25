import { assertNoRoleKeys } from "@blink/runtime";

export interface IndexerConfig {
  txTrackingEnabled: boolean;
  port: number;
  host: string;
  databaseUrl: string | null;
  rpcUrl: string | null;
  rpcTimeoutMs: number;
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
  assertNoRoleKeys(env);
  const txTrackingEnabled = env.INDEXER_TX_TRACKING_ENABLED === "true";
  if (
    env.INDEXER_TX_TRACKING_ENABLED !== undefined &&
    env.INDEXER_TX_TRACKING_ENABLED !== "true" &&
    env.INDEXER_TX_TRACKING_ENABLED !== "false"
  )
    throw new Error("INVALID_INDEXER_TX_TRACKING_ENABLED");
  const databaseUrl = env.INDEXER_DATABASE_URL?.trim() || null;
  const rpcUrl = env.BASE_SEPOLIA_RPC_URL?.trim() || null;
  if (txTrackingEnabled && (!databaseUrl || !rpcUrl))
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
    txTrackingEnabled,
    port: integer(env, "INDEXER_PORT", 3003),
    host: env.INDEXER_HOST?.trim() || "127.0.0.1",
    databaseUrl,
    rpcUrl,
    rpcTimeoutMs: integer(env, "INDEXER_RPC_TIMEOUT_MS", 5000),
  };
  if (config.port > 65_535)
    throw new Error("INVALID_INDEXER_PORT");
  if (config.rpcTimeoutMs > 86_400_000)
    throw new Error("INDEXER_DURATION_TOO_LARGE");
  return config;
}

/** Preserve the caller's cancellation signal while imposing a per-request deadline. */
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

export interface ChainIndexerConfig {
  enabled: boolean;
  databaseUrl: string | null;
  rpcUrl: string | null;
  deploymentId: string | null;
  pollIntervalMs: number;
  rangeSize: number;
}

// The protocol-generation indexer is enabled on its own, independent of transaction tracking.
export function chainIndexerConfig(env: NodeJS.ProcessEnv): ChainIndexerConfig {
  assertNoRoleKeys(env);
  const flag = env.CHAIN_INDEXER_ENABLED;
  if (flag !== undefined && flag !== "true" && flag !== "false")
    throw new Error("INVALID_CHAIN_INDEXER_ENABLED");
  const enabled = flag === "true";
  const databaseUrl = env.INDEXER_DATABASE_URL?.trim() || null;
  const rpcUrl = env.BASE_SEPOLIA_RPC_URL?.trim() || null;
  const deploymentId = env.INDEXER_DEPLOYMENT_ID?.trim() || null;
  if (enabled && (!databaseUrl || !rpcUrl || !deploymentId))
    throw new Error("INDEXER_CHAIN_CONFIGURATION_REQUIRED");
  if (deploymentId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(deploymentId))
    throw new Error("INVALID_INDEXER_DEPLOYMENT_ID");
  const config = {
    enabled,
    databaseUrl,
    rpcUrl,
    deploymentId,
    pollIntervalMs: integer(env, "INDEXER_CHAIN_POLL_MS", 1000),
    rangeSize: integer(env, "INDEXER_CHAIN_RANGE", 500),
  };
  if (config.pollIntervalMs > 86_400_000)
    throw new Error("INDEXER_DURATION_TOO_LARGE");
  // Provider eth_getLogs windows are small; a larger range would fail on a real endpoint.
  if (config.rangeSize > 10_000) throw new Error("INVALID_INDEXER_CHAIN_RANGE");
  return config;
}
