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
  const directory = value("WORKER_EVIDENCE_DIRECTORY");
  const operator = value("WORKER_PLATFORM_OPERATOR_ID");
  if ((directory === null) !== (operator === null))
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
