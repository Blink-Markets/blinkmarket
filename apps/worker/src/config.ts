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
