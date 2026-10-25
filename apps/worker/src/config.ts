import { isAllowedAlertWebhookUrl } from "@blink/adapters";
import {
  DEFAULT_WINDOW_SCHEDULE,
  assertWindowSchedule,
  type WindowSchedule,
} from "@blink/domain";

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
 * alert.evaluate. It runs in every worker, using the database and optional RPC. The RPC probe uses
 * the worker's existing BASE_SEPOLIA_RPC_URL when set; without one the RPC family is not evaluated.
 */
export interface AlertEvaluateConfig {
  rpcUrl: string | null;
  /** BLINK_DEPLOYMENT_ID when set; otherwise every enabled deployment is evaluated. */
  deploymentIds: string[] | null;
  rpcFailures: number;
  reAlertMs: number;
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
  };
}

/**
 * What the forecast jobs need: the deployment whose markets they read (without one they have
 * nothing to do) and the window schedule. The schedule is a platform scheduling setting, not a
 * protocol parameter: a short alpha market needs a PRE_CLOSE window inside a few minutes. It
 * defaults to a one-hour lead and a half-hour window, and an invalid setting stops the worker.
 */
export interface ForecastWorkerConfig {
  deploymentId: string | null;
  schedule: WindowSchedule;
}
export function forecastWorkerConfig(
  env: NodeJS.ProcessEnv,
): ForecastWorkerConfig {
  const seconds = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    if (!/^[0-9]{1,9}$/.test(raw)) throw new Error("INVALID_FORECAST_WINDOW_SCHEDULE");
    return Number(raw);
  };
  const schedule = {
    preCloseLeadSeconds: seconds(
      "FORECAST_PRE_CLOSE_LEAD_SECONDS",
      DEFAULT_WINDOW_SCHEDULE.preCloseLeadSeconds,
    ),
    openSeconds: seconds(
      "FORECAST_WINDOW_OPEN_SECONDS",
      DEFAULT_WINDOW_SCHEDULE.openSeconds,
    ),
  };
  assertWindowSchedule(schedule);
  const deploymentId = env.BLINK_DEPLOYMENT_ID?.trim() || null;
  if (
    deploymentId !== null &&
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(deploymentId)
  )
    throw new Error("INVALID_FORECAST_WORKER_CONFIGURATION");
  return { deploymentId, schedule };
}
