import { isAllowedAlertWebhookUrl } from "@blink/adapters";
import type { PlatformRole } from "@blink/domain";

export interface WorkerConfig {
  enabled: boolean;
  databaseUrl: string | null;
}

/** The worker is off unless WORKER_ENABLED=true, and then it needs its own database login. */
export function workerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const flag = env.WORKER_ENABLED;
  if (flag !== undefined && flag !== "true" && flag !== "false")
    throw new Error("INVALID_WORKER_ENABLED");
  const enabled = flag === "true";
  const databaseUrl = env.WORKER_DATABASE_URL?.trim() || null;
  if (enabled && !databaseUrl) throw new Error("WORKER_CONFIGURATION_REQUIRED");
  return { enabled, databaseUrl };
}

/**
 * The research jobs. Each feature stays off unless its configuration is present, and a feature
 * that is half configured is refused at startup rather than silently left off.
 */
export interface ResearchConfig {
  /** Where evidence objects live, and the operator that owns fetched evidence. */
  evidence: { directory: string; platformOperatorId: string } | null;
  /** The public API the platform agents call. */
  api: { url: string } | null;
  /** JSON file of canned model answers (`fixtures/replay/models/README.md`). */
  modelFixtures: string | null;
  discovery: { apiKey: string; model: string } | null;
  /** Invited API key per platform role. */
  forecasters: Partial<Record<PlatformRole, string>>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const forecasterKeys = {
  FORECASTER_A: "WORKER_FORECASTER_A_API_KEY",
  FORECASTER_B: "WORKER_FORECASTER_B_API_KEY",
  BASELINE: "WORKER_BASELINE_API_KEY",
} as const satisfies Record<PlatformRole, string>;

export function researchConfig(env: NodeJS.ProcessEnv): ResearchConfig {
  const value = (name: string) => env[name]?.trim() || null;
  // The same archive the API and resolution jobs read; fetching into it also needs the operator.
  const directory = value("EVIDENCE_OBJECT_DIRECTORY");
  const operator = value("WORKER_PLATFORM_OPERATOR_ID");
  if (operator !== null && directory === null)
    throw new Error("WORKER_EVIDENCE_CONFIGURATION_INCOMPLETE");
  if (operator !== null && !uuid.test(operator))
    throw new Error("INVALID_WORKER_PLATFORM_OPERATOR_ID");
  const evidence =
    directory !== null && operator !== null
      ? { directory, platformOperatorId: operator.toLowerCase() }
      : null;
  const url = value("WORKER_API_URL");
  const modelFixtures = value("WORKER_MODEL_FIXTURES");

  const discoveryKey = value("WORKER_DISCOVERY_API_KEY");
  const discoveryModel = value("WORKER_DISCOVERY_MODEL");
  if (
    discoveryKey !== null &&
    (discoveryModel === null || !url || !modelFixtures || !evidence)
  )
    throw new Error("WORKER_DISCOVERY_CONFIGURATION_INCOMPLETE");
  const forecasters: ResearchConfig["forecasters"] = {};
  for (const [role, name] of Object.entries(forecasterKeys)) {
    const key = value(name);
    if (key === null) continue;
    if (!url || !modelFixtures || !evidence)
      throw new Error("WORKER_FORECASTER_CONFIGURATION_INCOMPLETE");
    forecasters[role as PlatformRole] = key;
  }
  // forecast.run serves both forecasters, so a worker holding only one key would lease jobs it
  // can only fail, and the other forecaster's window would be lost to it.
  if (!forecasters.FORECASTER_A !== !forecasters.FORECASTER_B)
    throw new Error("WORKER_FORECASTER_PAIR_INCOMPLETE");
  return {
    evidence,
    api: url ? { url } : null,
    modelFixtures,
    discovery:
      discoveryKey !== null && discoveryModel !== null
        ? { apiKey: discoveryKey, model: discoveryModel }
        : null,
    forecasters,
  };
}

/** http(s) without embedded credentials: the shape every worker service/RPC URL must have. */
function isPlainHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    ["http:", "https:"].includes(parsed.protocol) &&
    !parsed.username &&
    !parsed.password
  );
}

