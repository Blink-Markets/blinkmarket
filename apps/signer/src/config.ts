import { isLoopbackUrl } from "@blink/adapters";
import { signRoles, type SignRole } from "@blink/domain";

export interface SignerCallerConfig {
  name: string;
  tokenSha256: string;
  roles: SignRole[];
}
export interface SignerConfig {
  enabled: boolean;
  host: string;
  port: number;
  databaseUrl: string | null;
  rpcUrl: string | null;
  deploymentId: string | null;
  callers: SignerCallerConfig[];
  keyFiles: Partial<Record<SignRole, string>>;
  l1FeeMode: "oracle" | "local-none";
  rpcTimeoutMs: number;
}

const keyFileVariables = {
  maker: "SIGNER_MAKER_KEY_FILE",
  keeper: "SIGNER_KEEPER_KEY_FILE",
  faucet: "SIGNER_FAUCET_KEY_FILE",
  trader: "SIGNER_TRADER_KEY_FILE",
} as const satisfies Record<SignRole, string>;

function parseCallers(raw: string | undefined): SignerCallerConfig[] {
  const invalid = () => new Error("INVALID_SIGNER_CALLERS");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw invalid();
  const callers = parsed.map((entry): SignerCallerConfig => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Object.keys(entry).sort().join() !== "name,roles,tokenSha256"
    )
      throw invalid();
    const { name, tokenSha256, roles } = entry as Record<string, unknown>;
    if (
      typeof name !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(name) ||
      typeof tokenSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(tokenSha256) ||
      !Array.isArray(roles) ||
      roles.length === 0 ||
      !roles.every((role) =>
        (signRoles as readonly unknown[]).includes(role),
      ) ||
      new Set(roles).size !== roles.length
    )
      throw invalid();
    return { name, tokenSha256, roles: roles as SignRole[] };
  });
  if (
    new Set(callers.map((c) => c.name)).size !== callers.length ||
    new Set(callers.map((c) => c.tokenSha256)).size !== callers.length
  )
    throw invalid();
  return callers;
}

export function signerConfig(env: NodeJS.ProcessEnv): SignerConfig {
  const flag = env.SIGNER_ENABLED;
  if (flag !== undefined && flag !== "true" && flag !== "false")
    throw new Error("INVALID_SIGNER_ENABLED");
  const enabled = flag === "true";
  const port = Number(env.SIGNER_PORT ?? "3004");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("INVALID_SIGNER_PORT");
  const mode = env.SIGNER_L1_FEE_MODE ?? "oracle";
  if (mode !== "oracle" && mode !== "local-none")
    throw new Error("INVALID_SIGNER_L1_FEE_MODE");
  const databaseUrl = env.SIGNER_DATABASE_URL?.trim() || null;
  const rpcUrl = env.BASE_SEPOLIA_RPC_URL?.trim() || null;
  const deploymentId = env.SIGNER_DEPLOYMENT_ID?.trim() || null;
  const keyFiles: Partial<Record<SignRole, string>> = {};
  for (const role of signRoles) {
    const path = env[keyFileVariables[role]]?.trim();
    if (path) keyFiles[role] = path;
  }
  const config: SignerConfig = {
    enabled,
    host: env.SIGNER_HOST?.trim() || "127.0.0.1",
    port,
    databaseUrl,
    rpcUrl,
    deploymentId,
    callers: [],
    keyFiles,
    l1FeeMode: mode,
    rpcTimeoutMs: 5000,
  };
  if (!enabled) return config;
  if (
    !databaseUrl ||
    !rpcUrl ||
    !deploymentId ||
    Object.keys(keyFiles).length === 0
  )
    throw new Error("SIGNER_CONFIGURATION_REQUIRED");
  let parsedRpc: URL;
  try {
    parsedRpc = new URL(rpcUrl);
  } catch {
    throw new Error("INVALID_SIGNER_RPC_URL");
  }
  if (parsedRpc.protocol !== "http:" && parsedRpc.protocol !== "https:")
    throw new Error("INVALID_SIGNER_RPC_URL");
  // Anvil has no Base GasPriceOracle: skipping the L1 fee is allowed only for a loopback node.
  if (mode === "local-none" && !isLoopbackUrl(rpcUrl))
    throw new Error("SIGNER_L1_FEE_NONE_REQUIRES_LOOPBACK_RPC");
  config.callers = parseCallers(env.SIGNER_CALLERS);
  return config;
}
