export function apiConfig(env: NodeJS.ProcessEnv) {
  const mode = env.BLINK_API_MODE ?? "scaffold";
  if (
    mode !== "scaffold" &&
    mode !== "identity" &&
    mode !== "preparation" &&
    mode !== "approval"
  )
    throw new Error("INVALID_API_MODE");
  const host = env.API_HOST ?? "127.0.0.1";
  if (
    mode === "approval" &&
    (!env.SPEC_OBJECT_DIRECTORY ||
      !env.SPEC_PUBLIC_ORIGIN ||
      !env.EVIDENCE_OBJECT_DIRECTORY)
  )
    throw new Error("APPROVAL_CONFIGURATION_REQUIRED");
  const port = Number(env.API_PORT ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("INVALID_API_PORT");
  if (
    mode !== "scaffold" &&
    (!env.API_DATABASE_URL || !env.WALLET_BINDING_ORIGIN)
  ) {
    throw new Error("IDENTITY_CONFIGURATION_REQUIRED");
  }
  return {
    mode,
    host,
    port,
    databaseUrl: env.API_DATABASE_URL,
    walletOrigin: env.WALLET_BINDING_ORIGIN,
    specDirectory: env.SPEC_OBJECT_DIRECTORY,
    evidenceDirectory: env.EVIDENCE_OBJECT_DIRECTORY,
    specOrigin: env.SPEC_PUBLIC_ORIGIN,
  };
}
