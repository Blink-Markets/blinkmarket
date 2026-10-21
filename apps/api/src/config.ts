import { isIP } from "node:net";

// Each mode serves, and needs, everything the previous one does.
const modes = [
  "scaffold",
  "identity",
  "preparation",
  "approval",
  "markets",
  "trading",
] as const;
export type ApiMode = (typeof modes)[number];
export const modeAtLeast = (mode: ApiMode, minimum: ApiMode) =>
  modes.indexOf(mode) >= modes.indexOf(minimum);

// Only these proxies may supply X-Forwarded-For: each entry is one address or an address/prefix.
// Wildcards, "true", hostnames and whole-internet ranges are refused so a client cannot pick its own key.
export function parseTrustedProxies(raw: string | undefined): string[] {
  const invalid = () => new Error("INVALID_API_TRUSTED_PROXIES");
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((part) => {
    const entry = part.trim();
    const [address, prefix, ...extra] = entry.split("/");
    const family = isIP(address ?? "");
    if (!family || extra.length) throw invalid();
    if (prefix !== undefined) {
      const bits = Number(prefix);
      if (!/^\d+$/.test(prefix) || bits < 1 || bits > (family === 4 ? 32 : 128))
        throw invalid();
    }
    return entry;
  });
}

export function apiConfig(env: NodeJS.ProcessEnv) {
  const mode = (env.BLINK_API_MODE ?? "scaffold") as ApiMode;
  if (!modes.includes(mode)) throw new Error("INVALID_API_MODE");
  const atLeast = (minimum: ApiMode) => modeAtLeast(mode, minimum);
  const host = env.API_HOST ?? "127.0.0.1";
  if (
    atLeast("approval") &&
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
  if (atLeast("markets") && !env.BLINK_DEPLOYMENT_ID)
    throw new Error("MARKETS_CONFIGURATION_REQUIRED");
  if (
    atLeast("trading") &&
    (!env.SIGNER_URL || !env.SIGNER_CALLER_TOKEN || !env.BASE_SEPOLIA_RPC_URL)
  )
    throw new Error("TRADING_CONFIGURATION_REQUIRED");
  return {
    mode,
    host,
    port,
    databaseUrl: env.API_DATABASE_URL,
    walletOrigin: env.WALLET_BINDING_ORIGIN,
    specDirectory: env.SPEC_OBJECT_DIRECTORY,
    evidenceDirectory: env.EVIDENCE_OBJECT_DIRECTORY,
    specOrigin: env.SPEC_PUBLIC_ORIGIN,
    deploymentId: env.BLINK_DEPLOYMENT_ID,
    signerUrl: env.SIGNER_URL,
    signerToken: env.SIGNER_CALLER_TOKEN,
    rpcUrl: env.BASE_SEPOLIA_RPC_URL,
    trustedProxies: parseTrustedProxies(env.API_TRUSTED_PROXIES),
  };
}
