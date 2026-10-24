import { isIP } from "node:net";

// Each mode serves, and needs, everything the previous one does.
const modes = ["scaffold", "identity", "markets"] as const;
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

// The public origin written into content URIs: canonical (no path or trailing slash), https, or
// http only for a loopback host. Anything else would put an unusable or spoofable link in a URI.
export function parseSpecPublicOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("INVALID_SPEC_PUBLIC_ORIGIN");
  }
  if (
    raw !== url.origin ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("INVALID_SPEC_PUBLIC_ORIGIN");
  return url.origin;
}

export function apiConfig(env: NodeJS.ProcessEnv) {
  const mode = (env.BLINK_API_MODE ?? "scaffold") as ApiMode;
  if (!modes.includes(mode)) throw new Error("INVALID_API_MODE");
  const atLeast = (minimum: ApiMode) => modeAtLeast(mode, minimum);
  const host = env.API_HOST ?? "127.0.0.1";
  const port = Number(env.API_PORT ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("INVALID_API_PORT");
  if (
    mode !== "scaffold" &&
    (!env.API_DATABASE_URL || !env.WALLET_BINDING_ORIGIN)
  ) {
    throw new Error("IDENTITY_CONFIGURATION_REQUIRED");
  }
  if (
    atLeast("markets") &&
    (!env.BLINK_DEPLOYMENT_ID ||
      !env.SPEC_OBJECT_DIRECTORY ||
      !env.SPEC_PUBLIC_ORIGIN)
  )
    throw new Error("MARKETS_CONFIGURATION_REQUIRED");
  return {
    mode,
    host,
    port,
    databaseUrl: env.API_DATABASE_URL,
    walletOrigin: env.WALLET_BINDING_ORIGIN,
    specDirectory: env.SPEC_OBJECT_DIRECTORY,
    specPublicOrigin: atLeast("markets")
      ? parseSpecPublicOrigin(env.SPEC_PUBLIC_ORIGIN!)
      : undefined,
    deploymentId: env.BLINK_DEPLOYMENT_ID,
    rpcUrl: env.BASE_SEPOLIA_RPC_URL,
    trustedProxies: parseTrustedProxies(env.API_TRUSTED_PROXIES),
  };
}