export interface ExecutionConfig {
  deploymentId: string;
  signerUrl: string;
  signerToken: string;
  rpcUrl: string;
}
export function executionConfig(
  env: NodeJS.ProcessEnv,
): ExecutionConfig | null {
  const signerUrl = env.SIGNER_URL?.trim();
  const signerToken = env.WORKER_SIGNER_CALLER_TOKEN?.trim();
  const rpcUrl = env.BASE_SEPOLIA_RPC_URL?.trim();
  // Other worker features may share deployment/RPC settings without enabling execution.
  if (!signerUrl && !signerToken) return null;
  const deploymentId = env.BLINK_DEPLOYMENT_ID?.trim();
  if (!deploymentId || !signerUrl || !signerToken || !rpcUrl)
    throw new Error("WORKER_EXECUTION_CONFIGURATION_INCOMPLETE");
  for (const url of [signerUrl, rpcUrl])
    if (!isPlainHttpUrl(url)) throw new Error("INVALID_WORKER_EXECUTION_URL");
  return { deploymentId, signerUrl, signerToken, rpcUrl };
}

/** The internal trader: its own API key and the platform forecaster whose probability it follows. */
export interface TraderConfig {
  apiKey: string;
  forecasterRole: "FORECASTER_A" | "FORECASTER_B";
}
export function traderConfig(env: NodeJS.ProcessEnv): TraderConfig | null {
  const apiKey = env.WORKER_TRADER_API_KEY?.trim() || null;
  const role = env.WORKER_TRADER_FORECASTER_ROLE?.trim() || null;
  if (apiKey === null && role === null) return null;
  if (apiKey === null || role === null)
    throw new Error("WORKER_TRADER_CONFIGURATION_INCOMPLETE");
  if (role !== "FORECASTER_A" && role !== "FORECASTER_B")
    throw new Error("INVALID_WORKER_TRADER_FORECASTER_ROLE");
  return { apiKey, forecasterRole: role };
}

export type AlertConfig =
  | { sink: "stdout" }
  | { sink: "file"; path: string }
  | { sink: "webhook"; url: string };

export function alertConfig(env: NodeJS.ProcessEnv): AlertConfig {
  const sink = env.ALERT_SINK ?? "stdout";
  const path = env.ALERT_FILE_PATH?.trim();
  const url = env.ALERT_WEBHOOK_URL?.trim();
  if (sink === "stdout" && !path && !url) return { sink };
  if (sink === "file" && path && !url && !path.includes("<TO BE PROVIDED:"))
    return { sink, path };
  if (sink === "webhook" && url && !path && isAllowedAlertWebhookUrl(url))
    return { sink, url };
  throw new Error("INVALID_ALERT_CONFIGURATION");
}

/**
 * alert.evaluate. It runs in every worker, with or without execution/keeper. The RPC probe uses
 * the worker's existing BASE_SEPOLIA_RPC_URL when set; without one the RPC family is not evaluated.
 */
export interface AlertEvaluateConfig {
  rpcUrl: string | null;
  /** BLINK_DEPLOYMENT_ID when set; otherwise every enabled deployment is evaluated. */
  deploymentIds: string[] | null;
  rpcFailures: number;
  reAlertMs: number;
  keeperOverdueSeconds: number;
}
export function alertEvaluateConfig(
  env: NodeJS.ProcessEnv,
): AlertEvaluateConfig {
  const integer = (name: string, fallback: number, max: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!/^[0-9]{1,9}$/.test(raw) || value < 1 || value > max)
      throw new Error("INVALID_ALERT_EVALUATE_CONFIGURATION");
    return value;
  };
  const rpcUrl = env.BASE_SEPOLIA_RPC_URL?.trim() || null;
  if (rpcUrl !== null && !isPlainHttpUrl(rpcUrl))
    throw new Error("INVALID_ALERT_EVALUATE_CONFIGURATION");
  const deploymentId = env.BLINK_DEPLOYMENT_ID?.trim() || null;
  if (
    deploymentId !== null &&
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(deploymentId)
  )
    throw new Error("INVALID_ALERT_EVALUATE_CONFIGURATION");
  return {
    rpcUrl,
    deploymentIds: deploymentId === null ? null : [deploymentId],
    rpcFailures: integer("ALERT_RPC_FAILURES", 3, 100),
    reAlertMs: integer("ALERT_REALERT_MINUTES", 60, 10_080) * 60_000,
    keeperOverdueSeconds: integer("ALERT_KEEPER_OVERDUE_SECONDS", 600, 604_800),
  };
}
